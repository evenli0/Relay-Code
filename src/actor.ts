/**
 * actor.ts —— Actor 进程入口
 *
 * 永不退出的子 Agent 进程。从 stdin 读 JSONL 指令，stdout 写 JSONL 结果。
 *
 * 用法: bun run src/actor.ts <.relay/tasks/agent-xxx.json>
 *
 * 协议（父→子，stdin，每行一个 JSON）：
 *   { kind: "task";      taskId: string; content: string }
 *   { kind: "ask";       askId: string; from: "human"|"main"; content: string }
 *   { kind: "configure"; tools?: string[]; systemPrompt?: string }
 *   { kind: "context";   context: Record<string, unknown> }
 *   { kind: "shutdown" }
 *
 * 协议（子→父，stdout，每行一个 JSON）：
 *   { kind: "ready" }
 *   { kind: "progress";  round: number; action: string; summary: string }
 *   { kind: "task_done"; taskId: string; output: string; status: "completed"|"error" }
 *   { kind: "task_error"; taskId: string; error: string }
 *   { kind: "ask_reply"; askId: string; content: string }
 *   { kind: "configured" }
 */

import { existsSync, readFileSync } from "node:fs";
import { SubAgent } from "./dispatcher";
import { callLLM } from "./llm";
import { assembleMessages } from "./message-assembler";
import { ToolExecutor } from "./tool-executor";
import type { ChatMessage, DispatchConfig } from "./types";
import { MAX_REACT_ITERATIONS } from "./types";

// ─── 协议类型 ───────────────────────────────────────

export type ActorInput =
	| { kind: "task"; taskId: string; content: string }
	| { kind: "ask"; askId: string; from: "human" | "main"; content: string }
	| { kind: "configure"; tools?: string[]; systemPrompt?: string }
	| { kind: "context"; context: Record<string, unknown> }
	| { kind: "shutdown" };

export type ActorOutput =
	| { kind: "ready" }
	| { kind: "progress"; round: number; action: string; summary: string }
	| {
			kind: "task_done";
			taskId: string;
			output: string;
			status: "completed" | "error";
	  }
	| { kind: "task_error"; taskId: string; error: string }
	| { kind: "ask_reply"; askId: string; content: string }
	| { kind: "configured" };

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

// ─── Actor 状态（进程存活期间一直保留）─────────────
const executor = new ToolExecutor();
const state: {
	messages: ChatMessage[];
	tools: string[];
	context: Record<string, unknown>;
} = {
	messages: await assembleMessages(initialConfig),
	tools: initialConfig.allowed_tools ?? ["read", "write", "grep", "bash"],
	context: {},
};

// 通知父进程已就绪
process.stdout.write(`${JSON.stringify({ kind: "ready" })}\n`);

// ─── 事件循环：从 stdin 读 JSONL，永不退出 ─────────
const rl = process.stdin;

for await (const line of rl) {
	const trimmed = line.trim();
	if (!trimmed) continue;

	let msg: ActorInput;
	try {
		msg = JSON.parse(trimmed) as ActorInput;
	} catch {
		process.stderr.write(`[actor] 无效 JSON: ${trimmed.slice(0, 80)}\n`);
		continue;
	}

	switch (msg.kind) {
		case "task": {
			const taskMessages = [...state.messages];
			taskMessages.push({ role: "user", content: msg.content });

			const agent = new SubAgent(
				taskMessages,
				state.tools,
				executor,
				undefined,
				initialConfig.max_rounds ?? MAX_REACT_ITERATIONS,
				initialConfig.max_time_ms,
				(round, _total, action, summary) => {
					// 进度通知 → 父进程
					process.stdout.write(
						`${JSON.stringify({ kind: "progress", round, action, summary })}\n`,
					);
				},
			);

			const result = await agent.run();
			if (result.status === "completed") {
				process.stdout.write(
					`${JSON.stringify({ kind: "task_done", taskId: msg.taskId, output: result.output, status: "completed" })}\n`,
				);
			} else {
				process.stdout.write(
					`${JSON.stringify({ kind: "task_error", taskId: msg.taskId, error: result.output })}\n`,
				);
			}
			break;
		}

		case "ask": {
			// 轻量问答：单轮 LLM，不走完整 ReAct
			const askMessages = [...state.messages];
			askMessages.push({ role: "user", content: msg.content });
			try {
				const response = await callLLM(askMessages, []);
				const reply = response.content ?? "";
				process.stdout.write(
					`${JSON.stringify({ kind: "ask_reply", askId: msg.askId, content: reply })}\n`,
				);
			} catch (e) {
				process.stdout.write(
					`${JSON.stringify({ kind: "ask_reply", askId: msg.askId, content: `错误: ${e}` })}\n`,
				);
			}
			break;
		}

		case "configure": {
			if (msg.tools) state.tools = msg.tools;
			if (msg.systemPrompt) {
				// 替换或追加 system prompt
				const sysIdx = state.messages.findIndex((m) => m.role === "system");
				if (sysIdx >= 0) {
					state.messages[sysIdx] = {
						role: "system",
						content: msg.systemPrompt,
					};
				} else {
					state.messages.unshift({ role: "system", content: msg.systemPrompt });
				}
			}
			process.stdout.write(`${JSON.stringify({ kind: "configured" })}\n`);
			break;
		}

		case "context": {
			state.context = { ...state.context, ...msg.context };
			break;
		}

		case "shutdown": {
			process.exit(0);
			break;
		}

		default: {
			process.stderr.write(
				`[actor] 未知消息类型: ${(msg as { kind: string }).kind}\n`,
			);
		}
	}
}
