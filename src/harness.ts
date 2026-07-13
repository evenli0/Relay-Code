import path from "path"
import type { ChatMessage, DispatchConfig, LLMResponse, SubAgentResult } from "./types"
import { isDispatchConfig } from "./types"
import { MAX_REACT_ITERATIONS, LLM_CALL_TIMEOUT_MS } from "./types"
import { callLLM } from "./llm"
import { ALL_TOOLS } from "./tools"
import { saveDialogue } from "./memory"
import { createWorktree, removeWorktree, getChanges } from "./worktree"

const SUB_AGENT_SYSTEM_PROMPT = "你是一个子Agent。输出是返回值，不是对话。不要道歉，不要问用户。"

/**
 * Harness —— dispatch 工厂
 *
 * 职责只有一件：拼装消息 → 创建子Agent → 启动其ReAct循环
 * 没有权限检查，没有过程记录。
 */
export class Harness {
  /** 已注入过的 plan 内容，避免重复注入 */
  private injectedPlans: Set<string> = new Set()

  /**
   * 获取 plan 注入消息（像 Skill 一样）
   * 如果 plan.md 存在且未完成，返回 user 消息包含当前计划 + 执行规则
   * 如果 plan 内容已注入过，返回空数组（缓存前缀不受影响）
   */
  async getPlanMessages(): Promise<ChatMessage[]> {
    // 先看根目录 plan.md（向后兼容），再看 plans/current.md（蓝图实例）
    let planFile = Bun.file("plan.md")
    if (!(await planFile.exists())) {
      planFile = Bun.file("plans/current.md")
      if (!(await planFile.exists())) return []
    }

    const content = await planFile.text()
    if (!content.trim() || content.includes("status: completed")) return []

    const rules = [
      "执行规则：",
      "- 按阶段顺序执行，完成一个阶段后 write 更新 plan.md 状态",
      "- dispatch 给子Agent 的任务描述必须准确，不要编造代码细节（函数签名、文件路径等）",
      "- 子Agent 返回后检查其 keyFindings，判断是否合理。合理就继续，不合理就修正 plan 重试",
      "- dispatch 的 prompt 必须是 { task: \"...\" } 对象，不是字符串",
      "- 遇到障碍（文件不存在、任务失败），修改后续阶段调整路线",
      "- 同一阶段内多个 dispatch 可以在同一轮发出",
      "- 修改 plan 后用 write 保存，系统下次自动采用新版本",
    ].join("\n")

    const fullContent = `[当前计划]\n${content}\n\n${rules}`

    const key = fullContent.trim()
    if (this.injectedPlans.has(key)) return [] // 已注入过此版本

    this.injectedPlans.add(key)
    return [{ role: "user" as const, content: fullContent }]
  }

  /**
   * 工具执行
   * dispatch 由 Harness 内部处理，其余工具直接执行。
   */
  async executeToolCall(
    toolName: string,
    args: Record<string, unknown>,
    cwd?: string,
  ): Promise<string> {
    // dispatch 透传——子 Agent 自己决定是否隔离
    if (toolName === "dispatch") {
      if (!isDispatchConfig(args)) return "dispatch 参数无效：缺少 prompt.task（字符串）"
      const config: DispatchConfig = args
      if (!config.responseSchema) return "dispatch 缺少 responseSchema（子Agent的JSON输出结构）。请在 responseSchema 中定义子Agent的返回格式。"

      // plan.md 是编排的必备文件，不存在时引导先写计划
      const planFile = Bun.file("plan.md")
      if (!(await planFile.exists())) {
        return "dispatch 需要 plan.md 或 plans/current.md 才能执行。请先用 write 写下计划，再 dispatch。"
      }

      const result = await this.dispatch(config)
      if (result.structured) {
        return `[dispatch 完成]\n状态: ${result.status}\n结构化结果:\n${JSON.stringify(result.structured, null, 2)}`
      }
      return `[dispatch 完成]\n状态: ${result.status}\n输出: ${result.output}`
    }

    // 路径解析：worktree 隔离下，相对路径 → worktree 内的绝对路径
    let resolvedArgs = args
    if (cwd) {
      resolvedArgs = this.resolveCwdArgs(toolName, args, cwd)
    }

    const tool = ALL_TOOLS.find((t) => t.function.name === toolName)
    if (!tool) return `未知工具：${toolName}`

    // bash 需要特殊处理：在 worktree 目录执行
    if (toolName === "bash" && cwd) {
      const command = String(resolvedArgs.command ?? "")
      const proc = Bun.spawnSync(["bash", "-c", command], { cwd })
      return proc.stdout.toString() + (proc.stderr.toString() ? `\nstderr:\n${proc.stderr.toString()}` : "")
    }

    return await tool.execute(resolvedArgs)
  }

  /** 将工具参数中的相对路径解析为 worktree 内的绝对路径 */
  private resolveCwdArgs(
    toolName: string,
    args: Record<string, unknown>,
    cwd: string,
  ): Record<string, unknown> {
    const newArgs = { ...args }
    const pathArg = newArgs.path
    if (typeof pathArg === "string" && !path.isAbsolute(pathArg)) {
      newArgs.path = path.resolve(cwd, pathArg)
    }
    return newArgs
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
    if (config.prompt.instructions) {
      messages.push({ role: "system", content: config.prompt.instructions })
    }
    if (config.prompt.role) prompt += `角色：${config.prompt.role}\n`
    prompt += `任务：${config.prompt.task}\n`

    // 如果指定了 responseSchema，注入标准字段 + 任务特定字段
    if (config.responseSchema) {
      const schema = config.responseSchema as Record<string, unknown>
      const userProps = (schema.properties as Record<string, unknown> | undefined) ?? {}
      // 过滤掉标准字段，防止重复
      const STANDARD_FIELDS = new Set(["keyFindings", "decisions", "summary"])
      const userFields = Object.entries(userProps)
        .filter(([k]) => !STANDARD_FIELDS.has(k))
        .map(([k, v]: [string, unknown]) => {
          const desc = (v as Record<string, unknown> | undefined)?.description
          return `      "${k}": ${JSON.stringify(desc ?? `${k}的内容`)}`
        })
        .join(",\n")
      const exampleJson = `{\n  "keyFindings": ["发现了 X 问题", "发现了 Y 问题"],\n  "decisions": ["决定做 A", "决定做 B"],\n  "summary": "一句话总结做了什么"${userFields ? `,\n${userFields}` : ""}\n}`
      prompt += `\n输出纯 JSON，不要 markdown 代码块，不要额外文字。格式如下：\n${exampleJson}\n`
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
    // worktree 隔离
    let worktreePath: string | undefined
    if (config.isolation === "worktree") {
      const slug = `dispatch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
      try {
        worktreePath = await createWorktree(slug)
      } catch (e) {
        return { status: "error", output: `创建 worktree 失败: ${e}` }
      }
    }

    const messages = await this.assembleMessages(config)
    const allowedTools = config.allowed_tools ?? ALL_TOOLS.map((t) => t.function.name)

    const subAgent = new SubAgent(messages, allowedTools, this, worktreePath)
    const result = await subAgent.run()

    // worktree 变更检测
    if (worktreePath) {
      const changes = await getChanges(worktreePath)
      if (changes.length > 0) {
        result.output += `\n[worktree 变更] 路径: ${worktreePath}\n修改了 ${changes.length} 个文件: ${changes.join(", ")}`
      } else {
        await removeWorktree(worktreePath)
      }
    }

    // 如果指定了 responseSchema，尝试解析结构化 JSON
    if (config.responseSchema && result.output) {
      try {
        result.structured = JSON.parse(result.output)
      } catch {
        // fallback: 从 markdown 代码块中提取 JSON
        try {
          const match = result.output.match(/```(?:json)?\s*([\s\S]*?)```/)
          if (match) {
            result.structured = JSON.parse(match[1]!.trim())
          } else {
            result.structured = null
          }
        } catch {
          result.structured = null
        }
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
    private cwd?: string,
  ) {}

  async run(): Promise<SubAgentResult> {
    const availableTools = ALL_TOOLS.filter((t) =>
      this.allowedTools.includes(t.function.name),
    )

    for (let i = 0; i < MAX_REACT_ITERATIONS; i++) {
      await saveDialogue("system", `[子Agent 轮次 ${i + 1}/${MAX_REACT_ITERATIONS}]`)

      // 每轮 LLM 调用带超时保护
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), LLM_CALL_TIMEOUT_MS)
      let response: LLMResponse
      try {
        response = await callLLM(this.messages, availableTools, { signal: controller.signal })
      } catch (e: any) {
        clearTimeout(timeout)
        if (e?.name === "AbortError") {
          await saveDialogue("system", `[子Agent 超时] LLM 调用超过 ${LLM_CALL_TIMEOUT_MS}ms`)
          return { status: "error", output: `子Agent LLM 调用超时（${LLM_CALL_TIMEOUT_MS}ms）` }
        }
        await saveDialogue("system", `[子Agent 错误] ${e?.message ?? e}`)
        return { status: "error", output: `子Agent 执行出错: ${e?.message ?? e}` }
      }
      clearTimeout(timeout)

      // LLM 返回了最终文本 → 退出
      if (!response.tool_calls || response.tool_calls.length === 0) {
        await saveDialogue("assistant", `[子Agent 完成] ${response.content ?? ""}`)
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

      // 并行执行所有工具调用（如有 cwd 则透传给子Agent）
      const results = await Promise.all(
        parsed.map(({ tc, args }) =>
          this.harness.executeToolCall(tc.function.name, args, this.cwd),
        ),
      )

      // 按顺序放回消息列表，并记录日志
      for (let ti = 0; ti < parsed.length; ti++) {
        const { tc } = parsed[ti]!
        this.messages.push({ role: "assistant", content: null, tool_calls: [tc], reasoning_content: response.reasoning_content ?? null })
        this.messages.push({ role: "tool", content: results[ti]!, tool_call_id: tc.id })
        await saveDialogue("assistant", `[子Agent 工具] ${tc.function.name}: ${tc.function.arguments}`)
        await saveDialogue("tool", `[子Agent 结果] ${results[ti]!}`)
      }
    }

    await saveDialogue("system", "[子Agent 超时]")
    return {
      status: "error",
      output: "子Agent任务未在限定轮次内完成",
    }
  }
}
