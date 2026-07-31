/**
 * goal-manager.ts —— 目标维度模型 + 效率曲线（framework-design §7）
 *
 * 维度 ≠ 任务：维度是持续推高的状态（基础掌握度、简历完善度），
 * 进度由服务 state 自报，GoalManager 只聚合不推断（设计即服务）。
 *
 * 效率曲线：performance 事件 → 滑动窗口均值 → 相对基线下降超阈值
 * 触发 onEfficiencyDrop（主 agent 据此建议切换维度/休息）。
 */

export interface GoalDimension {
	id: string;
	label: string;
	/** 推进该维度的服务 */
	services: string[];
	/** 评估指标进度（数值，服务自报） */
	progress: Record<string, number>;
	lastActivity: number;
	lastReview: number;
}

export interface Goal {
	id: string;
	label: string;
	dimensions: GoalDimension[];
}

export interface GoalManagerOptions {
	/** 效率窗口大小 */
	windowSize?: number;
	/** 效率下降检测阈值（相对基线下降比例，0-1，默认 0.4） */
	efficiencyDropThreshold?: number;
	onEfficiencyDrop?: (
		serviceId: string,
		drop: number,
		current: number,
		baseline: number,
	) => void;
}

const BASELINE_MIN_SAMPLES = 5;

export class GoalManager {
	private goals: Goal[] = [];
	private perfWindows = new Map<string, number[]>();
	private perfBaseline = new Map<string, number>();
	private inDrop = new Set<string>();
	private opts: Required<Omit<GoalManagerOptions, "onEfficiencyDrop">> & {
		onEfficiencyDrop?: GoalManagerOptions["onEfficiencyDrop"];
	};

	constructor(options: GoalManagerOptions = {}) {
		this.opts = {
			windowSize: options.windowSize ?? 20,
			efficiencyDropThreshold: options.efficiencyDropThreshold ?? 0.4,
			onEfficiencyDrop: options.onEfficiencyDrop,
		};
	}

	// ── 目标维度（用户设计，GoalManager 不自动拆解）──

	createGoal(id: string, label: string): Goal {
		const goal: Goal = { id, label, dimensions: [] };
		this.goals.push(goal);
		return goal;
	}

	addDimension(goalId: string, dim: GoalDimension): void {
		const goal = this.goals.find((g) => g.id === goalId);
		if (goal) goal.dimensions.push(dim);
	}

	/** 服务 state 自报进度：数值字段聚合进关联维度 */
	updateProgress(serviceId: string, updates: Record<string, unknown>): void {
		for (const goal of this.goals) {
			for (const dim of goal.dimensions) {
				if (!dim.services.includes(serviceId)) continue;
				for (const [k, v] of Object.entries(updates)) {
					if (typeof v === "number") dim.progress[k] = v;
				}
				dim.lastActivity = Date.now();
			}
		}
	}

	getGoals(): Goal[] {
		return this.goals;
	}

	// ── 效率曲线 ──

	/** performance 事件：score 越高越好（如答题正确率） */
	recordPerformance(serviceId: string, score: number): void {
		const window = this.perfWindows.get(serviceId) ?? [];
		window.push(score);
		if (window.length > this.opts.windowSize) window.shift();
		this.perfWindows.set(serviceId, window);

		// 基线：前 BASELINE_MIN_SAMPLES 个样本的均值
		if (
			this.perfBaseline.get(serviceId) === undefined &&
			window.length >= BASELINE_MIN_SAMPLES
		) {
			this.perfBaseline.set(serviceId, avg(window));
		}

		const baseline = this.perfBaseline.get(serviceId);
		if (baseline === undefined) return;
		const current = avg(window);
		const drop = (baseline - current) / baseline;

		// 只在下降低于阈值→恢复→再下降的转换沿触发（防重复报警）
		if (drop >= this.opts.efficiencyDropThreshold) {
			if (!this.inDrop.has(serviceId)) {
				this.inDrop.add(serviceId);
				this.opts.onEfficiencyDrop?.(serviceId, drop, current, baseline);
			}
		} else {
			this.inDrop.delete(serviceId);
		}
	}

	getEfficiency(serviceId: string): {
		current: number;
		baseline: number | null;
		samples: number;
	} {
		const window = this.perfWindows.get(serviceId) ?? [];
		return {
			current: window.length > 0 ? avg(window) : 0,
			baseline: this.perfBaseline.get(serviceId) ?? null,
			samples: window.length,
		};
	}
}

function avg(nums: number[]): number {
	return nums.reduce((a, b) => a + b, 0) / nums.length;
}
