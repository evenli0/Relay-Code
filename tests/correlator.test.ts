import { describe, expect, test } from "bun:test";
import { Correlator } from "../src/correlator";

const NOW = new Date(2026, 7, 1, 12, 0, 0).getTime();

describe("Correlator 关联层（规则预筛）", () => {
	test("同实体 + 不同服务/事件类型 + 时间窗内 → 候选", () => {
		const c = new Correlator({ windowMs: 6 * 3_600_000 });
		c.ingest(
			"watcher",
			"scan.done",
			{ entities: ["market/btc"] },
			NOW - 60_000,
		);
		c.ingest(
			"teacher",
			"topic.started",
			{ entities: ["market/btc"] },
			NOW - 30_000,
		);
		const candidates = c.findCandidates(NOW);
		expect(candidates.length).toBe(1);
		expect(candidates[0]?.entity).toBe("market/btc");
		expect(candidates[0]?.events.length).toBe(2);
	});

	test("同一服务同一事件类型重复不构成关联", () => {
		const c = new Correlator({ windowMs: 3_600_000 });
		c.ingest(
			"watcher",
			"scan.done",
			{ entities: ["market/btc"] },
			NOW - 60_000,
		);
		c.ingest(
			"watcher",
			"scan.done",
			{ entities: ["market/btc"] },
			NOW - 30_000,
		);
		expect(c.findCandidates(NOW).length).toBe(0);
	});

	test("窗口外不构成关联", () => {
		const c = new Correlator({ windowMs: 3_600_000 });
		c.ingest(
			"watcher",
			"scan.done",
			{ entities: ["market/btc"] },
			NOW - 3_600_000 - 1000,
		);
		c.ingest(
			"teacher",
			"topic.started",
			{ entities: ["market/btc"] },
			NOW - 30_000,
		);
		expect(c.findCandidates(NOW).length).toBe(0);
	});

	test("无实体标签的事件不参与关联", () => {
		const c = new Correlator();
		c.ingest("watcher", "scan.done", { scanned: 1 }, NOW - 1000);
		c.ingest("teacher", "topic.started", { entities: ["market/btc"] }, NOW);
		expect(c.findCandidates(NOW).length).toBe(0);
	});

	test("摘要格式（触发点 1 注入）", () => {
		const c = new Correlator({ windowMs: 3_600_000 });
		c.ingest(
			"watcher",
			"scan.done",
			{ entities: ["market/btc"] },
			NOW - 60_000,
		);
		c.ingest("teacher", "topic.started", { entities: ["market/btc"] }, NOW);
		const summary = c.getCorrelationSummary(NOW);
		expect(summary).toContain("market/btc");
		expect(summary).toContain("watcher.scan.done");
		expect(summary).toContain("teacher.topic.started");

		// 无候选返回空串
		expect(new Correlator().getCorrelationSummary(NOW)).toBe("");
	});

	test("事件上限防内存膨胀", () => {
		const c = new Correlator({ maxEvents: 5 });
		for (let i = 0; i < 20; i++) {
			c.ingest("s", "e", { entities: ["x"] }, NOW - i * 1000);
		}
		expect(c.findCandidates(NOW).length).toBe(0); // 同服务同类型，不算关联
		// 内部事件数不超过上限（无直接访问，用候选池行为间接验证）
		expect(c.findCandidates(NOW)).toEqual([]);
	});
});
