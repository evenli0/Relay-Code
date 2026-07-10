import OpenAI from "openai"
import type { ChatMessage, LLMResponse, ToolDefinition } from "./types"
import type { ChatCompletionTool } from "openai/resources/index.mjs"

const DEEPSEEK_BASE_URL = "https://api.deepseek.com"
const DEFAULT_MODEL = "deepseek-v4-flash"

/** 一次 LLM 调用，支持 tool calling */
export async function callLLM(
  messages: ChatMessage[],
  tools?: ToolDefinition[],
): Promise<LLMResponse> {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY 环境变量未设置")

  const client = new OpenAI({
    apiKey,
    baseURL: process.env.DEEPSEEK_BASE_URL ?? DEEPSEEK_BASE_URL,
  })

  const model = process.env.DEEPSEEK_MODEL ?? DEFAULT_MODEL

  const apiMessages = messages.map(mapMessage)
  const apiTools = tools?.map(mapTool) as ChatCompletionTool[] | undefined

  const res = await client.chat.completions.create({
    model,
    messages: apiMessages,
    tools: apiTools,
    max_tokens: 4096,
  })

  const choice = res.choices[0]?.message
  if (!choice) return { content: "", tool_calls: undefined }

  // DeepSeek 返回的 reasoning_content 需要回传
  const reasoningContent = (choice as any).reasoning_content ?? null

  return {
    content: choice.content ?? null,
    reasoning_content: reasoningContent,
    tool_calls: choice.tool_calls?.map((tc) => ({
      id: tc.id,
      type: "function" as const,
      function: {
        name: tc.function.name,
        arguments: tc.function.arguments,
      },
    })),
  }
}

/** 将内部 ChatMessage 转为 OpenAI SDK 格式 */
function mapMessage(msg: ChatMessage): OpenAI.ChatCompletionMessageParam {
  switch (msg.role) {
    case "system":
      return { role: "system", content: msg.content }
    case "user":
      return { role: "user", content: msg.content }
    case "assistant":
      return {
        role: "assistant",
        content: msg.content,
        reasoning_content: msg.reasoning_content ?? null,
        tool_calls: msg.tool_calls?.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.function.name, arguments: tc.function.arguments },
        })),
      } as OpenAI.ChatCompletionMessageParam
    case "tool":
      return { role: "tool", content: msg.content, tool_call_id: msg.tool_call_id }
  }
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
  } as ChatCompletionTool
}
