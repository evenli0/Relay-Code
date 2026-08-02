import { describe, expect, test } from "bun:test";
import { buildFlowManifest, validateFlowManifest } from "../src/flow-manifest";
import type { ServiceContract } from "../src/service-contract";

const pusher: ServiceContract = {
	id: "demo-pusher",
	version: "1.0.0",
	name: "Pusher",
	description: "推进型",
	archetype: "pusher",
	execution: "cron",
	entry: "services/demo-pusher/entry.ts",
	tools: [],
	capabilities: [],
	emits: ["state.reported"],
	consumes: [],
	schedule: { type: "interval", every: "30s" },
	permissions: {},
};

const watcher: ServiceContract = {
	id: "demo-watcher",
	version: "1.0.0",
	name: "Watcher",
	description: "监控型",
	archetype: "watcher",
	execution: "watch",
	entry: "services/demo-watcher/entry.ts",
	tools: [],
	capabilities: [],
	emits: ["scan.done", "opportunity.found"],
	consumes: ["schedule.tick"],
	disposition: {
		"scan.done": "defer",
		"opportunity.found": "immediate",
	},
	permissions: {},
};

describe("buildFlowManifest（编排收编层）", () => {
	test("契约集合生成事件处置表（契约声明 + 默认分级）", () => {
		const m = buildFlowManifest([pusher, watcher], []);
		// watcher 两个 emits：scan.done 契约声明 defer、opportunity.found 契约声明 immediate
		expect(m.events).toContainEqual({
			eventType: "scan.done",
			serviceId: "demo-watcher",
			disposition: "defer",
			source: "contract",
		});
		expect(m.events).toContainEqual({
			eventType: "opportunity.found",
			serviceId: "demo-watcher",
			disposition: "immediate",
			source: "contract",
		});
		// pusher 未声明 → default
		expect(m.events).toContainEqual({
			eventType: "state.reported",
			serviceId: "demo-pusher",
			disposition: "default",
			source: "default",
		});
	});

	test("路由图：consumes → 谁发出（pipe 原语视图）", () => {
		// 需要一个发 schedule.tick 的服务
		const ticker: ServiceContract = {
			...pusher,
			id: "ticker",
			emits: ["schedule.tick"],
		};
		const m = buildFlowManifest([ticker, watcher], []);
		expect(m.routes).toContainEqual({
			eventType: "schedule.tick",
			from: "ticker",
			to: ["demo-watcher"],
		});
	});

	test("节奏表：契约 schedule 收编", () => {
		const m = buildFlowManifest([pusher], []);
		expect(m.schedules).toEqual([
			{ serviceId: "demo-pusher", spec: { type: "interval", every: "30s" } },
		]);
	});

	test("用户规则覆盖契约声明（rule 来源）", () => {
		const m = buildFlowManifest(
			[watcher],
			[{ match: { eventType: "opportunity.found" }, action: "defer" }],
		);
		expect(m.events).toContainEqual({
			eventType: "opportunity.found",
			serviceId: "demo-watcher",
			disposition: "defer",
			source: "rule",
		});
	});
});

describe("validateFlowManifest（静态交叉校验）", () => {
	test("正常集群无错误无警告", () => {
		const m = buildFlowManifest([pusher, watcher], []);
		const v = validateFlowManifest(m, [pusher, watcher]);
		expect(v.errors).toEqual([]);
		expect(v.warnings).toEqual([]);
	});

	test("规则引用无源事件 → warning（断链或预声明）", () => {
		const m = buildFlowManifest(
			[watcher],
			[{ match: { eventType: "ghost.event" }, action: "notify" }],
		);
		const v = validateFlowManifest(m, [watcher]);
		expect(v.errors).toEqual([]);
		expect(v.warnings.some((w) => w.includes("ghost.event"))).toBe(true);
	});

	test("路由指向不存在服务 → error", () => {
		// 手工构造断链 manifest：watcher consumes 的事件由 ghost 发出
		const ghost: ServiceContract = {
			...pusher,
			id: "ghost",
			emits: ["schedule.tick"],
		};
		const m = buildFlowManifest([ghost, watcher], []);
		// 移除 ghost → 断链
		const broken = { ...m, services: ["demo-watcher"], routes: m.routes };
		const v = validateFlowManifest(broken, [watcher]);
		expect(v.errors.some((e) => e.includes("不存在"))).toBe(true);
	});

	test("契约处置声明引用无源事件 → warning", () => {
		const c: ServiceContract = {
			...watcher,
			disposition: { "ghost.event": "notify" },
		};
		const m = buildFlowManifest([c], []);
		const v = validateFlowManifest(m, [c]);
		expect(v.warnings.some((w) => w.includes("ghost.event"))).toBe(true);
	});
});
