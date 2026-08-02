import { describe, expect, test } from "bun:test";
import {
	decodeServiceCommand,
	decodeServiceEvent,
	encodeServiceCommand,
	encodeServiceEvent,
	type ServiceCommand,
	type ServiceEvent,
} from "../src/protocol";

describe("protocol round-trip", () => {
	const events: ServiceEvent[] = [
		{ kind: "ready", ts: 123 },
		{ kind: "heartbeat", ts: 456 },
		{ kind: "state", updates: { topic: "x", mastered: 0.6 } },
		{
			kind: "event",
			type: "interaction.summary",
			level: "info",
			payload: { from: "human", question: "hello", at: 1 },
			ts: 2,
		},
		{
			kind: "event",
			type: "opportunity.found",
			level: "notify",
			payload: { confidence: 0.95 },
			intent: "immediate", // 处置意图：服务进程表达"请立即处理"
			ts: 3,
		},
		{
			kind: "event",
			type: "scan.done",
			level: "silent",
			payload: { scanned: 1 },
			intent: "defer", // 处置意图：只积攒
			ts: 4,
		},
		{ kind: "progress", round: 1, action: "read", summary: "reading" },
		{ kind: "result", taskId: "t1", status: "completed", output: "ok" },
		{ kind: "result", taskId: "t2", status: "error", output: "boom" },
		{ kind: "reply", requestId: "a1", content: "你好" },
		{ kind: "request", requestId: "r1", to: "svc-2", content: "帮我验证" },
	];

	test("ServiceEvent 每种 kind round-trip", () => {
		for (const e of events) {
			expect(decodeServiceEvent(encodeServiceEvent(e))).toEqual(e);
		}
	});

	const commands: ServiceCommand[] = [
		{ kind: "task", taskId: "t1", content: "do x" },
		{ kind: "ask", requestId: "a1", content: "q", from: "human" },
		{ kind: "ask", requestId: "a2", content: "q2" },
		{ kind: "configure", tools: ["read"], version: 2 },
		{ kind: "event", type: "context.update", payload: { a: 1 } },
		{ kind: "schedule", spec: { type: "interval", every: "6h" } },
		{ kind: "shutdown", reason: "bye" },
	];

	test("ServiceCommand 每种 kind round-trip", () => {
		for (const c of commands) {
			expect(decodeServiceCommand(encodeServiceCommand(c))).toEqual(c);
		}
	});

	test("坏行返回 null 不抛异常", () => {
		expect(decodeServiceEvent("")).toBeNull();
		expect(decodeServiceEvent("not json")).toBeNull();
		expect(decodeServiceEvent('{"kind":"unknown_kind"}')).toBeNull();
		expect(decodeServiceEvent('{"kind":123}')).toBeNull();
		expect(decodeServiceEvent("   \n")).toBeNull();
		expect(decodeServiceCommand("garbage")).toBeNull();
		expect(decodeServiceCommand('{"kind":"bogus"}')).toBeNull();
		expect(decodeServiceCommand('{"kind":"result"}')).toBeNull(); // 上行事件不能当下行指令
	});
});
