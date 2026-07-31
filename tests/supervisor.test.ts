import { describe, expect, test } from "bun:test";
import type { ServiceContract } from "../src/service-contract";
import { Supervisor } from "../src/supervisor";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function base(id: string): ServiceContract {
	return {
		id,
		version: "1.0.0",
		name: `fake-${id}`,
		description: "supervisor 测试服务",
		archetype: "watcher",
		execution: "watch",
		entry: "tests/fixtures/fake-service.ts",
		tools: [],
		capabilities: [],
		emits: [],
		consumes: [],
		permissions: {},
	};
}

function makeSupervisor() {
	return new Supervisor({
		heartbeatTimeoutMs: 1200,
		maxConsecutiveFailures: 3,
		watchdogIntervalMs: 150,
		backoffBaseMs: 50,
		logger: () => {},
	});
}

describe("Supervisor", () => {
	test("正常存活：不发心跳超时、不重启", async () => {
		const s = makeSupervisor();
		s.start(base("live"), { fixtureMode: "live" } as never);
		await sleep(1200);
		const st = s.getStatus("live");
		expect(st?.status).toBe("running");
		expect(st?.restartCount).toBe(0);
		s.stopAll();
	});

	test("意外退出后自动重启（die）", async () => {
		const s = makeSupervisor();
		s.start(base("die"), { fixtureMode: "die" } as never);
		await sleep(3500);
		const st = s.getStatus("die");
		expect(st?.restartCount).toBeGreaterThanOrEqual(1);
		expect(st?.status).toBe("running");
		s.stopAll();
	});

	test("心跳僵死检测（stale：发 2 次后沉默 → kill 重启）", async () => {
		const s = makeSupervisor();
		s.start(base("stale"), { fixtureMode: "stale" } as never);
		await sleep(3500);
		const st = s.getStatus("stale");
		expect(st?.restartCount).toBeGreaterThanOrEqual(1);
		s.stopAll();
	});

	test("连续失败超限标记 error（crash）", async () => {
		const s = makeSupervisor();
		s.start(base("crash"), { fixtureMode: "crash" } as never);
		await sleep(1500);
		expect(s.getStatus("crash")?.status).toBe("error");
		s.stopAll();
	});

	test("主动停止不重启", async () => {
		const s = makeSupervisor();
		s.start(base("live2"), { fixtureMode: "live" } as never);
		await sleep(600);
		s.stop("live2", "test");
		await sleep(1500);
		const st = s.getStatus("live2");
		expect(st?.status).toBe("stopped");
		expect(st?.restartCount).toBe(0);
		s.stopAll();
	});
});
