import type { ChatMessage, DispatchConfig, SubAgentResult } from "./types"
import { MAX_REACT_ITERATIONS } from "./types"
import { callLLM } from "./llm"
import { ALL_TOOLS } from "./tools"

const SUB_AGENT_SYSTEM_PROMPT = "你是一个子Agent。完成任务后输出最终结果。"

/**
 * Harness —— dispatch 工厂
 *
 * 职责只有一件：拼装消息 → 创建子Agent → 启动其ReAct循环
 * 没有权限检查，没有过程记录。
 */
export class Harness {
  /**
   * 工具执行
   * dispatch 由 Harness 内部处理，其余工具直接执行。
   */
  async executeToolCall(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    // dispatch 是 Harness 的工厂方法
    if (toolName === "dispatch") {
      const config = args as unknown as DispatchConfig
      if (!config.prompt?.task) return "dispatch 缺少 prompt.task"
      if (!config.plan?.goal || !config.plan?.phases) return "dispatch 缺少 plan（goal 和 phases 必填）。请先规划好子Agent的阶段编排再 dispatch。"
      const result = await this.dispatch(config)
      if (result.structured) {
        return `[dispatch 完成]\n状态: ${result.status}\n结构化结果:\n${JSON.stringify(result.structured, null, 2)}`
      }
      return `[dispatch 完成]\n状态: ${result.status}\n输出: ${result.output}`
    }

    const tool = ALL_TOOLS.find((t) => t.function.name === toolName)
    if (!tool) return `未知工具：${toolName}`
    return await tool.execute(args)
  }

  /**
   * 消息拼装
   * 将 DispatchConfig 转为子Agent的 ChatMessage[]
   */
  async assembleMessages(config: DispatchConfig): Promise<ChatMessage[]> {
    const messages: ChatMessage[] = [
      { role: "system", content: SUB_AGENT_SYSTEM_PROMPT },
    ]

    // 前缀：preload 文件
    for (const filePath of config.preload ?? []) {
      try {
        const file = Bun.file(filePath)
        const content = await file.text()
        messages.push({
          role: "system",
          content: `[上下文文件: ${filePath}]\n${content}`,
        })
      } catch {
        messages.push({
          role: "system",
          content: `[上下文文件: ${filePath}]\n（文件读取失败）`,
        })
      }
    }

    // 后缀：编排Agent的 prompt
    let prompt = ""
    if (config.prompt.role) prompt += `角色：${config.prompt.role}\n`
    prompt += `任务：${config.prompt.task}\n`

    // 如果指定了 responseSchema，要求子Agent按JSON格式返回
    if (config.responseSchema) {
      prompt += `\n最终结果格式要求（严格 JSON，不要包含 markdown 代码块或额外文本，只输出纯 JSON）：\n${JSON.stringify(config.responseSchema, null, 2)}\n`
    }

    // 如果指定了 plan，告诉子Agent完整的阶段编排
    if (config.plan) {
      prompt += `\n[计划上下文]\n`
      if (config.plan.goal) prompt += `总体目标：${config.plan.goal}\n`
      if (config.plan.phases && config.plan.phases.length > 0) {
        prompt += `阶段编排：\n`
        for (const phase of config.plan.phases) {
          prompt += `  → ${phase.name}：${phase.description}\n`
        }
      }
    }

    messages.push({ role: "user", content: prompt })
    return messages
  }

  /**
   * dispatch 工厂
   * 拼装消息 → 创建子Agent → 启动ReAct → 返回完整回执
   */
  async dispatch(config: DispatchConfig): Promise<SubAgentResult> {
    const messages = await this.assembleMessages(config)
    const allowedTools = config.allowed_tools ?? ALL_TOOLS.map((t) => t.function.name)

    const subAgent = new SubAgent(messages, allowedTools, this)
    const result = await subAgent.run()

    // 如果指定了 responseSchema，尝试解析结构化 JSON
    if (config.responseSchema && result.output) {
      try {
        result.structured = JSON.parse(result.output)
      } catch {
        result.structured = null
      }
    }

    return result
  }
}

/**
 * 子Agent —— 一次性的 ReAct 执行器
 *
 * 收到消息后，用自己的ReAct循环完成任务：
 * 调LLM → 调工具 → 继续 → 直到返回文本
 * 不记录过程，不检查权限。
 */
export class SubAgent {
  constructor(
    private messages: ChatMessage[],
    private allowedTools: string[],
    private harness: Harness,
  ) {}

  async run(): Promise<SubAgentResult> {
    const availableTools = ALL_TOOLS.filter((t) =>
      this.allowedTools.includes(t.function.name),
    )

    for (let i = 0; i < MAX_REACT_ITERATIONS; i++) {
      const response = await callLLM(this.messages, availableTools)

      // LLM 返回了最终文本 → 退出
      if (!response.tool_calls || response.tool_calls.length === 0) {
        return {
          status: "completed",
          output: response.content ?? "",
        }
      }

      // 解析参数
      const parsed = response.tool_calls.map((tc) => {
        let args: Record<string, unknown> = {}
        try { args = JSON.parse(tc.function.arguments) } catch { args = {} }
        return { tc, args }
      })

      // 并行执行所有工具调用
      const results = await Promise.all(
        parsed.map(({ tc, args }) =>
          this.harness.executeToolCall(tc.function.name, args),
        ),
      )

      // 按顺序放回消息列表
      parsed.forEach(({ tc }, i) => {
        this.messages.push({ role: "assistant", content: null, tool_calls: [tc], reasoning_content: response.reasoning_content ?? null })
        this.messages.push({ role: "tool", content: results[i]!, tool_call_id: tc.id })
      })
    }

    return {
      status: "error",
      output: "子Agent任务未在限定轮次内完成",
    }
  }
}
