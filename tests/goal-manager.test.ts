import { describe, expect, test } from "bun:test";
import { GoalManager } from "../src/goal-manager";

describe("GoalManager 目标维度模型", () => {
	test("维度进度由服务 state 自报聚合", () => {
		const gm = new GoalManager();
		gm.createGoal("job-hunt", "求职");
		gm.addDimension("job-hunt", {
			id: "fundamentals",
			label: "基础理论",
			services: ["teacher-basic"],
			progress: {},
			lastActivity: 0,
			lastReview: 0,
		});

		gm.updateProgress("teacher-basic", { mastered: 0.3, level: 2 });
		gm.updateProgress("teacher-basic", { mastered: 0.6 });

		const dim = gm.getGoals()[0]?.dimensions[0];
		expect(dim?.progress["mastered"]).toBe(0.6);
		expect(dim?.progress["level"]).toBe(2);
		expect(dim?.lastActivity).toBeGreaterThan(0);
	});

	test("无关服务的 state 不污染维度", () => {
		const gm = new GoalManager();
		gm.createGoal("g");
		gm.addDimension("g", {
			id: "d",
			label: "d",
			services: ["svc-a"],
			progress: {},
			lastActivity: 0,
			lastReview: 0,
		});
		gm.updateProgress("svc-b", { mastered: 0.9 });
		expect(
			gm.getGoals()[0]?.dimensions[0]?.progress["mastered"],
		).toBeUndefined();
	});
});

describe("GoalManager 效率曲线", () => {
	test("基线建立后，下降超阈值触发一次回调", () => {
		const drops: {
			serviceId: string;
			drop: number;
			current: number;
			baseline: number;
		}[] = [];
		const gm = new GoalManager({
			windowSize: 20,
			efficiencyDropThreshold: 0.4,
			onEfficiencyDrop: (serviceId, drop, current, baseline) =>
				drops.push({ serviceId, drop, current, baseline }),
		});

		// 基线：前 5 个样本建立
		for (let i = 0; i < 10; i++) gm.recordPerformance("teacher-basic", 10);
		expect(gm.getEfficiency("teacher-basic").baseline).toBe(10);

		// 效率下降：20 个低分把窗口（size 20）填满 → 当前均值 5，下降 50%
		for (let i = 0; i < 20; i++) gm.recordPerformance("teacher-basic", 5);
		expect(drops.length).toBe(1); // 只在转换沿触发一次
		expect(drops[0]?.serviceId).toBe("teacher-basic");
		expect(drops[0]?.drop).toBeGreaterThanOrEqual(0.4);

		// 持续低分不重复报警
		gm.recordPerformance("teacher-basic", 5);
		expect(drops.length).toBe(1);

		// 恢复后再次下降 → 再触发
		for (let i = 0; i < 20; i++) gm.recordPerformance("teacher-basic", 10);
		for (let i = 0; i < 20; i++) gm.recordPerformance("teacher-basic", 5);
		expect(drops.length).toBe(2);
	});

	test("样本不足不触发（无基线）", () => {
		let fired = 0;
		const gm = new GoalManager({
			onEfficiencyDrop: () => fired++,
		});
		gm.recordPerformance("s", 1);
		gm.recordPerformance("s", 1);
		expect(fired).toBe(0);
		expect(gm.getEfficiency("s").baseline).toBeNull();
	});

	test("窗口滑动：只统计最近 N 个样本", () => {
		const gm = new GoalManager({ windowSize: 3 });
		gm.recordPerformance("s", 10);
		gm.recordPerformance("s", 10);
		gm.recordPerformance("s", 10); // 基线 = 10
		gm.recordPerformance("s", 0);
		gm.recordPerformance("s", 0);
		// 窗口 = [10, 0, 0] → 当前均值 ≈ 3.33
		expect(gm.getEfficiency("s").samples).toBe(3);
		expect(gm.getEfficiency("s").current).toBeCloseTo(10 / 3, 1);
	});
});
