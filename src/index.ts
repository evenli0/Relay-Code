import { Orchestrator } from "./orchestrator"
import { saveDialogue, listMemoryFiles } from "./memory"
import type { Resource } from "./types"

async function main() {
  const orchestrator = new Orchestrator()

  const input = process.argv[2]
  if (!input) {
    console.error("用法: bun run src/index.ts '你的指令'")
    console.error('示例: bun run src/index.ts "帮我看一下当前目录有哪些文件"')
    process.exit(1)
  }

  // 从 memory/ 构建可用资源清单
  const files = await listMemoryFiles()
  const resources: Resource[] = files.map((f) => ({
    name: f.path.split("/").pop() ?? f.path,
    path: f.path,
    type: "memory" as const,
    cached: !f.isToday, // 今日文件还在写，缓存不稳定；旧文件已固定，缓存可命中
    pricePer1K: f.isToday ? 0.27 : 0.027,
    description: `${f.size} bytes`,
  }))

  const result = await orchestrator.runReAct(input, resources)

  // 对话自动落盘
  await saveDialogue("user", input)
  await saveDialogue("assistant", result)

  console.log(result)
}

main().catch(console.error)
