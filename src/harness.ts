import type { ChatMessage, DispatchConfig, SubAgentResult, ProcessStep, AgentId } from "./types"
import { MAX_REACT_ITERATIONS } from "./types"
import { callLLM } from "./llm"
import { ALL_TOOLS } from "./tools"

const SUB_AGENT_SYSTEM_PROMPT = "你是一个子Agent。完成任务后输出最终结果。"

/**
 * Harness —— 所有 Agent 公用的基础设施
 *
 * 两个职责：
 *   1. 工具执行网关：检查权限后执行真正的工具
 *   2. dispatch 工厂：拼装消息 → 创建子Agent → 启动其ReAct循环
 *
 * 编排Agent和子Agent共用同一份 Harness，但各有一套权限配置。
 */
export class Harness {
  private permissions = new Map<AgentId, string[]>()

  /** 注册或更新一个Agent的权限 */
  registerAgent(agentId: AgentId, allowedTools: string[]): void {
    this.permissions.set(agentId, allowedTools)
  }

  /** 获取Agent的权限列表 */
  getAgentPermissions(agentId: AgentId): string[] {
    return this.permissions.get(agentId) ?? []
  }

  /**
   * 工具执行网关
   * 所有Agent（编排Agent + 子Agent）的工具调用都经过这里。
   * dispatch 由 Harness 内部处理（不是调工具定义的 execute）。
   */
  async executeToolCall(
    agentId: AgentId,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const allowed = this.permissions.get(agentId)
    if (!allowed || !allowed.includes(toolName)) {
      return `无权使用 ${toolName} 工具（当前授权：${(allowed ?? []).join(", ") || "无"}）`
    }

    // dispatch 是 Harness 的工厂方法，不走普通工具执行
    if (toolName === "dispatch") {
      const config = args as unknown as DispatchConfig
      if (!config.prompt?.task) return "dispatch 缺少 prompt.task"
      const result = await this.dispatch(config)
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

    // 前缀：preload 文件（固定→缓存命中）
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
    if (config.prompt.constraints && config.prompt.constraints.length > 0) {
      prompt += "约束：\n" + config.prompt.constraints.map((c) => `  - ${c}`).join("\n") + "\n"
    }
    prompt += `任务：${config.prompt.task}\n`
    if (config.prompt.anything_else) {
      prompt += `补充：${config.prompt.anything_else}\n`
    }

    messages.push({ role: "user", content: prompt })
    return messages
  }

  /**
   * dispatch 工厂
   * 拼装消息 → 注册权限 → 创建子Agent → 启动ReAct → 返回完整回执
   */
  async dispatch(config: DispatchConfig): Promise<SubAgentResult> {
    const messages = await this.assembleMessages(config)
    const agentId = `sub-${crypto.randomUUID()}`
    const allowedTools = config.allowed_tools ?? ALL_TOOLS.map((t) => t.function.name)
    this.registerAgent(agentId, allowedTools)

    const subAgent = new SubAgent(messages, agentId, allowedTools, this)
    return await subAgent.run()
  }
}

/**
 * 子Agent —— 一次性的 ReAct 执行器
 *
 * 收到消息后，用自己的ReAct循环完成任务：
 *   调LLM → 调工具（经Harness权限检查）→ 继续 → 直到返回文本
 *   每一步都记录到 process 中
 */
export class SubAgent {
  private processSteps: ProcessStep[] = []

  constructor(
    private messages: ChatMessage[],
    private agentId: AgentId,
    private allowedTools: string[],
    private harness: Harness,
  ) {}

  async run(): Promise<SubAgentResult> {
    // 只暴露 allowed_tools 范围内的工具给LLM
    const availableTools = ALL_TOOLS.filter((t) =>
      this.allowedTools.includes(t.function.name),
    )

    for (let i = 0; i < MAX_REACT_ITERATIONS; i++) {
      const response = await callLLM(this.messages, availableTools)

      // LLM 返回了最终文本 → 退出
      if (!response.tool_calls || response.tool_calls.length === 0) {
        this.processSteps.push({
          step: i,
          type: "final",
          content: response.content ?? "",
        })
        return {
          status: "completed",
          output: response.content ?? "",
          process: this.processSteps,
        }
      }

      // 执行每个工具调用
      for (const toolCall of response.tool_calls) {
        let args: Record<string, unknown> = {}
        try {
          args = JSON.parse(toolCall.function.arguments)
        } catch {
          args = {}
        }

        this.processSteps.push({
          step: i,
          type: "tool_call",
          content: toolCall.function.name,
          tool_name: toolCall.function.name,
          tool_args: toolCall.function.arguments,
        })

        const result = await this.harness.executeToolCall(
          this.agentId,
          toolCall.function.name,
          args,
        )

        this.processSteps.push({
          step: i,
          type: "tool_result",
          content: result.substring(0, 500),
        })

        this.messages.push({
          role: "assistant",
          content: null,
          tool_calls: [toolCall],
        })
        this.messages.push({
          role: "tool",
          content: result,
          tool_call_id: toolCall.id,
        })
      }
    }

    // 超出最大轮数
    return {
      status: "error",
      output: "子Agent任务未在限定轮次内完成",
      process: this.processSteps,
    }
  }
}
