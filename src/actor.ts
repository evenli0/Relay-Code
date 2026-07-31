/**
 * actor.ts —— 节点进程入口（ServiceEvent/ServiceCommand 协议）
 *
 * 常驻子 Agent 进程。从 stdin 读 JSONL 指令（ServiceCommand），stdout 写 JSONL 事件（ServiceEvent）。
 * 协议见 protocol.ts（framework-design §1）。
 *
 * 用法: bun run src/actor.ts <.relay/tasks/agent-xxx.json>
 *
 * 通道分离（framework-design §10.2 热更新三通道的基础）：
 *   - conversation：ask 专用，持续，保留对话历史
 *   - task 上下文：一次性，跑完不残留，不污染交互记忆
 */

import { existsSync, readFileSync } from "node:fs";
import { SubAgent } from "./dispatcher";
import { callLLM } from "./llm";
import { assembleMessages } from "./message-assembler";
import { decodeServiceCommand, encodeServiceEvent } from "./protocol";
import { ToolExecutor } from "./tool-executor";
import type { ChatMessage, DispatchConfig } from "./types";
import { MAX_REACT_ITERATIONS } from "./types";

// ─── 入口 ───────────────────────────────────────────

const taskPath = process.argv[2];
if (!taskPath) {
	process.stderr.write("用法: bun run src/actor.ts <task-json-path>\n");
	process.exit(1);
}
if (!existsSync(taskPath)) {
	process.stderr.write(`任务文件不存在: ${taskPath}\n`);
	process.exit(1);
}

const initialConfig: DispatchConfig = JSON.parse(
	readFileSync(taskPath, "utf-8"),
);

// ─── 节点状态（进程存活期间一直保留）──────────────────
const executor = new ToolExecutor();

// 服务契约权限（Supervisor 下发）：无声明则不限制（旧路径兼容）
if (initialConfig.permissions) {
	executor.setPermissions(initialConfig.permissions);
}
// 服务 id（批准点确认流按服务隔离，Phase4-B）
if (initialConfig.serviceId) {
	executor.serviceId = initialConfig.serviceId;
}

// 基础消息（系统提示 + 启动时注入的用户上下文）
const baseMessages: ChatMessage[] = (await assembleMessages(initialConfig)).map(
	(m) => {
		if (m.role !== "system") return m;
		// 去掉 JSON 汇报格式指令——节点对话不需要
		return {
			...m,
			content: m.content
				.replace(/\n?全部完成后.*?JSON 作为工作汇报。?/g, "")
				.replace(/\n?汇报格式.*?JSON schema。?/g, "")
				.trim(),
		};
	},
);
let systemPrompt = baseMessages.find((m) => m.role === "system")?.content ?? "";

// 通道分离：交互上下文（ask，持续）与任务上下文（task，一次性）不互相污染
const conversation: ChatMessage[] = baseMessages.filter(
	(m) => m.role !== "system",
);
let tools: string[] = initialConfig.allowed_tools ?? [
	"read",
	"write",
	"grep",
	"bash",
];
let context: Record<string, unknown> = {};

// 通知父进程已就绪
process.stdout.write(
	`${encodeServiceEvent({ kind: "ready", ts: Date.now() })}\n`,
);

// 心跳：Supervisor 据此检测僵死（framework-design §3）
setInterval(() => {
	process.stdout.write(
		`${encodeServiceEvent({ kind: "heartbeat", ts: Date.now() })}\n`,
	);
}, 30_000);

// ─── 事件循环：从 stdin 读 JSONL，永不退出 ─────────
const decoder = new TextDecoder();
let stdinBuf = "";

for await (const chunk of process.stdin) {
	stdinBuf += decoder.decode(chunk, { stream: true });
	const lines = stdinBuf.split("\n");
	stdinBuf = lines.pop() ?? ""; // 最后一段可能不完整

	for (const line of lines) {
		const msg = decodeServiceCommand(line);
		if (!msg) {
			if (line.trim()) {
				process.stderr.write(`[actor] 无效指令: ${line.slice(0, 80)}\n`);
			}
			continue;
		}

		switch (msg.kind) {
			case "task": {
				// 一次性任务上下文：系统提示 + 任务内容，不携带交互历史
				const taskMessages: ChatMessage[] = [
					{ role: "system", content: systemPrompt },
					{ role: "user", content: msg.content },
				];

				const agent = new SubAgent(
					taskMessages,
					tools,
					executor,
					undefined,
					initialConfig.max_rounds ?? MAX_REACT_ITERATIONS,
					initialConfig.max_time_ms,
					(round, _total, action, summary) => {
						// 进度通知 → 主进程
						process.stdout.write(
							`${encodeServiceEvent({ kind: "progress", round, action, summary })}\n`,
						);
					},
				);

				const result = await agent.run();
				process.stdout.write(
					`${encodeServiceEvent({
						kind: "result",
						taskId: msg.taskId,
						status: result.status,
						output: result.output,
					})}\n`,
				);
				break;
			}

			case "ask": {
				// 多轮对话：只进 conversation 通道，LLM 记住之前的对话
				conversation.push({ role: "user", content: msg.content });
				let reply = "";
				try {
					const response = await callLLM(conversation, []);
					reply = response.content ?? "";
				} catch (e) {
					reply = `错误: ${e}`;
				}
				// 写入 conversation，后续 ask 会记住这段对话
				conversation.push({ role: "assistant", content: reply });
				process.stdout.write(
					`${encodeServiceEvent({
						kind: "reply",
						requestId: msg.requestId,
						content: reply,
					})}\n`,
				);
				// 交互摘要（事件通道）→ 主进程 → 主 Agent 决策时可见
				process.stdout.write(
					`${encodeServiceEvent({
						kind: "event",
						type: "interaction.summary",
						level: "info",
						payload: {
							from: msg.from ?? "main",
							question: msg.content.slice(0, 80),
							at: Date.now(),
						},
						ts: Date.now(),
					})}\n`,
				);
				break;
			}

			case "configure": {
				if (msg.tools) tools = msg.tools;
				if (msg.systemPrompt) {
					// 系统提示词热更新（版本化回滚在 Step B 实现）
					systemPrompt = msg.systemPrompt;
				}
				process.stdout.write(
					`${encodeServiceEvent({
						kind: "event",
						type: "configure.ack",
						level: "info",
						payload: {
							version: msg.version ?? null,
							hasSystemPrompt: Boolean(msg.systemPrompt),
						},
						ts: Date.now(),
					})}\n`,
				);
				break;
			}

			case "event": {
				if (msg.type === "context.update" && isRecord(msg.payload)) {
					context = { ...context, ...msg.payload };
				} else {
					process.stderr.write(
						`[actor] 事件（暂只处理 context.update）: ${msg.type}\n`,
					);
				}
				break;
			}

			case "schedule": {
				process.stderr.write(
					`[actor] schedule 指令收到（Step B 实现节奏执行）: ${JSON.stringify(msg.spec)}\n`,
				);
				break;
			}

			case "shutdown": {
				process.exit(0);
				break;
			}
		}
	}
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}
