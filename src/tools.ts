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
      '派一个子Agent执行编排任务。有两种模式：',
      '',
      '模式1 — 多阶段（一次性编排）：',
      '  给完整phases，子Agent按顺序执行所有阶段后一次性回报。',
      '  适合确定性的、不需要中间干预的任务。',
      '',
      '模式2 — 单步动态编排（推荐）：',
      '  每次只给一个phase，子Agent回报结构化结果后，主Agent根据结果决定下一阶段。',
      '  plan.goal 是远景目标，phases 只写当前要执行的阶段。',
      '  适合需要根据中间结果动态调整的复杂任务。',
      '',
      '示例（单步动态编排）：',
      '  dispatch({',
      '    prompt: { task: "分析 login.ts 的代码结构" },',
      '    plan: { goal: "重构登录模块", phases: [{ name: "分析", description: "读取并分析 login.ts" }] },',
      '    responseSchema: { type: "object", properties: { analysis: { type: "string" }, issues: { type: "array" } } }',
      '  })',
      '  → 主Agent看到结果 → 决定下一阶段 → 再dispatch',
    ].join("\n"),
    parameters: {
      type: "object",
      required: ["prompt", "plan"],
      properties: {
        prompt: {
          type: "object",
          required: ["task"],
          properties: {
            task: { type: "string", description: "（必填）子Agent要完成的具体任务" },
            role: { type: "string", description: "（可选）子Agent的角色，如「安全审计员」" },
          },
        },
        plan: {
          type: "object",
          description: "（必填）编排计划",
          required: ["goal", "phases"],
          properties: {
            goal: { type: "string", description: "（必填）本次编排的总体目标" },
            phases: {
              type: "array",
              description: "（必填）阶段列表。多阶段模式=一次给所有阶段，子Agent全部执行完回报。单步模式=只给一个阶段，执行完回报后主Agent决定下一阶段。parallel=true 表示该阶段可并行。",
              items: {
                type: "object",
                required: ["name", "description"],
                properties: {
                  name: { type: "string", description: "阶段名称" },
                  description: { type: "string", description: "这个阶段要完成什么" },
                  parallel: { type: "boolean", description: "true=该阶段可并行" },
                },
              },
            },
          },
        },
        preload: {
          type: "array",
          items: { type: "string" },
          description: "（可选）预载到子Agent上下文的文件路径。不传则子Agent只有系统提示和prompt。",
        },
        allowed_tools: {
          type: "array",
          items: { type: "string", enum: ["read", "write", "edit", "grep", "bash"] },
          description: "（可选）子Agent可用工具。不传=全部可用，传[]=纯LLM无工具。",
        },
        responseSchema: {
          type: "object",
          description: "（可选）指定子Agent输出的JSON结构。子Agent会按此结构返回结构化结果。",
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
