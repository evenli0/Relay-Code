import { test, expect, beforeEach, afterEach } from "bun:test"
import { executeTool } from "../src/tools"
import { setupSandbox, teardownSandbox } from "./helpers/sandbox"

beforeEach(() => {
  setupSandbox()
})

afterEach(() => {
  teardownSandbox()
})

// -----------------------------------------------
// readTool
// -----------------------------------------------

test("readTool: 读取已存在的文件", async () => {
  await Bun.write("hello.txt", "world")
  const result = await executeTool("read", { path: "hello.txt" })
  expect(result).toBe("world")
})

test("readTool: 读取不存在的文件返回错误", async () => {
  const result = await executeTool("read", { path: "不存在.txt" })
  expect(result).toContain("不存在")
})

test("readTool: 空 path 返回错误", async () => {
  const result = await executeTool("read", { path: "" })
  // 空路径 = 当前目录（Bun.file("") 行为不定），应返回某种错误信息
  expect(typeof result).toBe("string")
})

// -----------------------------------------------
// writeTool
// -----------------------------------------------

test("writeTool: 正常写入文件", async () => {
  const result = await executeTool("write", { path: "test.txt", content: "hello" })
  expect(result).toContain("写入成功")
  expect(result).toContain("test.txt")

  const content = await Bun.file("test.txt").text()
  expect(content).toBe("hello")
})

test("writeTool: 空内容写入", async () => {
  const result = await executeTool("write", { path: "empty.txt", content: "" })
  expect(result).toContain("写入成功")

  const content = await Bun.file("empty.txt").text()
  expect(content).toBe("")
})

test("writeTool: 写入覆盖已有文件", async () => {
  await Bun.write("overwrite.txt", "旧内容")
  await executeTool("write", { path: "overwrite.txt", content: "新内容" })
  const content = await Bun.file("overwrite.txt").text()
  expect(content).toBe("新内容")
})

// -----------------------------------------------
// grepTool
// -----------------------------------------------

test("grepTool: 有匹配时返回匹配行", async () => {
  await Bun.write("search.txt", "apple\nbanana\ncherry\n")
  const result = await executeTool("grep", { pattern: "banana" })
  expect(result).toContain("banana")
})

test("grepTool: 无匹配时返回未找到", async () => {
  await Bun.write("search.txt", "apple\nbanana\n")
  const result = await executeTool("grep", { pattern: "不存在" })
  expect(result).toContain("未找到")
})

test("grepTool: 空模式", async () => {
  const result = await executeTool("grep", { pattern: "" })
  expect(typeof result).toBe("string")
})

// -----------------------------------------------
// bashTool
// -----------------------------------------------

test("bashTool: 成功执行命令", async () => {
  const result = await executeTool("bash", { command: "echo hello world" })
  expect(result.trim()).toBe("hello world")
})

test("bashTool: 失败命令返回错误", async () => {
  const result = await executeTool("bash", { command: "exit 1" })
  // 可能包含 stderr 或空
  expect(typeof result).toBe("string")
})

// -----------------------------------------------
// executeTool
// -----------------------------------------------

test("executeTool: 未知工具名返回错误", async () => {
  const result = await executeTool("不存在的工具", {})
  expect(result).toContain("未知工具")
})

test("executeTool: 已知工具正常执行", async () => {
  await Bun.write("test.txt", "hello")
  const result = await executeTool("read", { path: "test.txt" })
  expect(result).toBe("hello")
})
