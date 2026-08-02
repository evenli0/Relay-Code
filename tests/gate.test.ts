import { describe, expect, test } from "bun:test";
import {
	defaultForLevel,
	FlowGate,
	intentToDisposition,
	matchesTime,
	normalizeDisposition,
} from "../src/flow-gate";
import type { AgentEvent } from "../src/types";

function ev(partial: Partial<AgentEvent>): AgentEvent {
	return { type: "agent_done", threadId: "t", timestamp: 1, ...partial };
}

describe("FlowGate（处置决策器）", () => {
	test("默认分级：silent→defer / notify→notify / critical→immediate", () => {
		expect(defaultForLevel("silent")).toBe("defer");
		expect(defaultForLevel("trace")).toBe("defer");
		expect(defaultForLevel("info")).toBe("notify");
		expect(defaultForLevel("notify")).toBe("notify");
		expect(defaultForLevel("critical")).toBe("immediate");
		expect(defaultForLevel(undefined)).toBe("notify");
	});

	test("无规则无声明 → 默认分级（默认不打扰，该响的闹钟会响）", () => {
		const g = new FlowGate();
		expect(g.decide(ev({ level: "silent" }))).toBe("defer");
		expect(g.decide(ev({ level: "notify" }))).toBe("notify");
		expect(g.decide(ev({ level: "critical" }))).toBe("immediate");
	});

	test("服务声明（declared）优先于默认分级，规则优先于声明", () => {
		const g = new FlowGate();
		// 声明立即 → immediate（即使级别是 silent）
		expect(g.decide(ev({ level: "silent" }), "immediate")).toBe("immediate");
		// 用户规则覆盖声明
		g.addRule({ match: { eventType: "x" }, action: "defer" });
		expect(g.decide(ev({ eventType: "x", level: "notify" }), "immediate")).toBe(
			"defer",
		);
	});

	test("构造默认值兜底（显式 defaultAction 覆盖级别分级）", () => {
		const g = new FlowGate("defer");
		expect(g.decide(ev({ level: "notify" }))).toBe("defer");
	});

	test("规则匹配 level", () => {
		const g = new FlowGate(undefined, [
			{ match: { level: "notify" }, action: "notify" },
		]);
		expect(g.decide(ev({ level: "notify" }))).toBe("notify");
		expect(g.decide(ev({ level: "info" }))).toBe("notify"); // 默认分级
		expect(g.decide(ev({}))).toBe("notify"); // 无 level 不匹配 level 规则
	});

	test("规则匹配 eventType + agentRole", () => {
		const g = new FlowGate(undefined, [
			{ match: { eventType: "agent.error" }, action: "immediate" },
			{ match: { agentRole: "watcher" }, action: "defer" },
		]);
		expect(g.decide(ev({ eventType: "agent.error" }))).toBe("immediate");
		expect(g.decide(ev({ agentRole: "watcher" }))).toBe("defer");
		expect(g.decide(ev({}))).toBe("notify");
	});

	test("多条件规则须全部满足", () => {
		const g = new FlowGate(undefined, [
			{
				match: { level: "notify", eventType: "agent.error", agentRole: "x" },
				action: "archive",
			},
		]);
		expect(
			g.decide(
				ev({ level: "notify", eventType: "agent.error", agentRole: "x" }),
			),
		).toBe("archive");
		expect(g.decide(ev({ level: "notify", eventType: "agent.error" }))).toBe(
			"notify",
		);
	});

	test("时段匹配（matchesTime 纯函数）", () => {
		expect(matchesTime(0, 24, 12)).toBe(true); // 全天
		expect(matchesTime(9, 17, 10)).toBe(true); // 工作时段内
		expect(matchesTime(9, 17, 8)).toBe(false); // 时段外
		expect(matchesTime(22, 6, 23)).toBe(true); // 跨午夜
		expect(matchesTime(22, 6, 2)).toBe(true);
		expect(matchesTime(22, 6, 12)).toBe(false);
		expect(matchesTime(9, 9, 9)).toBe(false); // 空区间永不匹配
	});

	test("时段规则参与 decide（当前小时）", () => {
		const h = new Date().getHours();
		const g = new FlowGate(undefined, [
			{ match: { time: { from: 0, to: 24 } }, action: "immediate" },
		]);
		expect(g.decide(ev({}))).toBe("immediate");
		expect(h).toBeGreaterThanOrEqual(0); // 当前小时存在
	});

	test("addRule 新规则最高优先级", () => {
		const g = new FlowGate(undefined, [
			{ match: { level: "notify" }, action: "notify" },
		]);
		g.addRule({ match: { agentRole: "watcher" }, action: "archive" });
		expect(g.decide(ev({ level: "notify", agentRole: "watcher" }))).toBe(
			"archive",
		);
	});
});

describe("normalizeDisposition（旧规则文件兼容）", () => {
	test("新值原样通过", () => {
		expect(normalizeDisposition("immediate")).toBe("immediate");
		expect(normalizeDisposition("defer")).toBe("defer");
		expect(normalizeDisposition("notify")).toBe("notify");
		expect(normalizeDisposition("archive")).toBe("archive");
	});

	test("旧值映射：show→notify / digest→defer / drop→archive", () => {
		expect(normalizeDisposition("show")).toBe("notify");
		expect(normalizeDisposition("digest")).toBe("defer");
		expect(normalizeDisposition("drop")).toBe("archive");
	});

	test("未知值返回 null", () => {
		expect(normalizeDisposition("boom")).toBeNull();
	});
});

describe("intentToDisposition（服务进程的处置意图）", () => {
	test("immediate / defer 映射，未声明返回 undefined", () => {
		expect(intentToDisposition("immediate")).toBe("immediate");
		expect(intentToDisposition("defer")).toBe("defer");
		expect(intentToDisposition(undefined)).toBeUndefined();
	});
});
