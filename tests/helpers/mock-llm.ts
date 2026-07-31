/**
 * mock-llm.ts —— 可编排的假 LLM（Phase1 E-1）
 *
 * 通过 llm.setMockTransport() 注入，CI 不依赖真实 API。
 * 用法：
 *   const llm = new ScriptedLLM([text("答案"), toolSequence(...)]);
 *   setMockTransport(llm);
 *
 * 最后一条响应作为兜底（超出预设后重复）；push() 在兜底前插入预设。
 */

import type { LLMTransport } from "../../src/llm";
import type { ChatMessage, LLMResponse, ToolCall } from "../../src/types";

/** 按顺序消费预设响应；超出部分重复最后一条（兜底） */
export class ScriptedLLM implements LLMTransport {
	private responses: LLMResponse[];
	private index = 0;
	public calls = 0;
	/** 每次调用的 messages 参数（供消息结构断言） */
	public callMessages: ChatMessage[][] = [];

	constructor(responses: LLMResponse[]) {
		if (responses.length === 0) {
			throw new Error("ScriptedLLM 需要至少一条预设响应（最后一条作为兜底）");
		}
		this.responses = responses;
	}

	/** 在兜底响应之前插入预设（模拟"排队"） */
	push(...responses: LLMResponse[]): void {
		this.responses.splice(this.responses.length - 1, 0, ...responses);
	}

	async complete(messages: ChatMessage[]): Promise<LLMResponse> {
		this.calls++;
		this.callMessages.push(messages);
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
