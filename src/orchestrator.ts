import {
	clearStatusLine,
	milestone,
	showPlan,
	startSpinner,
	statusLine,
	stopSpinner,
	toolResultLine,
} from "./display";
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

		const overallStart = Date.now();
		startSpinner();

		for (let i = 0; i < MAX_REACT_ITERATIONS; i++) {
			statusLine(
				i + 1,
				MAX_REACT_ITERATIONS,
				"思考中...",
				(Date.now() - overallStart) / 1000,
			);

			// 注入 plan（像 Skill 一样追加到最新位置，内容不变时不重复注入）
			const planMessages = await this.harness.getPlanMessages();
			for (const pm of planMessages) {
				await saveDialogue("system", `[plan 注入]\n${pm.content}`);
				showPlan(pm.content ?? "");
			}
			messages.push(...planMessages);

			let response: LLMResponse;
			try {
				response = await callLLM(messages, ALL_TOOLS);
			} catch (e: unknown) {
				const err = unwrapError(e);
				// AbortError: LLM 调用超时
				if (e instanceof DOMException && e.name === "AbortError") {
					await saveDialogue(
						"assistant",
						`[错误] LLM 调用超时: ${err.message}`,
					);
					clearStatusLine();
					milestone("LLM 调用超时，2s 后重试");
					await new Promise((r) => setTimeout(r, 2000));
					continue;
				}
				// 配置错误: 不重试，立即退出
				const msg = err.message ?? "";
				if (
					msg.includes("DEEPSEEK_API_KEY") ||
					msg.includes("API key") ||
					msg.includes("API_KEY") ||
					msg.includes("认证失败")
				) {
					stopSpinner();
					clearStatusLine();
					const hint =
						"请设置 DEEPSEEK_API_KEY 环境变量后重试。获取地址: https://platform.deepseek.com";
					await saveDialogue("assistant", `[配置错误] ${hint}`);
					process.stderr.write(`\n❌ 配置错误: ${hint}\n`);
					return `配置错误: ${hint}`;
				}
				// 未知异常
				await saveDialogue(
					"assistant",
					`[错误] LLM 调用异常: ${err.message ?? e}`,
				);
				clearStatusLine();
				milestone("LLM 调用异常，1s 后重试");
				await new Promise((r) => setTimeout(r, 1000));
				continue;
			}

			if (!response.tool_calls || response.tool_calls.length === 0) {
				stopSpinner();
				clearStatusLine();
				statusLine(
					i + 1,
					MAX_REACT_ITERATIONS,
					"完成",
					(Date.now() - overallStart) / 1000,
				);
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
			clearStatusLine();
			statusLine(
				i + 1,
				MAX_REACT_ITERATIONS,
				actions.join(" + "),
				(Date.now() - overallStart) / 1000,
			);

			// 并行执行所有工具调用
			const results = await Promise.all(
				parsed.map(async ({ tc, args }) => {
					const t0 = Date.now();
					const result = await this.harness.executeToolCall(
						tc.function.name,
						args,
					);
					const summary =
						result.length > 60 ? `${result.substring(0, 60)}...` : result;
					toolResultLine(
						tc.function.name,
						true,
						summary,
						Date.now() - t0,
					);
					return result;
				}),
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
				await saveDialogue("tool", `[结果] ${results[ti] ?? ""}`);
			}
		}

		stopSpinner();
		await saveDialogue(
			"assistant",
			"任务未在限定轮次内完成，请尝试简化指令后重试。",
		);
		return "任务未在限定轮次内完成，请尝试简化指令后重试。";
	}
}
