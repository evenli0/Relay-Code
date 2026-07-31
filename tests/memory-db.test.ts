import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { MemoryDb } from "../src/memory-db";

const DB_PATH = ".relay/memory.db";

afterAll(() => {
	try {
		rmSync(DB_PATH, { force: true });
	} catch {
		/* ignore */
	}
});

describe("MemoryDb（bun:sqlite 结构化记忆库）", () => {
	test("对话日志写入与查询（按服务过滤）", () => {
		const db = new MemoryDb(DB_PATH);
		db.logDialogue("user", "今天学到哪了", "main");
		db.logDialogue("assistant", "学完了 agent 编排", "main");
		db.logDialogue("system", "扫描完成", "demo-watcher");

		const all = db.queryDialogue({ limit: 10 });
		expect(all.length).toBeGreaterThanOrEqual(3);

		const watcher = db.queryDialogue({ service: "demo-watcher" });
		expect(watcher.length).toBe(1);
		expect(watcher[0]?.content).toBe("扫描完成");

		db.close();
	});

	test("事实库 set/get/更新（源信誉等跨服务事实）", () => {
		const db = new MemoryDb(DB_PATH);
		expect(db.getFact("source.bilibili.reliability")).toBeNull();
		db.setFact("source.bilibili.reliability", "high");
		expect(db.getFact("source.bilibili.reliability")).toBe("high");
		db.setFact("source.bilibili.reliability", "medium"); // 更新
		expect(db.getFact("source.bilibili.reliability")).toBe("medium");
		db.close();
	});

	test("状态历史记录与查询（效率曲线数据源）", () => {
		const db = new MemoryDb(DB_PATH);
		db.recordState("demo-pusher", JSON.stringify({ mastered: 0.3 }));
		db.recordState("demo-pusher", JSON.stringify({ mastered: 0.6 }));
		const rows = db.recentStates("demo-pusher", 5);
		expect(rows.length).toBe(2);
		expect(rows[0]?.snapshot).toContain("0.6"); // 最新在前
		db.close();
	});
});
