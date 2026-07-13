import { callLLM } from "./llm";
import { saveDialogue } from "./memory";
import { ALL_TOOLS } from "./tools";
import { createWorktree, getChanges, removeWorktree } from "./worktree";
import { assembleMessages } from "./message-assembler";
import type { ToolExecutor } from "./tool-executor";
import type { ChatMessage, DispatchConfig, LLMResponse, SubAgentResult } from "./types";
import { MAX_REACT_ITERATIONS, LLM_CALL_TIMEOUT_MS } from "./types";

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

	const subAgent = new SubAgent(messages, allowedTools, executor, worktreePath);
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
					result.structured = JSON.parse(match[1]?.trim());
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

/**
 * 子Agent —— 一次性的 ReAct 执行器
 */
export class SubAgent {
	constructor(
		private messages: ChatMessage[],
		private allowedTools: string[],
		private executor: ToolExecutor,
		private cwd?: string,
	) {}

	async run(): Promise<SubAgentResult> {
		const availableTools = ALL_TOOLS.filter((t) =>
			this.allowedTools.includes(t.function.name),
		);

		for (let i = 0; i < MAX_REACT_ITERATIONS; i++) {
			await saveDialogue(
				"system",
				`[子Agent 轮次 ${i + 1}/${MAX_REACT_ITERATIONS}]`,
			);

			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), LLM_CALL_TIMEOUT_MS);
			let response: LLMResponse;
			try {
				response = await callLLM(this.messages, availableTools, {
					signal: controller.signal,
				});
			} catch (e: any) {
				clearTimeout(timeout);
				if (e?.name === "AbortError") {
					await saveDialogue(
						"system",
						`[子Agent 超时] LLM 调用超过 ${LLM_CALL_TIMEOUT_MS}ms`,
					);
					return {
						status: "error",
						output: `子Agent LLM 调用超时（${LLM_CALL_TIMEOUT_MS}ms）`,
					};
				}
				await saveDialogue("system", `[子Agent 错误] ${e?.message ?? e}`);
				return {
					status: "error",
					output: `子Agent 执行出错: ${e?.message ?? e}`,
				};
			}
			clearTimeout(timeout);

			if (!response.tool_calls || response.tool_calls.length === 0) {
				await saveDialogue(
					"assistant",
					`[子Agent 完成] ${response.content ?? ""}`,
				);
				return {
					status: "completed",
					output: response.content ?? "",
				};
			}

			const parsed = response.tool_calls.map((tc) => {
				let args: Record<string, unknown> = {};
				try {
					args = JSON.parse(tc.function.arguments);
				} catch {
					args = {};
				}
				return { tc, args };
			});

			const results = await Promise.all(
				parsed.map(({ tc, args }) =>
					this.executor.executeToolCall(tc.function.name, args, this.cwd),
				),
			);

			for (let ti = 0; ti < parsed.length; ti++) {
				const { tc } = parsed[ti]!;
				this.messages.push({
					role: "assistant",
					content: null,
					tool_calls: [tc],
					reasoning_content: response.reasoning_content ?? null,
				});
				this.messages.push({
					role: "tool",
					content: results[ti]!,
					tool_call_id: tc.id,
				});
				await saveDialogue(
					"assistant",
					`[子Agent 工具] ${tc.function.name}: ${tc.function.arguments}`,
				);
				await saveDialogue("tool", `[子Agent 结果] ${results[ti]!}`);
			}
		}

		await saveDialogue("system", "[子Agent 超时]");
		return {
			status: "error",
			output: "子Agent任务未在限定轮次内完成",
		};
	}
}
