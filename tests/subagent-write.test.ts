/**
 * 子 Agent write 工具专项测试
 *
 * 目标：复现 "write 缺路径" 问题，定位根因。
 * 不修改需求，只通过测试+日志定位问题。
 */

import { beforeEach, expect, mock, test } from "bun:test";
import { SubAgent } from "../src/dispatcher";
import { assembleMessages } from "../src/message-assembler";
import { ToolExecutor } from "../src/tool-executor";
import type { DispatchConfig, LLMResponse } from "../src/types";

// ── Mock LLM ────────────────────────────────────────
const llmResponses: LLMResponse[] = [];
const mockCallLLM = mock(async (): Promise<LLMResponse> => {
	const next = llmResponses.shift();
	if (next) return next;
	return { content: "mock fallback", tool_calls: undefined };
});

mock.module("../src/llm", () => ({ callLLM: mockCallLLM }));

beforeEach(() => {
	llmResponses.length = 0;
	mockCallLLM.mockClear();
});

// ── 辅助函数 ────────────────────────────────────────

/** 构建一个 "分析并写入文件" 的 task */
function makeConfig(opts?: Partial<DispatchConfig["prompt"]>): DispatchConfig {
	return {
		prompt: {
			role: "代码分析师",
			task: opts?.task ?? "分析 src/tools.ts 的代码结构，把报告写入 docs/analysis.md",
			instructions: opts?.instructions,
		},
		responseSchema: {
			type: "object",
			properties: {
				keyFindings: { type: "array", description: "关键发现" },
				summary: { type: "string", description: "一句话总结" },
			},
		} as unknown as Record<string, unknown>,
		max_rounds: 5,
	};
}

/** 打印完整的对话历史 */
function logMessages(label: string, msgs: { role: string; content?: string | null; tool_calls?: unknown[] }[]): void {
	console.log(`\n=== ${label} ===`);
	for (const m of msgs) {
		console.log(`[${m.role}] ${typeof m.content === "string" ? m.content.slice(0, 200) : "(tool_calls)"}`);
	}
	console.log("=== end ===\n");
}

// ============================================================
// 测试 1：检查子 Agent 收到的完整 prompt
// ============================================================

test("子 Agent 的 system prompt 不含矛盾指令", async () => {
	const config = makeConfig();
	const msgs = await assembleMessages(config);

	logMessages("子 Agent 收到的消息", msgs);

	// system prompt 不能有 "不要用 write"
	const systemMsg = msgs.find((m) => m.role === "system")?.content ?? "";
	expect(systemMsg).toContain("write");
	expect(systemMsg).not.toContain("不要用 write 输出");

	// user prompt 不能有 "输出纯 JSON" 这种和 write 冲突的指令
	const userMsg = msgs.find((m) => m.role === "user")?.content ?? "";
	expect(userMsg).toContain("分析 src/tools.ts");

	console.log("SYSTEM:", systemMsg);
	console.log("USER:", userMsg);
});

// ============================================================
// 测试 2：模拟 LLM 正常调 write（有路径）
// ============================================================

test("write 工具：传入正常路径 → 成功", async () => {
	const executor = new ToolExecutor();

	// 模拟正常的 write 调用：有路径有内容
	const result = await executor.executeToolCall("write", {
		path: "test_output.md",
		content: "# 测试报告\n\n这是一份测试报告。",
	});

	console.log("write result:", result);
	expect(result).toContain("写入成功");

	// 清理
	const { unlinkSync } = await import("node:fs");
	try { unlinkSync("test_output.md"); } catch { /* ignore */ }
});

// ============================================================
// 测试 3：模拟 LLM 调 write 但缺路径（复现 bug）
// ============================================================

test("write 工具：缺路径 → 返回可操作的错误提示", async () => {
	const executor = new ToolExecutor();

	// 缺 path
	const r1 = await executor.executeToolCall("write", { content: "some content" });
	console.log("缺 path:", r1);
	expect(r1).toContain("缺少文件路径");

	// 空 path
	const r2 = await executor.executeToolCall("write", { path: "", content: "some content" });
	console.log("空 path:", r2);
	expect(r2).toContain("缺少文件路径");

	// 有 path 无 content（也应能处理）
	const r3 = await executor.executeToolCall("write", { path: "test_empty.md", content: "" });
	console.log("空 content:", r3);
	expect(r3).toContain("写入成功");
	try { const { unlinkSync } = await import("node:fs"); unlinkSync("test_empty.md"); } catch { /* ignore */ }
});

// ============================================================
// 测试 4：完整模拟子 Agent 执行 — write → JSON 汇报
// ============================================================

test("完整流程：子 Agent 读文件 → write 报告 → JSON 汇报", async () => {
	const config = makeConfig();
	const msgs = await assembleMessages(config);
	logMessages("子 Agent 完整对话起始", msgs);

	const executor = new ToolExecutor();

	// Round 1: LLM 调 read
	llmResponses.push({
		content: null,
		tool_calls: [{
			id: "call_1",
			type: "function",
			function: { name: "read", arguments: JSON.stringify({ path: "src/tools.ts" }) },
		}],
	});

	// Round 2: LLM 调 write 写报告（有路径！）
	llmResponses.push({
		content: null,
		tool_calls: [{
			id: "call_2",
			type: "function",
			function: { name: "write", arguments: JSON.stringify({ path: "docs/test_analysis.md", content: "# 分析报告\n\n## 发现\n- tools.ts 包含 5 个工具定义" }) },
		}],
	});

	// Round 3: LLM 返回 JSON 汇报（不调工具）
	llmResponses.push({
		content: JSON.stringify({ keyFindings: ["tools.ts 定义了读/写/grep/bash/dispatch"], summary: "已完成分析并写入 docs/test_analysis.md" }),
		tool_calls: undefined,
	});

	const agent = new SubAgent(msgs, ["read", "write", "grep", "bash"], executor);
	const result = await agent.run();

	console.log("\n=== 子 Agent 最终结果 ===");
	console.log("status:", result.status);
	console.log("output:", result.output?.slice(0, 500));

	expect(result.status).toBe("completed");
	expect(result.output).toContain("keyFindings");

	// 清理
	try {
		const { unlinkSync, existsSync } = await import("node:fs");
		const { mkdirSync } = await import("node:fs");
		if (!existsSync("docs")) mkdirSync("docs", { recursive: true });
		if (existsSync("docs/test_analysis.md")) unlinkSync("docs/test_analysis.md");
	} catch { /* ignore */ }
});

// ============================================================
// 测试 5：模拟 write 缺路径 → 错误消息 → 下一轮修正
// ============================================================

test("write 缺路径后 LLM 在下一轮能修正", async () => {
	const config = makeConfig({ task: "分析然后写报告到 docs/report.md" });
	const msgs = await assembleMessages(config);
	const executor = new ToolExecutor();

	// Round 1: LLM 调 write 但缺路径（模拟 bug 场景）
	llmResponses.push({
		content: null,
		tool_calls: [{
			id: "call_bad",
			type: "function",
			function: { name: "write", arguments: JSON.stringify({ path: "", content: "# 报告\n内容" }) },
		}],
	});

	// Round 2: LLM 看到错误消息，修正后正确调 write
	llmResponses.push({
		content: null,
		tool_calls: [{
			id: "call_good",
			type: "function",
			function: { name: "write", arguments: JSON.stringify({ path: "docs/report.md", content: "# 分析报告\n完成" }) },
		}],
	});

	// Round 3: JSON 汇报
	llmResponses.push({ content: JSON.stringify({ keyFindings: ["完成"], summary: "done" }) });

	const agent = new SubAgent(msgs, ["read", "write", "grep", "bash"], executor);
	const result = await agent.run();

	console.log("\n=== write 缺路径后修正 ===");
	console.log("status:", result.status);
	console.log("output:", result.output?.slice(0, 300));

	expect(result.status).toBe("completed");

	// 清理
	try { const { unlinkSync, existsSync } = await import("node:fs"); if (existsSync("docs/report.md")) unlinkSync("docs/report.md"); } catch { /* ignore */ }
});
