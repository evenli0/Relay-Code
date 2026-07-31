import { afterEach, describe, expect, test } from "bun:test";
import { AgentRegistry } from "../src/agent-registry";
import { FlowGate } from "../src/flow-gate";
import { Inbox } from "../src/inbox";
import { setMockTransport } from "../src/llm";
import { Orchestrator } from "../src/orchestrator";
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
});
