import type { ToolDefinition } from "./types"

/** read 工具：读取本地文件 */
const readTool: ToolDefinition = {
  type: "function",
  function: {
    name: "read",
    description: "读取本地文件内容",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径" },
      },
      required: ["path"],
    },
  },
  async execute(args) {
    const path = String(args.path ?? "")
    const file = Bun.file(path)
    const exists = await file.exists()
    if (!exists) return `错误：文件 ${path} 不存在`
    return await file.text()
  },
}

/** write 工具：写入本地文件 */
const writeTool: ToolDefinition = {
  type: "function",
  function: {
    name: "write",
    description: "写入内容到本地文件（覆盖已存在的文件）",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径" },
        content: { type: "string", description: "写入内容" },
      },
      required: ["path", "content"],
    },
  },
  async execute(args) {
    const path = String(args.path ?? "")
    const content = String(args.content ?? "")
    await Bun.write(path, content)
    return `文件 ${path} 写入成功（${content.length} 字符）`
  },
}

/** grep 工具：在文件中搜索文本 */
const grepTool: ToolDefinition = {
  type: "function",
  function: {
    name: "grep",
    description: "在文件或目录中搜索文本",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "搜索模式" },
        path: { type: "string", description: "搜索路径（默认当前目录）" },
      },
      required: ["pattern"],
    },
  },
  async execute(args) {
    const pattern = String(args.pattern ?? "")
    const searchPath = args.path ? String(args.path) : "."
    try {
      const proc = Bun.spawnSync(["grep", "-rn", pattern, searchPath])
      if (proc.exitCode === 0) return proc.stdout.toString()
      if (proc.exitCode === 1) return "未找到匹配"
      return `grep 错误：${proc.stderr.toString()}`
    } catch {
      return `grep 执行失败（当前环境可能不支持 grep 命令）`
    }
  },
}

/** bash 工具：执行 shell 命令 */
const bashTool: ToolDefinition = {
  type: "function",
  function: {
    name: "bash",
    description: "执行 shell 命令",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "要执行的命令" },
      },
      required: ["command"],
    },
  },
  async execute(args) {
    const command = String(args.command ?? "")
    try {
      const proc = Bun.spawnSync(["bash", "-c", command])
      return proc.stdout.toString() + (proc.stderr.toString() ? `\nstderr:\n${proc.stderr.toString()}` : "")
    } catch {
      return `bash 执行失败（当前环境可能不支持 bash）`
    }
  },
}

/** dispatch 工具的 schema（供编排Agent LLM 识别） */
const dispatchTool: ToolDefinition = {
  type: "function",
  function: {
    name: "dispatch",
    description: [
      '派子Agent执行一个阶段。配合 plan.md 做动态编排（需先存在 plan.md）。',
      '',
      '工作模式：',
      '  1. write("plan.md", ...) 写计划（目标 + 阶段列表）',
      '  2. dispatch(...) 执行当前阶段',
      '  · 看结果 → 更新 plan.md → 再 dispatch 下一阶段',
      '  · 重复直到完成',
      '',
      'plan.md 样例：',
      '  # 目标：重构登录模块',
      '  ## 阶段',
      '  - [ ] 分析：读取 login.ts，理解代码结构',
      '  - [ ] 审查：找出安全漏洞',
      '  - [ ] 修复：根据审查结果修复',
      '',
      '示例：',
      '  preload: ["plan.md"],  // 子Agent 能读到完整计划',
      '  dispatch({',
      '    prompt: { task: "分析 login.ts（当前阶段：分析）" },',
      '    responseSchema: { type: "object", properties: {',
      '      conclusion: { type: "string" },',
      '      keyDecisions: { type: "array", items: { type: "string" } }',
      '    }}',
      '  })',
    ].join("\n"),
    parameters: {
      type: "object",
      required: ["prompt"],
      properties: {
        prompt: {
          type: "object",
          required: ["task"],
          properties: {
            task: { type: "string", description: "（必填）子Agent要完成的具体任务" },
            role: { type: "string", description: "（可选）子Agent的角色，如「安全审计员」" },
          },
        },
        preload: {
          type: "array",
          items: { type: "string" },
          description: "（可选）预载到子Agent上下文的文件路径。推荐 preload: [\"plan.md\"]",
        },
        responseSchema: {
          type: "object",
          description: "（可选）子Agent输出的JSON结构。推荐让子Agent返回 keyDecisions 用于决策。",
        },
        phase: {
          type: "string",
          description: "（可选）当前执行的阶段名称，和 plan.md 中的阶段对齐",
        },
        allowed_tools: {
          type: "array",
          items: { type: "string", enum: ["read", "write", "edit", "grep", "bash"] },
          description: "（可选）子Agent可用工具。不传=全部可用，传[]=纯LLM无工具。",
        },
      },
    },
  },
  // execute 是后备实现在走Harness时不会被用到
  async execute() {
    return "dispatch 需要经过 Harness 执行"
  },
}

/** 所有可用的工具定义 */
export const ALL_TOOLS: ToolDefinition[] = [
  readTool,
  writeTool,
  grepTool,
  bashTool,
  dispatchTool,
]

/** 兼容：编排Agent默认工具列表 */
export const ORCHESTRATOR_TOOLS = ALL_TOOLS

/** 根据工具名称执行（不走权限检查，直接调用） */
export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const tool = ALL_TOOLS.find((t) => t.function.name === toolName)
  if (!tool) return `错误：未知工具 ${toolName}`
  return await tool.execute(args)
}
