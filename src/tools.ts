import type { ToolDefinition } from "./types"
import { callLLM } from "./llm"

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
    // 使用 Bun 的 file API
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
      return `grep 执行失败`
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
      return `命令执行失败`
    }
  },
}

/** dispatch 工具：派任务给子Agent */
const dispatchTool: ToolDefinition = {
  type: "function",
  function: {
    name: "dispatch",
    description: "派任务给一个子Agent或车厢。子Agent会独立执行任务并返回结果。",
    parameters: {
      type: "object",
      properties: {
        recipient: { type: "string", description: "接收者名称（如 代码Agent、车厢A）" },
        prompt: { type: "string", description: "要执行的任务描述" },
      },
      required: ["recipient", "prompt"],
    },
  },
  async execute(args) {
    const prompt = String(args.prompt ?? "")
    // Phase 1：子Agent就是一次简单的 LLM 调用
    // Phase 2 会加上工具权限过滤和上下文注入
    const result = await callLLM([{ role: "user", content: prompt }])
    return result.content ?? ""
  },
}

/** 编排Agent的全部可用工具 */
export const ORCHESTRATOR_TOOLS: ToolDefinition[] = [
  readTool,
  writeTool,
  grepTool,
  bashTool,
  dispatchTool,
]

/** 根据工具名称执行 */
export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const tool = ORCHESTRATOR_TOOLS.find((t) => t.function.name === toolName)
  if (!tool) return `错误：未知工具 ${toolName}`
  return await tool.execute(args)
}
