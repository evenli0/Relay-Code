import OpenAI from "openai";
import type { ChatCompletionTool } from "openai/resources/index.mjs";
import { unwrapError } from "./errors";
import type { ChatMessage, LLMResponse, ToolDefinition } from "./types";

/** DeepSeek 扩展字段：reasoning_content（思考链） */
interface DeepSeekMessage {
	content: string | null;
	reasoning_content?: string | null;
	tool_calls?: Array<{
		id: string;
		type: "function";
		function: { name: string; arguments: string };
	}>;
}

const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-v4-flash";

/** 一次 LLM 调用，支持 tool calling */
export async function callLLM(
	messages: ChatMessage[],
	tools?: ToolDefinition[],
	options?: { signal?: AbortSignal },
): Promise<LLMResponse> {
	const apiKey = process.env.DEEPSEEK_API_KEY;
	if (!apiKey) throw new Error("DEEPSEEK_API_KEY 环境变量未设置");

	const client = new OpenAI({
		apiKey,
		baseURL: process.env.DEEPSEEK_BASE_URL ?? DEEPSEEK_BASE_URL,
	});

	const model = process.env.DEEPSEEK_MODEL ?? DEFAULT_MODEL;

	const MAX_RETRIES = 3;
	const BASE_DELAY_MS = 1000;

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		try {
			const apiMessages = messages.map(mapMessage);
			const apiTools = tools?.map(mapTool) as ChatCompletionTool[] | undefined;

			const res = await client.chat.completions.create(
				{
					model,
					messages: apiMessages,
					tools: apiTools,
					max_tokens: 4096,
				},
				{ signal: options?.signal },
			);

			const choice = res.choices[0]?.message;
			if (!choice) return { content: "", tool_calls: undefined };

			// DeepSeek 返回的 reasoning_content（思考链）
			const deepseekMsg = choice as unknown as DeepSeekMessage;
			const reasoningContent = deepseekMsg.reasoning_content ?? null;

			return {
				content: choice.content ?? null,
				reasoning_content: reasoningContent,
				tool_calls: choice.tool_calls?.map((tc) => ({
					id: tc.id,
					type: "function" as const,
					function: {
						name: (tc as { function: { name: string; arguments: string } })
							.function.name,
						arguments: (tc as { function: { name: string; arguments: string } })
							.function.arguments,
					},
				})),
			};
		} catch (e: unknown) {
			// AbortError —— 超时透传，不重试
			if (e instanceof DOMException && e.name === "AbortError") throw e;

			const status = unwrapError(e).status ?? 0;
			const code = unwrapError(e).code ?? "";

			// 判断是否可重试
			const isRetryable =
				status === 429 ||
				(status >= 500 && status < 600) ||
				code === "ECONNREFUSED" ||
				code === "ENOTFOUND" ||
				code === "ECONNRESET" ||
				code === "ETIMEDOUT";

			if (isRetryable && attempt < MAX_RETRIES) {
				const delay =
					BASE_DELAY_MS * 2 ** attempt + (Math.random() - 0.5) * 1000;
				process.stderr.write(
					`LLM 调用失败（${status || code}），第 ${attempt + 1}/${MAX_RETRIES + 1} 次尝试，${Math.round(delay)}ms 后重试\n`,
				);
				await sleep(delay);
				continue;
			}

			// 不可重试错误或重试已耗尽 —— 返回错误文本
			if (status === 401 || status === 403)
				return {
					content: `错误：LLM API 认证失败（${status}）`,
					tool_calls: undefined,
				};
			if (status === 429)
				return {
					content: `错误：LLM API 请求过频，请稍后重试`,
					tool_calls: undefined,
				};
			if (status >= 500)
				return {
					content: `错误：LLM API 服务端错误（${status}）`,
					tool_calls: undefined,
				};
			if (
				code === "ECONNREFUSED" ||
				code === "ENOTFOUND" ||
				code === "ERR_CONNECTION_REFUSED" ||
				code === "ECONNRESET" ||
				code === "ETIMEDOUT"
			) {
				return {
					content: `错误：无法连接 LLM API（${code}），请检查网络`,
					tool_calls: undefined,
				};
			}
			return {
				content: `错误：LLM 调用失败 — ${unwrapError(e).message ?? e ?? "未知错误"}`,
				tool_calls: undefined,
			};
		}
	}

	// 所有重试已耗尽
	return {
		content: `错误：LLM 调用失败 — 重试次数已耗尽`,
		tool_calls: undefined,
	};
}

/** 将内部 ChatMessage 转为 OpenAI SDK 格式 */
function mapMessage(msg: ChatMessage): OpenAI.ChatCompletionMessageParam {
	switch (msg.role) {
		case "system":
			return { role: "system", content: msg.content };
		case "user":
			return { role: "user", content: msg.content };
		case "assistant":
			return {
				role: "assistant",
				content: msg.content,
				reasoning_content: msg.reasoning_content ?? null,
				tool_calls: msg.tool_calls?.map((tc) => ({
					id: tc.id,
					type: "function" as const,
					function: {
						name: (tc as { function: { name: string; arguments: string } })
							.function.name,
						arguments: (tc as { function: { name: string; arguments: string } })
							.function.arguments,
					},
				})),
			} as OpenAI.ChatCompletionMessageParam;
		case "tool":
			return {
				role: "tool",
				content: msg.content,
				tool_call_id: msg.tool_call_id,
			};
	}
}

/** 异步延迟 */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 将内部 ToolDefinition 转为 OpenAI SDK 格式 */
function mapTool(tool: ToolDefinition): ChatCompletionTool {
	return {
		type: "function",
		function: {
			name: tool.function.name,
			description: tool.function.description,
			parameters: tool.function.parameters,
		},
	} as ChatCompletionTool;
}
