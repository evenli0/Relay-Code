import { describe, expect, test } from "bun:test";
import { FlowGate } from "../src/flow-gate";
import type { AgentEvent } from "../src/types";

function ev(partial: Partial<AgentEvent>): AgentEvent {
	return { type: "agent_done", threadId: "t", timestamp: 1, ...partial };
}

describe("FlowGate", () => {
	test("默认动作兜底", () => {
		const g = new FlowGate("show");
		expect(g.decide(ev({}))).toBe("show");
		const g2 = new FlowGate("digest");
		expect(g2.decide(ev({}))).toBe("digest");
	});

	test("规则匹配 level", () => {
		const g = new FlowGate("show", [
			{ match: { level: "notify" }, action: "notify" },
		]);
		expect(g.decide(ev({ level: "notify" }))).toBe("notify");
		expect(g.decide(ev({ level: "info" }))).toBe("show");
		expect(g.decide(ev({}))).toBe("show"); // 无 level 不匹配 level 规则
	});

	test("规则匹配 eventType + agentRole", () => {
		const g = new FlowGate("show", [
			{ match: { eventType: "agent.error" }, action: "notify" },
			{ match: { agentRole: "watcher" }, action: "digest" },
		]);
		expect(g.decide(ev({ eventType: "agent.error" }))).toBe("notify");
		expect(g.decide(ev({ agentRole: "watcher" }))).toBe("digest");
		expect(g.decide(ev({}))).toBe("show");
	});

	test("多条件规则须全部满足", () => {
		const g = new FlowGate("show", [
			{
				match: { level: "notify", eventType: "agent.error", agentRole: "x" },
				action: "drop",
			},
		]);
		expect(
			g.decide(
				ev({ level: "notify", eventType: "agent.error", agentRole: "x" }),
			),
		).toBe("drop");
		expect(g.decide(ev({ level: "notify", eventType: "agent.error" }))).toBe(
			"show",
		);
	});

	test("addRule 新规则最高优先级", () => {
		const g = new FlowGate("show", [
			{ match: { level: "notify" }, action: "notify" },
		]);
		g.addRule({ match: { agentRole: "watcher" }, action: "drop" });
		expect(g.decide(ev({ level: "notify", agentRole: "watcher" }))).toBe(
			"drop",
		);
	});
});
