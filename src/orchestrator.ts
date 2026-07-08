import type { ChatMessage, Resource } from "./types"
import { MAX_REACT_ITERATIONS } from "./types"
import { callLLM } from "./llm"
import { ORCHESTRATOR_TOOLS, executeTool } from "./tools"
import { buildSystemPrompt } from "./prompts"

/**
 * 编排Agent —— 拥有 ReAct 循环的角色
 *
 * 工作原理：
 *   1. 接收用户指令 + 当前资源清单
 *   2. 进入 ReAct 循环：调LLM(带全部工具) → 执行工具 → 继续调 → 直到返回文本
 *   3. 输出最终答案
 *
 * 编排Agent有全部工具权限。dispatch 只是工具之一。
 * 系统提示中的定价信息和实验结论会引导它的决策，但不限制它的选择。
 */
export class Orchestrator {
  async runReAct(
    userInput: string,
    resources: Resource[] = [],
  ): Promise<string> {
    const messages: ChatMessage[] = [
      { role: "system", content: buildSystemPrompt(resources) },
      { role: "user", content: userInput },
    ]

    for (let i = 0; i < MAX_REACT_ITERATIONS; i++) {
      const response = await callLLM(messages, ORCHESTRATOR_TOOLS)

      // LLM 返回了最终文本 → 退出循环
      if (!response.tool_calls || response.tool_calls.length === 0) {
        return response.content ?? ""
      }

      // LLM 调用了工具 → 逐个执行，结果放回 messages
      for (const toolCall of response.tool_calls) {
        let args: Record<string, unknown> = {}
        try {
          args = JSON.parse(toolCall.function.arguments)
        } catch {
          args = {}
        }

        const result = await executeTool(toolCall.function.name, args)

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
      // 继续下一轮 ReAct 循环
    }

    // 超出最大轮数，返回当前对话摘要
    return "任务未在限定轮次内完成，请尝试简化指令后重试。"
  }
}
