/**
 * mock-llm.ts —— 可编排的假 LLM（Phase1 E-1）
 *
 * 通过 llm.setMockTransport() 注入，CI 不依赖真实 API。
 * 用法：
 *   const llm = new ScriptedLLM([text("答案"), toolSequence(...)]);
 *   setMockTransport(llm);
 */

import type { LLMTransport } from "../../src/llm";
import type { LLMResponse, ToolCall } from "../../src/types";

/** 按顺序消费预设响应；超出部分重复最后一条 */
export class ScriptedLLM implements LLMTransport {
	private responses: LLMResponse[];
	private index = 0;
	public calls = 0;

	constructor(responses: LLMResponse[]) {
		if (responses.length === 0) {
			throw new Error("ScriptedLLM 需要至少一条预设响应");
		}
		this.responses = responses;
	}

	async complete(): Promise<LLMResponse> {
		this.calls++;
		const r = this.responses[Math.min(this.index, this.responses.length - 1)];
		if (this.index < this.responses.length - 1) this.index++;
		return r;
	}
}

/** 纯文本回复（无工具调用） */
export function text(content: string): LLMResponse {
	return { content, tool_calls: undefined };
}

/** 一条工具调用回复 */
export function toolCall(
	name: string,
	args: Record<string, unknown>,
	content: string | null = null,
): LLMResponse {
	const tc: ToolCall = {
		id: `call-${name}`,
		type: "function",
		function: { name, arguments: JSON.stringify(args) },
	};
	return { content, tool_calls: [tc] };
}
