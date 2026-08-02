import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { appendAudit, queryAudit, toAuditEntry } from "../src/audit";
import type { ServiceEvent } from "../src/protocol";

const AUDIT_DIR = ".relay/events";

afterAll(() => {
	try {
		rmSync(AUDIT_DIR, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

describe("audit（事件审计落盘）", () => {
	beforeEach(() => {
		try {
			rmSync(AUDIT_DIR, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	test("append 后能按条件检索（serviceId/eventType/level 过滤）", () => {
		appendAudit({
			ts: 1,
			serviceId: "a",
			kind: "event",
			type: "scan.done",
			level: "silent",
		});
		appendAudit({
			ts: 2,
			serviceId: "a",
			kind: "event",
			type: "opportunity.found",
			level: "notify",
		});
		appendAudit({ ts: 3, serviceId: "b", kind: "heartbeat" });

		expect(queryAudit({ serviceId: "a" }).length).toBe(2);
		expect(queryAudit({ eventType: "scan.done" }).length).toBe(1);
		expect(queryAudit({ level: "notify" })[0]?.serviceId).toBe("a");
		expect(queryAudit({ serviceId: "b" })[0]?.kind).toBe("heartbeat");
	});

	test("检索结果倒序（最近优先）+ limit 截断", () => {
		for (let i = 0; i < 30; i++) {
			appendAudit({
				ts: i,
				serviceId: "a",
				kind: "event",
				type: "scan.done",
				level: "silent",
			});
		}
		const all = queryAudit({ limit: 100 });
		expect(all.length).toBe(30);
		expect(all[0]?.ts).toBe(29); // 倒序：最近在前
		const limited = queryAudit({ limit: 10 });
		expect(limited.length).toBe(10);
	});

	test("toAuditEntry：event 带 type/level/payload，其他 kind 只记 kind", () => {
		const ev: ServiceEvent = {
			kind: "event",
			type: "opportunity.found",
			level: "notify",
			payload: { confidence: 0.95 },
			ts: 42,
		};
		expect(toAuditEntry("demo-watcher", ev)).toEqual({
			ts: 42,
			serviceId: "demo-watcher",
			kind: "event",
			type: "opportunity.found",
			level: "notify",
			payload: { confidence: 0.95 },
		});

		const heartbeat: ServiceEvent = { kind: "heartbeat", ts: 7 };
		expect(toAuditEntry("demo-pusher", heartbeat)).toEqual({
			ts: 7,
			serviceId: "demo-pusher",
			kind: "heartbeat",
		});

		// 无 ts 的 kind（state）：用当前时间兜底
		const state: ServiceEvent = { kind: "state", updates: { x: 1 } };
		const entry = toAuditEntry("demo-pusher", state);
		expect(entry.kind).toBe("state");
		expect(typeof entry.ts).toBe("number");
	});
});
