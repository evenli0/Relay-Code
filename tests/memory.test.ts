import { test, expect, beforeEach } from "bun:test"
import { saveDialogue, listMemoryFiles, readMemoryFile } from "../src/memory"

function getTodayFilePath(): string {
  const date = new Date().toISOString().slice(0, 10)
  return `memory/dialogue_${date}.jsonl`
}

beforeEach(async () => {
  // 清理今日测试文件（新旧命名都清）
  try { await Bun.write(getTodayFilePath(), "") } catch {}
  const oldPath = `memory/对话_${new Date().toISOString().slice(0, 10)}.jsonl`
  try { await Bun.write(oldPath, "") } catch {}
})

// -----------------------------------------------
// Test 1：追加对话记录
// -----------------------------------------------
test("saveDialogue 追加对话记录到今日文件", async () => {
  await saveDialogue("user", "查一下login模块")
  await saveDialogue("assistant", "根据历史记录，要求是接口兼容")

  const files = await listMemoryFiles()
  const todayFile = files.find((f) => f.isToday)
  expect(todayFile).toBeDefined()

  const content = await readMemoryFile(todayFile!.path)
  const lines = content.trim().split("\n")
  expect(lines.length).toBe(2)

  const first = JSON.parse(lines[0]!)
  expect(first.role).toBe("user")
  expect(first.content).toBe("查一下login模块")

  const second = JSON.parse(lines[1]!)
  expect(second.role).toBe("assistant")
  expect(second.content).toBe("根据历史记录，要求是接口兼容")
})

// -----------------------------------------------
// Test 2：连续追加不覆盖
// -----------------------------------------------
test("连续追加不覆盖已有内容", async () => {
  await saveDialogue("user", "第一轮")
  await saveDialogue("assistant", "回复1")
  await saveDialogue("user", "第二轮")

  const files = await listMemoryFiles()
  const todayFile = files.find((f) => f.isToday)
  const content = await readMemoryFile(todayFile!.path)
  const lines = content.trim().split("\n")
  expect(lines.length).toBe(3)
})

// -----------------------------------------------
// Test 3：listMemoryFiles 返回文件列表
// -----------------------------------------------
test("listMemoryFiles 返回文件信息", async () => {
  await saveDialogue("user", "测试文件列表")

  const files = await listMemoryFiles()
  expect(files.length).toBeGreaterThan(0)
  const today = files.find((f) => f.isToday)
  expect(today).toBeDefined()
  expect(today!.path).toContain("memory/dialogue_")
  expect(today!.size).toBeGreaterThan(0)
})

// -----------------------------------------------
// Test 4：新建 memory 目录（如果不存在）
// -----------------------------------------------
test("memory 目录不存在时自动创建", async () => {
  // 删除 memory 目录
  try { await Bun.spawnSync(["rm", "-rf", "memory"]) } catch {}

  await saveDialogue("user", "重建测试")
  const files = await listMemoryFiles()
  expect(files.length).toBeGreaterThan(0)
})
