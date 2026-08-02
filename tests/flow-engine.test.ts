import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { FlowEngine } from "../src/flow-engine";
import { setMockTransport } from "../src/llm";
import { ToolExecutor } from "../src/tool-executor";
import { ScriptedLLM, text } from "./helpers/mock-llm";

const FLOWS_DIR = ".relay/test-flows";

function writeFlow(id: string, def: unknown): void {
	mkdirSync(FLOWS_DIR, { recursive: true });
	writeFileSync(`${FLOWS_DIR}/${id}.json`, JSON.stringify(def), "utf-8");
}

afterAll(() => {
	setMockTransport(null);
	try {
		rmSync(FLOWS_DIR, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

describe("FlowEngine（fan-out/merge 并行聚合）", () => {
	let engine: FlowEngine;

	beforeEach(() => {
		engine = new FlowEngine(new ToolExecutor(), FLOWS_DIR);
	});

	test("merge all：并行派发全部任务并拼接结果", async () => {
		writeFlow("market-scan", {
			id: "market-scan",
			tasks: [
				{ task: "分析 A 市场", role: "分析师A" },
				{ task: "分析 B 市场", role: "分析师B" },
			],
			merge: "all",
		});
		const llm = new ScriptedLLM([text("A 市场结果"), text("B 市场结果")]);
		setMockTransport(llm);

		const r = await engine.runFanout("market-scan");
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.merge).toBe("all");
		expect(r.output).toContain("### 分析师A");
		expect(r.output).toContain("### 分析师B");
		// 两个子 agent 都被调用过（并行）
		expect(llm.calls).toBeGreaterThanOrEqual(2);
	});

	test("merge first：返回某个成功结果（不拼接）", async () => {
		writeFlow("any-win", {
			id: "any-win",
			tasks: [
				{ task: "方案一", role: "方案师1" },
				{ task: "方案二", role: "方案师2" },
			],
			merge: "first",
		});
		const llm = new ScriptedLLM([text("方案一结果"), text("方案二结果")]);
		setMockTransport(llm);

		const r = await engine.runFanout("any-win");
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.merge).toBe("first");
		// first 语义：返回单个成功结果（不是拼接）
		expect(r.output === "方案一结果" || r.output === "方案二结果").toBe(true);
		expect(r.output).not.toContain("### 方案师1");
	});

	test("不存在的 flow id → 错误", async () => {
		const r = await engine.runFanout("nope");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("不存在");
	});

	test("声明无效（无 tasks / merge 非法）→ load 返回 null", () => {
		writeFlow("bad1", { id: "bad1", tasks: [], merge: "all" });
		writeFlow("bad2", { id: "bad2", tasks: [{ task: "x" }], merge: "maybe" });
		writeFlow("bad3", "not json");
		expect(engine.load("bad1")).toBeNull();
		expect(engine.load("bad2")).toBeNull();
		expect(engine.load("bad3")).toBeNull();
	});

	test("list：只列 .json 声明文件", () => {
		writeFlow("ok-flow", {
			id: "ok-flow",
			tasks: [{ task: "x" }],
			merge: "all",
		});
		writeFileSync(`${FLOWS_DIR}/ignored.txt`, "x", "utf-8");
		const ids = engine.list();
		expect(ids).toContain("ok-flow");
		expect(ids).not.toContain("ignored.txt");
	});
});
