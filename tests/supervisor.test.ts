import { describe, expect, test } from "bun:test";
import { Scheduler } from "../src/scheduler";
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

	test("sync 热加载：新增启动、移除停止", async () => {
		const s = makeSupervisor();
		const dir = ".relay/test-services";
		const { mkdirSync, rmSync, writeFileSync } = await import("node:fs");
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
		mkdirSync(`${dir}/sync-svc`, { recursive: true });
		writeFileSync(
			`${dir}/sync-svc/service.json`,
			JSON.stringify(
				{
					id: "sync-svc",
					version: "1.0.0",
					name: "sync",
					description: "sync 测试",
					archetype: "watcher",
					execution: "watch",
					entry: "tests/fixtures/fake-service.ts",
					tools: [],
					capabilities: [],
					emits: [],
					consumes: [],
					permissions: {},
				},
				null,
				2,
			),
			"utf-8",
		);

		// 新增 → 启动
		const r1 = s.sync(dir);
		expect(r1.started).toContain("sync-svc");
		expect(s.getStatus("sync-svc")?.status).toBe("running");

		// 移除 → 停止
		try {
			rmSync(`${dir}/sync-svc`, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
		const r2 = s.sync(dir);
		expect(r2.stopped).toContain("sync-svc");
		expect(s.getStatus("sync-svc")?.status).toBe("stopped");
		s.stopAll();
	});

	test("契约 schedule → Scheduler 到点向节点发 schedule 指令", async () => {
		const received: unknown[] = [];
		const scheduler = new Scheduler({ tickMs: 50, logger: () => {} });
		const s = new Supervisor({
			heartbeatTimeoutMs: 1200,
			maxConsecutiveFailures: 3,
			watchdogIntervalMs: 150,
			backoffBaseMs: 50,
			logger: () => {},
			scheduler,
		});
		s.onNodeEvent = (_id, msg) => {
			if (msg.kind === "event" && msg.type === "schedule.received") {
				received.push(msg.payload);
			}
		};
		const contract = base("sched");
		contract.schedule = { type: "interval", every: "150ms" };
		s.start(contract, { fixtureMode: "schedule-log" } as never);
		await sleep(700);
		expect(received.length).toBeGreaterThanOrEqual(1);
		s.stopAll();
		scheduler.stopAll();
	});
});
