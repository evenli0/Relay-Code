import { test, expect, mock, beforeEach } from "bun:test"

// Mock callLLM 模块
const responseQueue: Array<{ content: string | null; tool_calls?: any[] }> = []
const mockCallLLM = mock(async () => {
  const next = responseQueue.shift()
  if (next) return next
  return { content: "mock fallback", tool_calls: undefined }
})

mock.module("../src/llm", () => ({
  callLLM: mockCallLLM,
}))

// Mock worktree 模块
const mockCreateWorktree = mock(async (slug: string) => `/tmp/test-wt-${slug}`)
const mockRemoveWorktree = mock(async (_path: string) => {})
const mockGetChanges = mock(async (_path: string): Promise<string[]> => [])

mock.module("../src/worktree", () => ({
  createWorktree: mockCreateWorktree,
  removeWorktree: mockRemoveWorktree,
  getChanges: mockGetChanges,
}))

import { Harness } from "../src/harness"
import type { ChatMessage } from "../src/types"

beforeEach(() => {
  responseQueue.length = 0
  mockCallLLM.mockClear()
  mockCreateWorktree.mockClear()
  mockRemoveWorktree.mockClear()
  mockGetChanges.mockClear()
})

// =============================================
// 消息拼装测试（不依赖LLM mock）
// =============================================

test("消息拼装：无 preload，纯 task", async () => {
  const harness = new Harness()
  const msgs = await harness.assembleMessages({
    prompt: { task: "审查login.ts" },
  })

  expect(msgs.length).toBe(2) // system + user
  expect(msgs[0]?.role).toBe("system")
  expect(msgs[1]?.role).toBe("user")
  expect(msgs[1]?.content).toContain("审查login.ts")
})

test("消息拼装：有 preload 文件", async () => {
  await Bun.write("test_preload.json", JSON.stringify({ style: "中文注释" }))

  const harness = new Harness()
  const msgs = await harness.assembleMessages({
    preload: ["test_preload.json"],
    prompt: { task: "审查login.ts" },
  })

  // system + preload × 1 + user
  expect(msgs.length).toBe(3)
  expect(msgs[1]?.role).toBe("system")
  expect(msgs[1]?.content).toContain("test_preload.json")
  expect(msgs[1]?.content).toContain("中文注释")

  Bun.write("test_preload.json", "")
})

test("消息拼装：完整 prompt 结构", async () => {
  const harness = new Harness()
  const msgs = await harness.assembleMessages({
    prompt: {
      role: "代码审查员",
      task: "审查login.ts",
    },
  })

  const content = msgs[msgs.length - 1]?.content ?? ""
  expect(content).toContain("代码审查员")
  expect(content).toContain("审查login.ts")
})

test("消息拼装：多个 preload 文件", async () => {
  await Bun.write("test_a.json", "内容A")
  await Bun.write("test_b.json", "内容B")

  const harness = new Harness()
  const msgs = await harness.assembleMessages({
    preload: ["test_a.json", "test_b.json"],
    prompt: { task: "综合两文件信息" },
  })

  // system + preload × 2 + user
  expect(msgs.length).toBe(4)
  expect(msgs[1]?.content).toContain("内容A")
  expect(msgs[2]?.content).toContain("内容B")

  Bun.write("test_a.json", "")
  Bun.write("test_b.json", "")
})

test("消息拼装：preload 文件不存在时优雅降级", async () => {
  const harness = new Harness()
  const msgs = await harness.assembleMessages({
    preload: ["不存在_的文件.json"],
    prompt: { task: "测试" },
  })

  expect(msgs.length).toBe(3)
  expect(msgs[1]?.content).toContain("文件读取失败")
})

// =============================================
// responseSchema 测试
// =============================================

test("responseSchema：有 schema 时 prompt 包含格式要求", async () => {
  const harness = new Harness()
  const msgs = await harness.assembleMessages({
    prompt: { task: "审查代码" },
    responseSchema: {
      type: "object",
      properties: {
        conclusion: { type: "string" },
        severity: { type: "string" },
      },
      required: ["conclusion"],
    },
  })

  const content = msgs[msgs.length - 1]?.content ?? ""
  expect(content).toContain("JSON")
  expect(content).toContain("conclusion")
  expect(content).toContain("severity")
})

test("responseSchema：子 Agent 返回合法 JSON → structured 有值", async () => {
  responseQueue.push({
    content: '{"conclusion": "有安全漏洞", "severity": "high"}',
    tool_calls: undefined,
  })

  const harness = new Harness()
  const result = await harness.dispatch({
    prompt: { task: "审查代码" },
    responseSchema: {
      type: "object",
      properties: {
        conclusion: { type: "string" },
        severity: { type: "string" },
      },
    },
  })

  expect(result.status).toBe("completed")
  expect(result.structured).toEqual({
    conclusion: "有安全漏洞",
    severity: "high",
  })
})

test("responseSchema：子 Agent 返回非法 JSON → structured 为 null", async () => {
  responseQueue.push({
    content: "我觉得代码还行，没啥问题",
    tool_calls: undefined,
  })

  const harness = new Harness()
  const result = await harness.dispatch({
    prompt: { task: "审查代码" },
    responseSchema: {
      type: "object",
      properties: {
        conclusion: { type: "string" },
      },
    },
  })

  expect(result.status).toBe("completed")
  expect(result.structured).toBeNull()
  expect(result.output).toBe("我觉得代码还行，没啥问题")
})

// =============================================
// plan 参数测试
// =============================================

test("plan 参数：有 plan 时 prompt 包含阶段编排", async () => {
  const harness = new Harness()
  const msgs = await harness.assembleMessages({
    prompt: { task: "重构登录模块" },
    plan: {
      goal: "实现用户登录功能",
      phases: [
        { name: "分析", description: "分析现有登录代码" },
        { name: "重构", description: "执行重构并并行审查" },
        { name: "验证", description: "测试结果" },
      ],
    },
  })

  const content = msgs[msgs.length - 1]?.content ?? ""
  expect(content).toContain("实现用户登录功能")
  expect(content).toContain("分析")
  expect(content).toContain("重构")
  expect(content).toContain("验证")
  expect(content).toContain("并行")
})

test("plan 参数：子 Agent prompt 中能看到所有阶段", async () => {
  responseQueue.push({
    content: "我看到有三个阶段要做：分析现有代码，重构，然后验证。",
    tool_calls: undefined,
  })

  const harness = new Harness()
  const result = await harness.dispatch({
    prompt: { task: "重构登录模块" },
    plan: {
      goal: "实现用户登录",
      phases: [
        { name: "分析", description: "分析现有代码" },
        { name: "重构", description: "执行重构" },
        { name: "验证", description: "测试结果" },
      ],
    },
  })

  expect(result.status).toBe("completed")
  expect(result.output).toContain("分析")
  expect(result.output).toContain("重构")
  expect(result.output).toContain("验证")
})

// =============================================
// dispatch 流程
// =============================================

test("dispatch 工厂：preload + prompt 完整流程", async () => {
  await Bun.write("test_ctx.json", "项目的代码风格是使用中文注释")

  responseQueue.push({ content: "好的，我看到了代码风格要求。", tool_calls: undefined })

  const harness = new Harness()
  const result = await harness.dispatch({
    preload: ["test_ctx.json"],
    prompt: {
      role: "审查员",
      task: "理解代码风格要求并确认",
    },
    allowed_tools: ["read"],
  })

  expect(result.status).toBe("completed")
  expect(result.output).toContain("代码风格要求")

  Bun.write("test_ctx.json", "")
})

test("dispatch 工厂：allowed_tools 传空数组 → 子Agent不能调任何工具", async () => {
  responseQueue.push({ content: "我没有任何工具可用，只能用LLM完成任务", tool_calls: undefined })

  const harness = new Harness()
  const result = await harness.dispatch({
    prompt: { task: "用纯LLM完成任务" },
    allowed_tools: [],
  })

  expect(result.status).toBe("completed")
})

test("子Agent超出最大轮数 → 返回 error", async () => {
  for (let i = 0; i < 25; i++) {
    responseQueue.push({
      content: null,
      tool_calls: [
        {
          id: `c${i}`,
          type: "function" as const,
          function: {
            name: "bash",
            arguments: JSON.stringify({ command: "echo loop" }),
          },
        },
      ],
    })
  }

  const harness = new Harness()
  const result = await harness.dispatch({
    prompt: { task: "一直循环" },
    allowed_tools: ["bash"],
  })

  expect(result.status).toBe("error")
  expect(result.output).toContain("未在限定轮次内完成")
})

// =============================================
// worktree 隔离测试
// =============================================

test("worktree isolation: 启用时创建 worktree 并透传 cwd，无变更自动清理", async () => {
  // 子Agent 直接返回文本（无工具调用）
  responseQueue.push({ content: '{"result": "ok"}', tool_calls: undefined })

  const harness = new Harness()
  const result = await harness.dispatch({
    prompt: { task: "测试 worktree 隔离" },
    responseSchema: { type: "object", properties: { result: { type: "string" } } },
    isolation: "worktree",
  })

  expect(result.status).toBe("completed")
  expect(mockCreateWorktree).toHaveBeenCalledTimes(1)

  const slug = mockCreateWorktree.mock.calls[0]?.[0] as string
  expect(slug).toContain("dispatch-")

  // 无变更 → 自动清理
  expect(mockGetChanges).toHaveBeenCalledTimes(1)
  expect(mockRemoveWorktree).toHaveBeenCalledTimes(1)
})

test("worktree isolation: 有变更时保留 worktree 并报告路径和变更文件", async () => {
  mockGetChanges.mockImplementation(async (_path) => ["modified.txt", "new_file.ts"])

  responseQueue.push({ content: '{"result": "done"}', tool_calls: undefined })

  const harness = new Harness()
  const result = await harness.dispatch({
    prompt: { task: "修改文件" },
    responseSchema: { type: "object", properties: { result: { type: "string" } } },
    isolation: "worktree",
  })

  expect(mockCreateWorktree).toHaveBeenCalledTimes(1)
  expect(mockGetChanges).toHaveBeenCalledTimes(1)
  // 有变更 → 不清理
  expect(mockRemoveWorktree).not.toHaveBeenCalled()
  // 结果中包含变更信息
  expect(result.output).toContain("[worktree 变更]")
  expect(result.output).toContain("modified.txt")
  expect(result.output).toContain("new_file.ts")
})

test("worktree isolation: createWorktree 失败时返回 error", async () => {
  mockCreateWorktree.mockImplementation(async (_slug: string) => { throw new Error("git 失败") })

  const harness = new Harness()
  const result = await harness.dispatch({
    prompt: { task: "失败场景" },
    responseSchema: { type: "object", properties: { result: { type: "string" } } },
    isolation: "worktree",
  })

  expect(result.status).toBe("error")
  expect(result.output).toContain("创建 worktree 失败")
  // createWorktree 失败 → 后续不会调用
  expect(mockGetChanges).not.toHaveBeenCalled()
  expect(mockRemoveWorktree).not.toHaveBeenCalled()
})

test("worktree isolation: 不启用 isolation 时不影响正常 dispatch", async () => {
  responseQueue.push({ content: '{"result": "normal"}', tool_calls: undefined })

  const harness = new Harness()
  const result = await harness.dispatch({
    prompt: { task: "正常任务" },
    responseSchema: { type: "object", properties: { result: { type: "string" } } },
  })

  expect(result.status).toBe("completed")
  // 不涉及 worktree
  expect(mockCreateWorktree).not.toHaveBeenCalled()
  expect(mockRemoveWorktree).not.toHaveBeenCalled()
  expect(mockGetChanges).not.toHaveBeenCalled()
})

// =============================================
// getPlanMessages 边界测试
// =============================================

test("getPlanMessages: 两文件都不存在 → 返回空数组", async () => {
  // 确保 plan.md 和 plans/current.md 都不存在
  try { await Bun.write("plan.md", "") } catch {}
  try { await Bun.spawnSync(["rm", "-rf", "plans"]) } catch {}

  const harness = new Harness()
  const msgs = await harness.getPlanMessages()
  expect(msgs).toEqual([])
})

test("getPlanMessages: plan.md 空白 → 返回空数组", async () => {
  await Bun.write("plan.md", "")
  // 确保没有 plans/current.md
  try { await Bun.spawnSync(["rm", "-rf", "plans"]) } catch {}

  const harness = new Harness()
  const msgs = await harness.getPlanMessages()
  expect(msgs).toEqual([])
})

test("getPlanMessages: plan.md 含 status: completed → 返回空数组", async () => {
  await Bun.write("plan.md", "name: test\nstatus: completed\n")
  try { await Bun.spawnSync(["rm", "-rf", "plans"]) } catch {}

  const harness = new Harness()
  const msgs = await harness.getPlanMessages()
  expect(msgs).toEqual([])
})

test("getPlanMessages: 相同内容第二次调用 → 返回空数组（去重）", async () => {
  await Bun.write("plan.md", "# 阶段1\n- [ ] 任务A\n")
  try { await Bun.spawnSync(["rm", "-rf", "plans"]) } catch {}

  const harness = new Harness()
  const first = await harness.getPlanMessages()
  const second = await harness.getPlanMessages()
  expect(first.length).toBeGreaterThan(0)
  expect(second).toEqual([])
})
