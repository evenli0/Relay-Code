import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { ActorHandle } from "./actor-handle";
import type { AgentRegistry } from "./agent-registry";
import { elapsed, subAgentEnd, subAgentStart, toolResultLine } from "./display";
import { unwrapError } from "./errors";
import type { Inbox } from "./inbox";
import { callLLM } from "./llm";
import { saveDialogue } from "./memory";
import { assembleMessages } from "./message-assembler";
import type { Sink } from "./sink";
import type { ToolExecutor } from "./tool-executor";
import { ALL_TOOLS } from "./tools";
import type {
	ChatMessage,
	DispatchConfig,
	LLMResponse,
	SubAgentResult,
} from "./types";
import { LLM_CALL_TIMEOUT_MS, MAX_REACT_ITERATIONS } from "./types";
import { createWorktree, getChanges, removeWorktree } from "./worktree";

/**
 * dispatch 入口：创建 worktree（按需）→ 拼装消息 → 创建 SubAgent → 执行 → 返回
 */
export async function dispatch(
	config: DispatchConfig,
	executor: ToolExecutor,
): Promise<SubAgentResult> {
	// worktree 隔离
	let worktreePath: string | undefined;
	if (config.isolation === "worktree") {
		const slug = `dispatch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
		try {
			worktreePath = await createWorktree(slug);
		} catch (e) {
			return { status: "error", output: `创建 worktree 失败: ${e}` };
		}
	}

	const messages = await assembleMessages(config);
	const allowedTools =
		config.allowed_tools ?? ALL_TOOLS.map((t) => t.function.name);

	const subAgent = new SubAgent(
		messages,
		allowedTools,
		executor,
		worktreePath,
		config.max_rounds,
		config.max_time_ms,
	);
	const result = await subAgent.run();

	// worktree 变更检测
	if (worktreePath) {
		const changes = await getChanges(worktreePath);
		if (changes.length > 0) {
			result.output += `\n[worktree 变更] 路径: ${worktreePath}\n修改了 ${changes.length} 个文件: ${changes.join(", ")}`;
		} else {
			await removeWorktree(worktreePath);
		}
	}

	// 如果指定了 responseSchema，尝试解析结构化 JSON
	if (config.responseSchema && result.output) {
		try {
			result.structured = JSON.parse(result.output);
		} catch {
			try {
				const match = result.output.match(/```(?:json)?\s*([\s\S]*?)```/);
				if (match) {
					result.structured = JSON.parse(match[1]?.trim() ?? "");
				} else {
					result.structured = null;
				}
			} catch {
				result.structured = null;
			}
		}
	}

	return result;
}

/** 任务文件目录 */
const TASKS_DIR = ".relay/tasks";

/**
 * dispatchAsync — 异步火发模式
 *
 * 将任务配置写入文件 → 启动独立子 Agent 进程 → 立即返回。
 * 子 Agent 完成后自动推入收件箱。
 */
export async function dispatchAsync(
	config: DispatchConfig,
	inbox: Inbox,
	registry: AgentRegistry,
	threadId: string,
	sink?: Sink,
	mode: "oneshot" | "actor" = "oneshot",
): Promise<{ status: string; agentId: string }> {
	const agentId = `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
	const role = config.phase ?? config.prompt.role ?? "子任务";

	// ── Actor 路径 ────────────────────────────────────
	if (mode === "actor") {
		const handle = new ActorHandle(agentId, config);
		registry.registerActor(agentId, role, threadId, handle);

		// Actor 已从 config 加载 system prompt + user message
		// 不自动跑 ReAct — 进入 talk 后直接对话

		// 协议事件 → registry/inbox（sink 展示由 UI 适配层映射，见 server.ts）
		handle.onEvent = (msg) => {
			if (msg.kind === "progress") {
				registry.updateProgress(agentId, msg.round, msg.action, msg.summary);
				if (sink)
					sink.emit({
						kind: "agent_progress",
						agentId,
						round: msg.round,
						action: msg.action,
					});
			}
			if (msg.kind === "result") {
				if (msg.status === "completed") {
					registry.markDone(agentId, msg.output.slice(0, 200));
					if (sink)
						sink.emit({
							kind: "agent_done",
							agentId,
							role,
							output: msg.output,
						});
					inbox.push({
						type: "agent_done",
						threadId,
						timestamp: Date.now(),
						result: { status: "completed", output: msg.output },
						agentRole: role,
						agentId,
						level: "info",
						eventType: "agent.done",
					});
				} else {
					registry.markError(agentId, msg.output);
					if (sink)
						sink.emit({
							kind: "agent_error",
							agentId,
							role,
							error: msg.output,
						});
					inbox.push({
						type: "agent_error",
						threadId,
						timestamp: Date.now(),
						error: msg.output,
						agentRole: role,
						agentId,
						level: "notify",
						eventType: "agent.error",
					});
				}
			}
			if (msg.kind === "event" && msg.type === "interaction.summary") {
				const payload = msg.payload as {
					from: string;
					question: string;
					at: number;
				};
				registry.recordInteraction(agentId, {
					from: payload.from,
					question: payload.question,
					at: payload.at,
				});
			}
		};

		if (sink)
			sink.emit({
				kind: "agent_dispatched",
				agentId,
				role,
				task: config.prompt.task,
			});
		return { status: "actor_started", agentId };
	}

	// ── Oneshot 路径（现有逻辑，不变）────────────────────
	registry.register(agentId, role, threadId);

	if (!existsSync(TASKS_DIR)) {
		mkdirSync(TASKS_DIR, { recursive: true });
	}

	const taskPath = `${TASKS_DIR}/${agentId}.json`;
	writeFileSync(taskPath, JSON.stringify(config, null, 2), "utf-8");

	const proc = Bun.spawn(["bun", "run", "src/subagent-cli.ts", taskPath], {
		onExit: (_proc, exitCode) => {
			const resultPath = taskPath.replace(/\.json$/, ".result.json");
			try {
				if (existsSync(resultPath)) {
					const result: SubAgentResult = JSON.parse(
						readFileSync(resultPath, "utf-8"),
					);
					if (exitCode === 0 && result.status === "completed") {
						registry.markDone(agentId, result.output?.slice(0, 200) ?? "完成");
						if (sink)
							sink.emit({
								kind: "agent_done",
								agentId,
								role,
								output: result.output ?? "",
							});
						inbox.push({
							type: "agent_done",
							threadId,
							timestamp: Date.now(),
							result,
							agentRole: role,
							agentId,
							level: "info",
							eventType: "agent.done",
						});
					} else {
						const err = result.output ?? `exit ${exitCode}`;
						registry.markError(agentId, err);
						if (sink)
							sink.emit({ kind: "agent_error", agentId, role, error: err });
						inbox.push({
							type: "agent_error",
							threadId,
							timestamp: Date.now(),
							error: err,
							agentRole: role,
							agentId,
							level: "notify",
							eventType: "agent.error",
						});
					}
				} else {
					registry.markError(agentId, `exit ${exitCode}，无结果`);
					inbox.push({
						type: "agent_error",
						threadId,
						timestamp: Date.now(),
						error: `进程退出 (exit ${exitCode})`,
						agentRole: role,
						agentId,
					});
				}
			} catch (e) {
				registry.markError(agentId, String(e));
				inbox.push({
					type: "agent_error",
					threadId,
					timestamp: Date.now(),
					error: `读取结果失败: ${e}`,
					agentRole: role,
					agentId,
				});
			}
		},
	});
	proc.unref();

	return { status: "dispatched", agentId };
}

/**
 * 子Agent —— 一次性的 ReAct 执行器
 */
export class SubAgent {
	constructor(
		private messages: ChatMessage[],
		private allowedTools: string[],
		private executor: ToolExecutor,
		private cwd?: string,
		private maxRounds?: number,
		private maxTimeMs?: number,
		private onProgress?: (
			round: number,
			total: number,
			action: string,
			summary: string,
		) => void,
	) {}

	async run(): Promise<SubAgentResult> {
		const subStart = Date.now();

		// 从消息中提取任务描述
		const userMsg = this.messages.find((m) => m.role === "user");
		const taskLabel =
			typeof userMsg?.content === "string"
				? userMsg.content.substring(0, 80)
				: "子Agent任务";
		subAgentStart(0, taskLabel);

		let _llmCalls = 0;
		let _toolsUsed = 0;
		const availableTools = ALL_TOOLS.filter((t) =>
			this.allowedTools.includes(t.function.name),
		);

		const iterLimit = this.maxRounds ?? 30;
		let emptyResultRounds = 0;
		let currentMaxTokens = 16000;

		for (let i = 0; i < Math.min(iterLimit, MAX_REACT_ITERATIONS); i++) {
			this.onProgress?.(
				i + 1,
				Math.min(iterLimit, MAX_REACT_ITERATIONS),
				"思考中",
				"等待 LLM 回复...",
			);
			await saveDialogue(
				"system",
				`[子Agent 轮次 ${i + 1}/${MAX_REACT_ITERATIONS}]`,
			);

			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), LLM_CALL_TIMEOUT_MS);
			let response: LLMResponse;
			try {
				if (this.maxTimeMs && Date.now() - subStart > this.maxTimeMs) {
					const elapsedSec = parseFloat(elapsed(subStart));
					subAgentEnd(0, i + 1, elapsedSec, false);
					return {
						status: "error",
						output: `子Agent 总执行时间超过 ${this.maxTimeMs}ms 限制`,
					};
				}
				_llmCalls++;
				response = await callLLM(this.messages, availableTools, {
					signal: controller.signal,
					maxTokens: currentMaxTokens,
				});
			} catch (e: unknown) {
				clearTimeout(timeout);
				const elapsedSec = parseFloat(elapsed(subStart));
				if (e instanceof DOMException && e.name === "AbortError") {
					await saveDialogue(
						"system",
						`[子Agent 超时] LLM 调用超过 ${LLM_CALL_TIMEOUT_MS}ms`,
					);
					subAgentEnd(0, i + 1, elapsedSec, false);
					return {
						status: "error",
						output: `子Agent LLM 调用超时（${LLM_CALL_TIMEOUT_MS}ms）`,
					};
				}
				await saveDialogue(
					"system",
					`[子Agent 错误] ${unwrapError(e).message ?? e}`,
				);
				subAgentEnd(0, i + 1, elapsedSec, false);
				return {
					status: "error",
					output: `子Agent 执行出错: ${unwrapError(e).message ?? e}`,
				};
			}
			clearTimeout(timeout);

			if (!response.tool_calls || response.tool_calls.length === 0) {
				await saveDialogue(
					"assistant",
					`[子Agent 完成] ${response.content ?? ""}`,
				);
				subAgentEnd(0, i + 1, parseFloat(elapsed(subStart)), true);
				return {
					status: "completed",
					output: response.content ?? "",
				};
			}

			const parsed = response.tool_calls.map((tc) => {
				let args: Record<string, unknown> = {};
				let parseOk = true;
				try {
					args = JSON.parse(tc.function.arguments);
				} catch (e) {
					parseOk = false;
					args = {};
					process.stderr.write(
						`[诊断|JSON解析失败] ${tc.function.name}: ${String(e).slice(0, 200)}\n`,
					);
					process.stderr.write(
						`[诊断|原始参数前200字符] ${tc.function.arguments.slice(0, 200)}\n`,
					);
				}
				// 诊断日志：捕获所有 tool call 原始参数（截断避免刷屏）
				const rawArgs = tc.function.arguments;
				const preview =
					rawArgs.length > 300 ? `${rawArgs.slice(0, 300)}...(截断)` : rawArgs;
				process.stderr.write(
					`[诊断|${tc.function.name}] ${parseOk ? "" : "(解析失败) "}${preview}\n`,
				);
				return { tc, args, parseOk };
			});

			// 截断检测：如果 JSON 解析失败，翻倍 token 重试
			const truncated = parsed.some((p) => !p.parseOk);
			if (truncated && currentMaxTokens < 64000) {
				currentMaxTokens *= 2;
				process.stderr.write(
					`[诊断|截断重试] maxTokens 翻倍至 ${currentMaxTokens}\n`,
				);
				continue; // 不把损坏的响应加入对话历史，直接重试
			}

			_toolsUsed += parsed.length;
			const results = await Promise.all(
				parsed.map(async ({ tc, args }) => {
					const t0 = Date.now();
					const result = await this.executor.executeToolCall(
						tc.function.name,
						args,
						this.cwd,
					);
					const summary =
						result.length > 60 ? `${result.substring(0, 60)}...` : result;
					toolResultLine(tc.function.name, true, summary, Date.now() - t0);
					return result;
				}),
			);

			// 进度通知
			const actions = parsed.map(({ tc }) => tc.function.name).join("+");
			const s = results
				.map((r) => (r?.length > 50 ? `${r.slice(0, 50)}...` : (r ?? "")))
				.join(" | ")
				.slice(0, 80);
			this.onProgress?.(
				i + 1,
				Math.min(iterLimit, MAX_REACT_ITERATIONS),
				actions,
				s || "无输出",
			);

			// 空结果检测：全部为空时计数
			const allEmpty = results.every((r) => !r || r.trim().length === 0);
			if (
				allEmpty &&
				(!response.content || response.content.trim().length === 0)
			) {
				emptyResultRounds++;
				if (emptyResultRounds >= 2) {
					subAgentEnd(0, i + 1, parseFloat(elapsed(subStart)), false);
					return {
						status: "error",
						output: "子Agent 连续 2 轮返回空结果，提前终止",
					};
				}
			} else {
				emptyResultRounds = 0;
			}

			for (let ti = 0; ti < parsed.length; ti++) {
				const entry = parsed[ti];
				if (!entry) continue;
				const { tc } = entry;
				this.messages.push({
					role: "assistant",
					content: null,
					tool_calls: [tc],
					reasoning_content: response.reasoning_content ?? null,
				});
				this.messages.push({
					role: "tool",
					content: results[ti] ?? "",
					tool_call_id: tc.id,
				});
				await saveDialogue(
					"assistant",
					`[子Agent 工具] ${tc.function.name}: ${tc.function.arguments}`,
				);
				await saveDialogue("tool", `[子Agent 结果] ${results[ti] ?? ""}`);
			}
		}

		const elapsedSec = parseFloat(elapsed(subStart));
		subAgentEnd(0, MAX_REACT_ITERATIONS, elapsedSec, false);
		await saveDialogue("system", "[子Agent 超时]");
		return {
			status: "error",
			output: "子Agent任务未在限定轮次内完成",
		};
	}
}
