import { describe, expect, test } from "bun:test";
import {
	nextCronTime,
	parseCron,
	parseInterval,
	Scheduler,
} from "../src/scheduler";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("parseInterval", () => {
	test("各单位解析", () => {
		expect(parseInterval("500ms")).toBe(500);
		expect(parseInterval("90s")).toBe(90_000);
		expect(parseInterval("30m")).toBe(1_800_000);
		expect(parseInterval("6h")).toBe(21_600_000);
		expect(parseInterval("1d")).toBe(86_400_000);
	});

	test("非法输入返回 null", () => {
		expect(parseInterval("abc")).toBeNull();
		expect(parseInterval("10")).toBeNull();
		expect(parseInterval("")).toBeNull();
	});
});

describe("parseCron / nextCronTime", () => {
	test("合法每天分时表达式", () => {
		expect(parseCron("0 9 * * *")).toEqual({ minute: 0, hour: 9 });
		expect(parseCron("30 8 * * *")).toEqual({ minute: 30, hour: 8 });
	});

	test("非法表达式", () => {
		expect(parseCron("0 9")).toBeNull();
		expect(parseCron("0 9 1 * *")).toBeNull(); // 最小支持：每天
		expect(parseCron("60 9 * * *")).toBeNull();
		expect(parseCron("0 24 * * *")).toBeNull();
	});

	test("nextCronTime 计算下一次触发", () => {
		const now = new Date(2026, 7, 1, 10, 30, 0).getTime();
		// 已过 → 明天
		expect(nextCronTime("0 9 * * *", now)).toBe(
			new Date(2026, 7, 2, 9, 0, 0).getTime(),
		);
		expect(nextCronTime("0 10 * * *", now)).toBe(
			new Date(2026, 7, 2, 10, 0, 0).getTime(),
		);
		// 未到 → 今天
		expect(nextCronTime("0 11 * * *", now)).toBe(
			new Date(2026, 7, 1, 11, 0, 0).getTime(),
		);
		expect(nextCronTime("bad", now)).toBe(-1);
	});
});

describe("Scheduler 触发", () => {
	test("interval 重复触发", async () => {
		const s = new Scheduler({ tickMs: 30, logger: () => {} });
		let fires = 0;
		s.register("a", { type: "interval", every: "100ms" }, () => fires++);
		await sleep(350);
		expect(fires).toBeGreaterThanOrEqual(2);
		s.stopAll();
	});

	test("at 一次性触发后移除", async () => {
		const s = new Scheduler({ tickMs: 30, logger: () => {} });
		let fires = 0;
		s.register("b", { type: "at", ts: Date.now() + 100 }, () => fires++);
		await sleep(250);
		expect(fires).toBe(1);
		expect(s.size).toBe(0);
		s.stopAll();
	});

	test("无效节奏不注册", () => {
		const s = new Scheduler({ tickMs: 30, logger: () => {} });
		s.register("c", { type: "interval", every: "abc" }, () => {});
		expect(s.size).toBe(0);
		s.stopAll();
	});

	test("unregister 停止触发", async () => {
		const s = new Scheduler({ tickMs: 30, logger: () => {} });
		let fires = 0;
		s.register("d", { type: "interval", every: "80ms" }, () => fires++);
		await sleep(200);
		s.unregister("d");
		const after = fires;
		await sleep(200);
		expect(fires).toBe(after);
		s.stopAll();
	});
});
