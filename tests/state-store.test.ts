import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { StateStore } from "../src/state-store";
import { ToolExecutor } from "../src/tool-executor";

const STATE_DIR = ".relay/state";

describe("StateStore（全局状态模型 L0）", () => {
	let store: StateStore;

	beforeEach(() => {
		store = new StateStore();
	});

	afterAll(() => {
		try {
			rmSync(STATE_DIR, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	test("state 事件增量合并（L0 结构化状态）", () => {
		store.ingest("demo-pusher", {
			kind: "state",
			updates: { topic: "agent 开发", mastered: 0.3 },
		});
		store.ingest("demo-pusher", {
			kind: "state",
			updates: { mastered: 0.6 },
		});
		expect(store.queryState("demo-pusher")).toEqual({
			topic: "agent 开发",
			mastered: 0.6,
		});
	});

	test("事件计数（silent 不打扰的摘要数据源：142 次无发现）", () => {
		for (let i = 0; i < 142; i++) {
			store.ingest("demo-watcher", {
				kind: "event",
				type: "scan.done",
				level: "silent",
				payload: { scanned: i },
				ts: i,
			});
		}
		expect(store.getEventCounts("demo-watcher", "scan.done")).toBe(142);
		expect(
			(store.getEventCounts("demo-watcher") as Record<string, number>)[
				"scan.done"
			],
		).toBe(142);
	});

	test("heartbeat 记录", () => {
		store.ingest("s1", { kind: "heartbeat", ts: 123 });
		expect(store.getL1Summary()).toContain("s1");
	});

	test("queryState 不带参数返回全部服务", () => {
		store.ingest("a", { kind: "state", updates: { x: 1 } });
		store.ingest("b", { kind: "state", updates: { y: 2 } });
		const all = store.queryState();
		expect(all).toHaveProperty("a");
		expect(all).toHaveProperty("b");
	});

	test("L1 摘要包含状态与事件计数", () => {
		store.ingest("demo-pusher", {
			kind: "state",
			updates: { mastered: 0.43 },
		});
		store.ingest("demo-watcher", {
			kind: "event",
			type: "scan.done",
			level: "silent",
			payload: {},
			ts: 1,
		});
		const summary = store.getL1Summary();
		expect(summary).toContain("demo-pusher");
		expect(summary).toContain("0.43");
		expect(summary).toContain("scan.done=1");
	});

	test("落盘与恢复（节点重启 ≠ 状态丢失）", async () => {
		store.ingest("persist-test", {
			kind: "state",
			updates: { mastered: 0.9 },
		});
		await new Promise((r) => setTimeout(r, 700)); // 等 debounce 落盘

		const store2 = new StateStore();
		expect(store2.restore()).toBeGreaterThanOrEqual(1);
		expect(store2.queryState("persist-test")).toEqual({ mastered: 0.9 });
	});
});

describe("query_state 工具（主 agent 的拉取式知晓）", () => {
	test("未接入 StateStore → 提示不可用", async () => {
		const ex = new ToolExecutor();
		const r = await ex.executeToolCall("query_state", {});
		expect(r).toContain("不可用");
	});

	test("接入后返回结构化状态", async () => {
		const store = new StateStore();
		store.ingest("demo-pusher", {
			kind: "state",
			updates: { topic: "agent 开发", mastered: 0.43 },
		});
		const ex = new ToolExecutor();
		ex.stateStore = store;

		const single = await ex.executeToolCall("query_state", {
			serviceId: "demo-pusher",
		});
		expect(single).toContain("0.43");

		const all = await ex.executeToolCall("query_state", {});
		expect(all).toContain("demo-pusher");
	});
});
