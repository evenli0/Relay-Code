import { Orchestrator } from "./orchestrator"

async function main() {
  const orchestrator = new Orchestrator()

  const input = process.argv[2]
  if (!input) {
    console.error("用法: bun run src/index.ts '你的指令'")
    console.error('示例: bun run src/index.ts "帮我看一下当前目录有哪些文件"')
    process.exit(1)
  }

  const result = await orchestrator.runReAct(input)
  console.log(result)
}

main().catch(console.error)
