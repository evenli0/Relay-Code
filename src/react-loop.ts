import type { ChatMessage, ToolCall } from "./types";

/** 解析工具调用的参数 JSON */
export function parseToolArgs(tc: ToolCall): { args: Record<string, unknown> } {
	let args: Record<string, unknown> = {};
	try {
		args = JSON.parse(tc.function.arguments);
	} catch {
		args = {};
	}
	return { args };
}

/** 构建 tool_call 的 assistant 消息 */
export function buildAssistantMessage(
	tc: ToolCall,
	reasoningContent: string | null,
): ChatMessage {
	return {
		role: "assistant",
		content: null,
		tool_calls: [tc],
		reasoning_content: reasoningContent,
	};
}

/** 构建 tool 结果消息 */
export function buildToolMessage(
	content: string,
	toolCallId: string,
): ChatMessage {
	return {
		role: "tool",
		content,
		tool_call_id: toolCallId,
	};
}
