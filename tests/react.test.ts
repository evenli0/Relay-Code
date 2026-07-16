import { afterAll, beforeEach, expect, mock, test } from "bun:test";

type MockResponse = { content: string | null; tool_calls?: any[] };

// 全局 mock 函数：返回预设队列中的下一个响应
const responseQueue: MockResponse[] = [];
const mockCallLLM = mock(async () => {
	const next = responseQueue.shift();
	if (next) return next;
	return { content: "默认返回", tool_calls: undefined };
});

mock.module("../src/llm", () => ({
	callLLM: mockCallLLM,
}));

import { Orchestrator } from "../src/orchestrator";
import type { ChatMessage } from "../src/types";

beforeEach(async () => {
	responseQueue.length = 0;
	mockCallLLM.mockClear();
	await Bun.write("plan.md", "# 目标：测试\n## 阶段\n- [ ] 测试阶段\n");
});

afterAll(async () => {
	try {
		await Bun.write("plan.md", "");
	} catch {}
});

// -----------------------------------------------
// Test 1：LLM 直接返回文本 → 退出循环
// -----------------------------------------------
test("LLM直接返回文本 → 一轮循环结束", async () => {
	responseQueue.push({
		content: "你好，我是Relay Code",
		tool_calls: undefined,
	});

	const orch = new Orchestrator();
	const result = await orch.runReAct("说你好");

	expect(result).toBe("你好，我是Relay Code");
	expect(mockCallLLM).toHaveBeenCalledTimes(1);

	const firstCallMessages = mockCallLLM.mock.calls[0]?.[0] as ChatMessage[];
	expect(firstCallMessages[0]?.role).toBe("system");
	expect(firstCallMessages[1]?.role).toBe("user");
	expect(firstCallMessages[1]?.content).toBe("说你好");
});

// -----------------------------------------------
// Test 2：调 dispatch → 子Agent执行 → 结果放回 → 再调 → 返回文本
// 注：dispatch 参数格式已从 {recipient, prompt} 改为 {prompt: {task}}
test("dispatch工具调用 → 结果放回 → 再调LLM → 返回文本", async () => {
	// 第1次：编排Agent调LLM → 返回 dispatch 工具调用（新版schema）
	responseQueue.push({
		content: null,
		tool_calls: [
			{
				id: "call_dispatch_1",
				type: "function" as const,
				function: {
					name: "dispatch",
					arguments: JSON.stringify({
						task: "写一个hello world脚本",
					}),
				},
			},
		],
	});
	// 第2次：dispatch → harness 创建子Agent → 子Agent调LLM → 返回结果
	responseQueue.push({
		content: "已创建 hello world 脚本",
		tool_calls: undefined,
	});
	// 第3次：编排Agent看到结果后继续 → 返回最终文本
	responseQueue.push({
		content: "完成。已创建 hello world 脚本",
		tool_calls: undefined,
	});

	const orch = new Orchestrator();
	const result = await orch.runReAct("帮我写个hello world");

	expect(result).toContain("已创建 hello world 脚本");

	// 验证：编排Agent收到了dispatch的完整回执
	const allCalls = mockCallLLM.mock.calls;
	const finalCallMessages = allCalls[allCalls.length - 1]?.[0] as ChatMessage[];
	const toolMessage = finalCallMessages.find((m) => m.role === "tool");
	expect(toolMessage).toBeDefined();
	// dispatch 回执经过 Harness 包装
	expect(toolMessage?.content).toContain("[dispatch 完成]");
	expect(toolMessage?.content).toContain("已创建 hello world 脚本");
});

// -----------------------------------------------
// Test 3：多条工具调用 → 逐步执行 → 退出
// -----------------------------------------------
test("多条工具调用 → 顺序执行 → 退出", async () => {
	// 第1次：返回两个工具调用
	responseQueue.push({
		content: null,
		tool_calls: [
			{
				id: "call_1",
				type: "function" as const,
				function: {
					name: "read",
					arguments: JSON.stringify({ path: "test.txt" }),
				},
			},
			{
				id: "call_2",
				type: "function" as const,
				function: {
					name: "bash",
					arguments: JSON.stringify({ command: "echo hi" }),
				},
			},
		],
	});
	// 第2次：编排Agent收到结果后继续 → 返回文本
	responseQueue.push({ content: "完成。已检查", tool_calls: undefined });

	const orch = new Orchestrator();
	const result = await orch.runReAct("检查");

	expect(result).toBe("完成。已检查");

	// 验证：两个工具结果都被放回了 messages
	const secondCallMessages = mockCallLLM.mock.calls[1]?.[0] as ChatMessage[];
	const toolMessages = secondCallMessages.filter((m) => m.role === "tool");
	expect(toolMessages.length).toBe(2);
});

// -----------------------------------------------
// Test 4：超出最大轮数 → 超时保护
// -----------------------------------------------
test("超出最大ReAct轮数 → 返回超时消息", async () => {
	// LLM 一直返回工具调用，永不返回文本
	for (let i = 0; i < 65; i++) {
		responseQueue.push({
			content: null,
			tool_calls: [
				{
					id: `call_${i}`,
					type: "function" as const,
					function: {
						name: "bash",
						arguments: JSON.stringify({ command: "echo loop" }),
					},
				},
			],
		});
	}

	const orch = new Orchestrator();
	const result = await orch.runReAct("一直循环");

	expect(result).toBe("任务未在限定轮次内完成，请尝试简化指令后重试。");
});

// -----------------------------------------------
// Test 5：空工具调用列表 → 视为无调用，退出
// -----------------------------------------------
test("空工具调用列表 → 视为无调用，退出", async () => {
	responseQueue.push({ content: "最终答案", tool_calls: [] });

	const orch = new Orchestrator();
	const result = await orch.runReAct("直接回答");

	expect(result).toBe("最终答案");
	expect(mockCallLLM).toHaveBeenCalledTimes(1);
});

// -----------------------------------------------
// Test 6：多轮对话记忆 - 同一实例累积历史
// -----------------------------------------------
test("多轮对话记忆：同一实例累积历史，第二轮可见第一轮消息", async () => {
	// 第一轮：LLM 执行一个工具调用
	responseQueue.push({
		content: null,
		tool_calls: [
			{
				id: "call_round1",
				type: "function" as const,
				function: {
					name: "bash",
					arguments: JSON.stringify({ command: "echo round1" }),
				},
			},
		],
	});
	responseQueue.push({ content: "第一轮完成", tool_calls: undefined });

	const orch = new Orchestrator();
	const result1 = await orch.runReAct("第一轮任务");

	expect(result1).toBe("第一轮完成");
	expect(mockCallLLM).toHaveBeenCalledTimes(2);

	// 第二轮：LLM 直接返回文本
	responseQueue.push({
		content: "第二轮完成，看到了历史",
		tool_calls: undefined,
	});

	const result2 = await orch.runReAct("第二轮任务");

	expect(result2).toBe("第二轮完成，看到了历史");

	// 验证第三轮 LLM 调用（总第3次）的 messages 包含完整历史
	const thirdCallMessages = mockCallLLM.mock.calls[2]?.[0] as ChatMessage[];

	// system prompt 只出现一次
	const systemMessages = thirdCallMessages.filter((m) => m.role === "system");
	expect(systemMessages.length).toBe(1);

	// 包含第一轮的 assistant 和 tool 消息
	const assistantMessages = thirdCallMessages.filter(
		(m) => m.role === "assistant",
	);
	expect(assistantMessages.length).toBeGreaterThanOrEqual(1);

	const toolMessages = thirdCallMessages.filter((m) => m.role === "tool");
	expect(toolMessages.length).toBeGreaterThanOrEqual(1);

	// 最后一条 user 消息是第二轮输入
	const lastUserMsg = [...thirdCallMessages]
		.reverse()
		.find((m) => m.role === "user") as
		| { role: "user"; content: string }
		| undefined;
	expect(lastUserMsg?.content).toBe("第二轮任务");
});

// -----------------------------------------------
// Test 7：多轮对话记忆 - resetConversation 清空历史
// -----------------------------------------------
test("resetConversation 清空历史，下一轮重新注入 system prompt", async () => {
	// 第一轮
	responseQueue.push({ content: "第一轮结果", tool_calls: undefined });
	const orch = new Orchestrator();
	await orch.runReAct("第一轮");
	expect(mockCallLLM).toHaveBeenCalledTimes(1);

	// 重置
	orch.resetConversation();

	// 第二轮
	responseQueue.push({ content: "第二轮结果", tool_calls: undefined });
	await orch.runReAct("第二轮");

	// 第二轮 LLM 调用的 messages 应该只有 system + user(第二轮) + plan
	const secondCallMessages = mockCallLLM.mock.calls[1]?.[0] as ChatMessage[];
	// 至少包含 system + user（plan 可能注入也可能为空数组）
	const filtered = secondCallMessages.filter(
		(m) => m.role === "system" || m.role === "user",
	);
	expect(filtered.length).toBeGreaterThanOrEqual(2);
	expect(filtered[0]?.role).toBe("system");
	// 最后一条是第二轮 user
	const lastUser = [...filtered].reverse().find((m) => m.role === "user") as
		| { role: "user"; content: string }
		| undefined;
	expect(lastUser?.content).toBe("第二轮");
});
