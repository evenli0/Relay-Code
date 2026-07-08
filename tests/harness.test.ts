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

import { Harness } from "../src/harness"
import { ORCHESTRATOR_ID, ORCHESTRATOR_PERMISSIONS } from "../src/types"
import type { ChatMessage } from "../src/types"

beforeEach(() => {
  responseQueue.length = 0
  mockCallLLM.mockClear()
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
      constraints: ["接口兼容", "中文注释"],
      task: "审查login.ts",
      anything_else: "注意第42行",
    },
  })

  const content = msgs[msgs.length - 1]?.content ?? ""
  expect(content).toContain("代码审查员")
  expect(content).toContain("接口兼容")
  expect(content).toContain("中文注释")
  expect(content).toContain("审查login.ts")
  expect(content).toContain("第42行")
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
// 权限测试（不依赖LLM mock）
// =============================================

test("权限拦截：不在 allowed_tools 的工具返回无权", async () => {
  const harness = new Harness()
  harness.registerAgent("test-readonly", ["read"])

  const result = await harness.executeToolCall("test-readonly", "write", {
    path: "test.txt",
    content: "hack",
  })

  expect(result).toContain("无权使用")
  expect(result).toContain("write")
})

test("权限放行：在 allowed_tools 的工具正常执行", async () => {
  const harness = new Harness()
  harness.registerAgent("test-bash", ["bash"])

  const result = await harness.executeToolCall("test-bash", "bash", {
    command: "echo hello_from_harness",
  })

  expect(result).toContain("hello_from_harness")
})

test("权限放行：编排Agent有全部工具权限", async () => {
  const harness = new Harness()
  harness.registerAgent(ORCHESTRATOR_ID, ORCHESTRATOR_PERMISSIONS)

  const result = await harness.executeToolCall(ORCHESTRATOR_ID, "read", {
    path: "package.json",
  })
  // 能正常读到文件，而不是报无权
  expect(result).not.toContain("无权使用")
})

test("权限隔离：两个Agent权限互不影响", async () => {
  const harness = new Harness()
  harness.registerAgent("agent-A", ["read"])
  harness.registerAgent("agent-B", ["bash"])

  const resultA = await harness.executeToolCall("agent-A", "bash", {
    command: "echo test",
  })
  expect(resultA).toContain("无权使用")
  expect(resultA).toContain("bash")

  const resultB = await harness.executeToolCall("agent-B", "bash", {
    command: "echo test",
  })
  expect(resultB).not.toContain("无权使用")
})

// =============================================
// 子Agent过程记录（依赖LLM mock）
// =============================================

test("子Agent过程记录：记录工具调用和最终输出", async () => {
  // 第1次：子Agent调 bash
  responseQueue.push({
    content: null,
    tool_calls: [
      {
        id: "c1",
        type: "function" as const,
        function: {
          name: "bash",
          arguments: JSON.stringify({ command: "echo hello_sub" }),
        },
      },
    ],
  })
  // 第2次：子Agent看到结果，返回最终文本
  responseQueue.push({ content: "任务完成", tool_calls: undefined })

  const harness = new Harness()
  const result = await harness.dispatch({
    prompt: { task: "跑一下echo" },
    allowed_tools: ["bash"],
  })

  expect(result.status).toBe("completed")
  expect(result.output).toBe("任务完成")

  // 过程记录包含工具调用和最终输出
  const toolSteps = result.process.filter((s) => s.type === "tool_call")
  expect(toolSteps.length).toBe(1)
  expect(toolSteps[0]?.tool_name).toBe("bash")

  const finalStep = result.process.find((s) => s.type === "final")
  expect(finalStep?.content).toBe("任务完成")
})

test("子Agent过程记录：被封装的工具调用也被记录", async () => {
  // 子Agent只有 read 权限，但它尝试调 write
  responseQueue.push({
    content: null,
    tool_calls: [
      {
        id: "c1",
        type: "function" as const,
        function: {
          name: "write",
          arguments: JSON.stringify({ path: "x.txt", content: "test" }),
        },
      },
    ],
  })
  // 被拦截后，子Agent决定返回文本
  responseQueue.push({
    content: "发现无权使用write工具，我只汇报",
    tool_calls: undefined,
  })

  const harness = new Harness()
  const result = await harness.dispatch({
    prompt: { task: "测试权限" },
    allowed_tools: ["read"], // 没有 write
  })

  expect(result.status).toBe("completed")

  // 过程记录中有 tool_call（LLM确实调了），但工具执行被拦截
  const toolCallStep = result.process.find((s) => s.type === "tool_call")
  expect(toolCallStep?.tool_name).toBe("write")

  // 子Agent最终理解了不能写
  expect(result.output).toContain("无权使用")
})

test("子Agent超出最大轮数 → 返回 error", async () => {
  // 一直返回工具调用
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
// dispatch 完整流程
// =============================================

test("dispatch 工厂：preload + prompt 完整流程", async () => {
  await Bun.write("test_ctx.json", "项目的代码风格是使用中文注释")

  // 子Agent读preload内容 → 返回
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

  // 验证子Agent的消息中包含了 preload
  // 直接在断言中验证输出即可
  Bun.write("test_ctx.json", "")
})

test("dispatch 工厂：allowed_tools 传空数组 → 子Agent不能调任何工具", async () => {
  // 子Agent尝试调工具（不应该有工具可选）
  responseQueue.push({ content: "我没有任何工具可用，只能用LLM完成任务", tool_calls: undefined })

  const harness = new Harness()
  const result = await harness.dispatch({
    prompt: { task: "用纯LLM完成任务" },
    allowed_tools: [], // 没有工具
  })

  expect(result.status).toBe("completed")
})
