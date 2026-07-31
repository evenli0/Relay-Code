import { afterEach, describe, expect, test } from "bun:test";
import { AgentRegistry } from "../src/agent-registry";
import { FlowGate } from "../src/flow-gate";
import { Inbox } from "../src/inbox";
import { setMockTransport } from "../src/llm";
import { Orchestrator } from "../src/orchestrator";
import type { SinkEvent } from "../src/sink";
import type { AgentEvent } from "../src/types";
import { ScriptedLLM, text } from "./helpers/mock-llm";

afterEach(() => setMockTransport(null));

function doneEvent(over: Partial<AgentEvent> = {}): AgentEvent {
	return {
		type: "agent_done",
		threadId: "t",
		timestamp: Date.now(),
		result: { status: "completed", output: "某结果" },
		agentRole: "研究员",
		agentId: "agent-abc",
		level: "info",
		eventType: "agent.done",
		...over,
	};
}

describe("Orchestrator 纯代码调度（LLM 卸任）", () => {
	test("agent_done 批处理不再调用 LLM", async () => {
		const inbox = new Inbox();
		const registry = new AgentRegistry();
		const orch = new Orchestrator(inbox, registry, "t", new FlowGate("show"));

		const llm = new ScriptedLLM([text("ok")]);
		setMockTransport(llm);

		// 预置 2 个 agent_done + runReAct 注入的用户消息
		inbox.push(doneEvent());
		inbox.push(doneEvent({ agentRole: "套利监控", agentId: "agent-xyz" }));
		await orch.runReAct("hi");

		// 批处理为纯代码（show/digest/notify），只有用户消息触发 1 次 LLM
		expect(llm.calls).toBe(1);
	});

	test("digest 事件静默归档并输出摘要（不占 LLM 上下文）", async () => {
		const inbox = new Inbox();
		const registry = new AgentRegistry();
		const orch = new Orchestrator(inbox, registry, "t", new FlowGate("digest"));

		const llm = new ScriptedLLM([text("ok")]);
		setMockTransport(llm);

		const origLog = console.log;
		const logs: string[] = [];
		console.log = (...args: unknown[]) => logs.push(args.join(" "));

		try {
			inbox.push(doneEvent());
			inbox.push(doneEvent());
			await orch.runReAct("hi");
		} finally {
			console.log = origLog;
		}

		expect(logs.some((l) => l.includes("已静默归档"))).toBe(true);
		expect(llm.calls).toBe(1); // 摘要合成是纯代码，不是 LLM
	});

	test("notify 动作走通知出口（sink notice）", async () => {
		const inbox = new Inbox();
		const registry = new AgentRegistry();
		const gate = new FlowGate("show", [
			{ match: { eventType: "agent.done" }, action: "notify" },
		]);
		const orch = new Orchestrator(inbox, registry, "t", gate);

		const notices: string[] = [];
		orch.setSink({
			emit(e: SinkEvent) {
				if (e.kind === "notice" && e.level === "notify") {
					notices.push(e.text);
				}
			},
		});

		const llm = new ScriptedLLM([text("ok")]);
		setMockTransport(llm);

		const origLog = console.log;
		console.log = () => {};
		try {
			inbox.push(doneEvent());
			await orch.runReAct("hi");
		} finally {
			console.log = origLog;
		}

		expect(notices.length).toBeGreaterThanOrEqual(1);
		expect(notices[0]).toContain("研究员");
	});

	test("服务事件分级：silent 吸收 / notify 走通知出口", async () => {
		const inbox = new Inbox();
		const registry = new AgentRegistry();
		const orch = new Orchestrator(inbox, registry, "t");

		const notices: string[] = [];
		orch.setSink({
			emit(e: SinkEvent) {
				if (e.kind === "notice" && e.level === "notify") {
					notices.push(e.text);
				}
			},
		});

		const origLog = console.log;
		const logs: string[] = [];
		console.log = (...a: unknown[]) => logs.push(a.join(" "));
		try {
			// silent → 吸收（无输出、无通知）
			orch.handleServiceEvent("demo-watcher", {
				kind: "event",
				type: "scan.done",
				level: "silent",
				payload: { scanned: 1 },
				ts: 1,
			});
			expect(logs.length).toBe(0);
			// notify → 通知出口
			orch.handleServiceEvent("demo-watcher", {
				kind: "event",
				type: "opportunity.found",
				level: "notify",
				payload: { confidence: 0.95 },
				ts: 2,
			});
		} finally {
			console.log = origLog;
		}

		expect(notices.length).toBe(1);
		expect(notices[0]).toContain("demo-watcher");
		expect(notices[0]).toContain("opportunity.found");
	});

	test("门控命中记录（建造者控制台）", async () => {
		const inbox = new Inbox();
		const registry = new AgentRegistry();
		const orch = new Orchestrator(inbox, registry, "t");

		// 服务事件：silent → digest
		orch.handleServiceEvent("demo-watcher", {
			kind: "event",
			type: "scan.done",
			level: "silent",
			payload: {},
			ts: 1,
		});
		// 服务事件：notify → notify
		orch.handleServiceEvent("demo-watcher", {
			kind: "event",
			type: "opportunity.found",
			level: "notify",
			payload: {},
			ts: 2,
		});

		const hits = orch.getGateHits();
		expect(hits.length).toBe(2);
		expect(hits[0]).toMatchObject({
			role: "demo-watcher",
			eventType: "scan.done",
			action: "digest",
		});
		expect(hits[1]).toMatchObject({
			eventType: "opportunity.found",
			action: "notify",
		});
	});

	test("服务事件规则可覆盖：用户 rule 让 notify 降级为 digest", async () => {
		const inbox = new Inbox();
		const registry = new AgentRegistry();
		const gate = new FlowGate("show");
		const orch = new Orchestrator(inbox, registry, "t", gate);
		orch.addGateRule({
			match: { eventType: "opportunity.found" },
			action: "digest",
		});

		const notices: string[] = [];
		orch.setSink({
			emit(e: SinkEvent) {
				if (e.kind === "notice" && e.level === "notify") {
					notices.push(e.text);
				}
			},
		});

		orch.handleServiceEvent("demo-watcher", {
			kind: "event",
			type: "opportunity.found",
			level: "notify",
			payload: { confidence: 0.95 },
			ts: 1,
		});
		expect(notices.length).toBe(0); // 规则覆盖：不通知
	});
});
