import { afterEach, describe, expect, test } from "bun:test";
import { AgentRegistry } from "../src/agent-registry";
import { FlowGate } from "../src/flow-gate";
import { Inbox } from "../src/inbox";
import { setMockTransport } from "../src/llm";
import { Orchestrator } from "../src/orchestrator";
import type { ServiceEvent } from "../src/protocol";
import type { SinkEvent } from "../src/sink";
import { StateStore } from "../src/state-store";
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
		const orch = new Orchestrator(inbox, registry, "t", new FlowGate());

		const llm = new ScriptedLLM([text("ok")]);
		setMockTransport(llm);

		// 预置 2 个 agent_done + runReAct 注入的用户消息
		inbox.push(doneEvent());
		inbox.push(doneEvent({ agentRole: "套利监控", agentId: "agent-xyz" }));
		await orch.runReAct("hi");

		// 批处理为纯代码（show/digest/notify），只有用户消息触发 1 次 LLM
		expect(llm.calls).toBe(1);
	});

	test("defer 事件静默归档并输出摘要（不占 LLM 上下文）", async () => {
		const inbox = new Inbox();
		const registry = new AgentRegistry();
		const orch = new Orchestrator(inbox, registry, "t", new FlowGate("defer"));

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
		const gate = new FlowGate(undefined, [
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
			action: "defer",
		});
		expect(hits[1]).toMatchObject({
			eventType: "opportunity.found",
			action: "notify",
		});
	});

	test("服务事件规则可覆盖：用户 rule 让 notify 降级为 defer", async () => {
		const inbox = new Inbox();
		const registry = new AgentRegistry();
		const gate = new FlowGate();
		const orch = new Orchestrator(inbox, registry, "t", gate);
		orch.addGateRule({
			match: { eventType: "opportunity.found" },
			action: "defer",
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

describe("唤醒通道（immediate 事件 → 大脑）", () => {
	function immediateEvent(ts: number): ServiceEvent {
		return {
			kind: "event",
			type: "opportunity.found",
			level: "notify",
			payload: { confidence: 0.95 },
			intent: "immediate", // 服务进程声明：请立即处理
			ts,
		};
	}

	test("immediate 事件唤醒大脑一次，唤醒消息带事件与全景", async () => {
		const inbox = new Inbox();
		const registry = new AgentRegistry();
		const stateStore = new StateStore();
		const orch = new Orchestrator(inbox, registry, "t", undefined, stateStore);
		orch.setWakeupCooldown(0);
		const llm = new ScriptedLLM([text("已评估：机会属实，建议告知用户")]);
		setMockTransport(llm);

		// 模拟 daemon 接线：事件先 ingest（进后台池），再进处置决策
		const ev = immediateEvent(1);
		stateStore.ingest("demo-watcher", ev);
		orch.handleServiceEvent("demo-watcher", ev);

		await orch.processWakeups();
		expect(llm.calls).toBe(1);
		const wakeMessages = JSON.stringify(llm.callMessages[0]);
		expect(wakeMessages).toContain("opportunity.found"); // 事件本身
		expect(wakeMessages).toContain("后台上下文"); // 全景积累
	});

	test("节流：冷却窗口内到达的事件排队不丢，冷却过后合并唤醒", async () => {
		const inbox = new Inbox();
		const registry = new AgentRegistry();
		const stateStore = new StateStore();
		const orch = new Orchestrator(inbox, registry, "t", undefined, stateStore);
		orch.setWakeupCooldown(60_000); // 长冷却
		const llm = new ScriptedLLM([text("ok")]);
		setMockTransport(llm);

		for (let i = 0; i < 3; i++) {
			const ev = immediateEvent(i);
			stateStore.ingest("demo-watcher", ev);
			orch.handleServiceEvent("demo-watcher", ev);
		}

		await orch.processWakeups(); // 第一次：唤醒，处理当前全部
		expect(llm.calls).toBe(1);
		expect(orch.getPendingWakeups()).toBe(0);

		// 冷却窗口内新来 2 条：排队不丢，不唤醒
		for (let i = 3; i < 5; i++) {
			const ev = immediateEvent(i);
			stateStore.ingest("demo-watcher", ev);
			orch.handleServiceEvent("demo-watcher", ev);
		}
		await orch.processWakeups(); // 冷却内：不唤醒
		expect(llm.calls).toBe(1);
		expect(orch.getPendingWakeups()).toBe(2); // 排队保留

		orch.setWakeupCooldown(0); // 冷却过后：合并唤醒剩余
		await orch.processWakeups();
		expect(llm.calls).toBe(2);
		expect(orch.getPendingWakeups()).toBe(0);
	});

	test("用户规则覆盖：immediate 事件可被规则降级为 defer（不唤醒）", async () => {
		const inbox = new Inbox();
		const registry = new AgentRegistry();
		const stateStore = new StateStore();
		const orch = new Orchestrator(inbox, registry, "t", undefined, stateStore);
		orch.setWakeupCooldown(0);
		orch.addGateRule({
			match: { eventType: "opportunity.found" },
			action: "defer", // 用户：这类别唤醒大脑
		});
		const llm = new ScriptedLLM([text("ok")]);
		setMockTransport(llm);

		const ev = immediateEvent(1);
		stateStore.ingest("demo-watcher", ev);
		orch.handleServiceEvent("demo-watcher", ev);

		expect(orch.getPendingWakeups()).toBe(0); // 规则覆盖：不进唤醒队列
		expect(llm.calls).toBe(0);
	});

	test("契约声明 immediate（declaredContract）同样唤醒", async () => {
		const inbox = new Inbox();
		const registry = new AgentRegistry();
		const stateStore = new StateStore();
		const orch = new Orchestrator(inbox, registry, "t", undefined, stateStore);
		orch.setWakeupCooldown(0);
		const llm = new ScriptedLLM([text("ok")]);
		setMockTransport(llm);

		const ev: ServiceEvent = {
			kind: "event",
			type: "opportunity.found",
			level: "notify",
			payload: { confidence: 0.95 },
			ts: 1,
		};
		stateStore.ingest("demo-watcher", ev);
		// 事件未声明 intent，契约声明 immediate（Supervisor.getContractDisposition 传入）
		orch.handleServiceEvent("demo-watcher", ev, "immediate");

		await orch.processWakeups();
		expect(llm.calls).toBe(1);
	});
});
