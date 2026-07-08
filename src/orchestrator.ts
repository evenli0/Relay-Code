import type { ChatMessage, Resource } from "./types"
import { MAX_REACT_ITERATIONS, ORCHESTRATOR_ID, ORCHESTRATOR_PERMISSIONS } from "./types"
import { callLLM } from "./llm"
import { ALL_TOOLS } from "./tools"
import { Harness } from "./harness"
import { buildSystemPrompt } from "./prompts"

/**
 * 编排Agent —— 拥有 ReAct 循环的角色
 *
 * 所有工具调用经过 Harness 层。
 * 编排Agent有全部工具权限（ORCHESTRATOR_PERMISSIONS），
 * dispatch 只是工具之一。
 */
export class Orchestrator {
  private harness: Harness

  constructor(harness?: Harness) {
    this.harness = harness ?? new Harness()
    this.harness.registerAgent(ORCHESTRATOR_ID, ORCHESTRATOR_PERMISSIONS)
  }

  async runReAct(
    userInput: string,
    resources: Resource[] = [],
  ): Promise<string> {
    const messages: ChatMessage[] = [
      { role: "system", content: buildSystemPrompt(resources) },
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

        // 经过 Harness 执行（权限检查 + dispatch工厂）
        const result = await this.harness.executeToolCall(
          ORCHESTRATOR_ID,
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
