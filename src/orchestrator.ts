import type { ChatMessage } from "./types"
import { MAX_REACT_ITERATIONS } from "./types"
import { callLLM } from "./llm"
import { ALL_TOOLS } from "./tools"
import { Harness } from "./harness"
import { buildSystemPrompt } from "./prompts"

/**
 * 主 Agent —— ReAct 循环
 *
 * 所有工具调用经过 Harness 层。
 */
export class Orchestrator {
  private harness: Harness

  constructor(harness?: Harness) {
    this.harness = harness ?? new Harness()
  }

  async runReAct(userInput: string): Promise<string> {
    const messages: ChatMessage[] = [
      { role: "system", content: buildSystemPrompt() },
      { role: "user", content: userInput },
    ]

    for (let i = 0; i < MAX_REACT_ITERATIONS; i++) {
      const response = await callLLM(messages, ALL_TOOLS)

      if (!response.tool_calls || response.tool_calls.length === 0) {
        return response.content ?? ""
      }

      for (const toolCall of response.tool_calls) {
        let args: Record<string, unknown> = {}
        try {
          args = JSON.parse(toolCall.function.arguments)
        } catch {
          args = {}
        }

        const result = await this.harness.executeToolCall(
          toolCall.function.name,
          args,
        )

        messages.push({
          role: "assistant",
          content: null,
          tool_calls: [toolCall],
        })
        messages.push({
          role: "tool",
          content: result,
          tool_call_id: toolCall.id,
        })
      }
    }

    return "任务未在限定轮次内完成，请尝试简化指令后重试。"
  }
}
