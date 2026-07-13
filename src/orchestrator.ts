import { unwrapError } from "./errors";
import { Harness } from "./harness";
import { callLLM } from "./llm";
import { saveDialogue } from "./memory";
import { buildSystemPrompt } from "./prompts";
import { ALL_TOOLS } from "./tools";
import type { ChatMessage, LLMResponse } from "./types";
import { MAX_REACT_ITERATIONS } from "./types";

/**
 * 主 Agent —— ReAct 循环
 *
 * 所有工具调用经过 Harness 层。
 */
export class Orchestrator {
	private harness: Harness;

	constructor(harness?: Harness) {
		this.harness = harness ?? new Harness();
	}

	async runReAct(userInput: string): Promise<string> {
		const messages: ChatMessage[] = [
			{ role: "system", content: buildSystemPrompt() },
			{ role: "user", content: userInput },
		];
		await saveDialogue("system", buildSystemPrompt());
		await saveDialogue("user", userInput);

		for (let i = 0; i < MAX_REACT_ITERATIONS; i++) {
			const stepLabel = `[${i + 1}/${MAX_REACT_ITERATIONS}]`;
			process.stderr.write(`${stepLabel} 思考中...\r`);

			// 注入 plan（像 Skill 一样追加到最新位置，内容不变时不重复注入）
			const planMessages = await this.harness.getPlanMessages();
			for (const pm of planMessages) {
				await saveDialogue("system", `[plan 注入]\n${pm.content}`);
			}
			messages.push(...planMessages);

			let response: LLMResponse;
			try {
				response = await callLLM(messages, ALL_TOOLS);
			} catch (e: unknown) {
				await saveDialogue(
					"assistant",
					`[错误] LLM 调用异常: ${unwrapError(e).message ?? e}`,
				);
				process.stderr.write(`${stepLabel} LLM 调用异常，重试\n`);
				continue;
			}

			if (!response.tool_calls || response.tool_calls.length === 0) {
				process.stderr.write(`${stepLabel} 完成\n`);
				await saveDialogue("assistant", response.content ?? "");
				return response.content ?? "";
			}

			// 解析参数
			const parsed = response.tool_calls.map((tc) => {
				let args: Record<string, unknown> = {};
				try {
					args = JSON.parse(tc.function.arguments);
				} catch {
					args = {};
				}
				return { tc, args };
			});

			// 输出本轮要做什么
			const actions = parsed.map(({ tc, args }) => {
				if (tc.function.name === "dispatch") {
					const prompt = args.prompt as Record<string, unknown> | undefined;
					const task = typeof prompt?.task === "string" ? prompt.task : "";
					return `dispatch: ${task.substring(0, 50)}`;
				}
				return tc.function.name;
			});
			process.stderr.write(`${stepLabel} ${actions.join(" + ")}\n`);

			// 并行执行所有工具调用
			const results = await Promise.all(
				parsed.map(({ tc, args }) =>
					this.harness.executeToolCall(tc.function.name, args),
				),
			);

			// 按顺序放回消息列表，并记录日志
			for (let ti = 0; ti < parsed.length; ti++) {
				const entry = parsed[ti];
				if (!entry) continue;
				const { tc } = entry;
				messages.push({
					role: "assistant",
					content: null,
					tool_calls: [tc],
					reasoning_content: response.reasoning_content ?? null,
				});
				messages.push({
					role: "tool",
					content: results[ti] ?? "",
					tool_call_id: tc.id,
				});
				await saveDialogue(
					"assistant",
					`[工具调用] ${tc.function.name}: ${tc.function.arguments}`,
				);
				await saveDialogue("tool", `[结果] ${results[ti]!}`);
			}
		}

		await saveDialogue(
			"assistant",
			"任务未在限定轮次内完成，请尝试简化指令后重试。",
		);
		return "任务未在限定轮次内完成，请尝试简化指令后重试。";
	}
}
