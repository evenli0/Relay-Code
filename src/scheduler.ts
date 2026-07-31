/**
 * scheduler.ts —— 节奏调度（framework-design §7，Scheduler）
 *
 * ScheduleSpec 解析与触发：
 *   interval — "6h" / "30m" / "90s" / "500ms"
 *   at       — 指定时间戳，一次性
 *   cron     — 最小 5 字段解析（"分 时 * * *" = 每天），覆盖 95% 节奏需求
 *
 * 到点 → onFire 回调（Supervisor 集成：向节点发 schedule 指令）。
 */

import type { ScheduleSpec } from "./protocol";

const UNIT_MS: Record<string, number> = {
	ms: 1,
	s: 1000,
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
};

export function parseInterval(every: string): number | null {
	const m = /^(\d+)(ms|s|m|h|d)$/.exec(every.trim());
	if (!m) return null;
	const mult = UNIT_MS[m[2] ?? ""];
	if (mult === undefined) return null;
	return Number(m[1]) * mult;
}

export interface CronSpec {
	minute: number;
	hour: number;
}

/** 最小 cron 解析：只支持"每天 分 时"（"分 时 * * *"） */
export function parseCron(expr: string): CronSpec | null {
	const parts = expr.trim().split(/\s+/);
	if (parts.length !== 5) return null;
	const [minute, hour, dom, month, dow] = parts;
	if (dom !== "*" || month !== "*" || dow !== "*") return null;
	const m = Number(minute);
	const h = Number(hour);
	if (!Number.isInteger(m) || m < 0 || m > 59) return null;
	if (!Number.isInteger(h) || h < 0 || h > 23) return null;
	return { minute: m, hour: h };
}

/** 下一次触发时间（本地时区）；无效表达式返回 -1（永不触发） */
export function nextCronTime(expr: string, now: number): number {
	const spec = parseCron(expr);
	if (!spec) return -1;
	const d = new Date(now);
	d.setHours(spec.hour, spec.minute, 0, 0);
	if (d.getTime() <= now) d.setDate(d.getDate() + 1);
	return d.getTime();
}

interface ScheduledJob {
	spec: ScheduleSpec;
	onFire: () => void;
	nextAt: number;
}

export interface SchedulerOptions {
	tickMs?: number;
	logger?: (msg: string) => void;
}

export class Scheduler {
	private jobs = new Map<string, ScheduledJob>();
	private tickTimer: ReturnType<typeof setInterval> | null = null;
	private tickMs: number;
	private logger: (msg: string) => void;

	constructor(options: SchedulerOptions = {}) {
		this.tickMs = options.tickMs ?? 1_000;
		this.logger =
			options.logger ?? ((msg) => process.stderr.write(`[Scheduler] ${msg}\n`));
	}

	register(id: string, spec: ScheduleSpec, onFire: () => void): void {
		const nextAt = this.computeNext(spec, Date.now());
		if (nextAt < 0) {
			this.logger(`${id} 的节奏无效，未注册: ${JSON.stringify(spec)}`);
			return;
		}
		this.jobs.set(id, { spec, onFire, nextAt });
		this.ensureTick();
	}

	unregister(id: string): void {
		this.jobs.delete(id);
	}

	/** 计算下一次触发时间；-1 = 永不 */
	computeNext(spec: ScheduleSpec, now: number): number {
		switch (spec.type) {
			case "interval": {
				const ms = parseInterval(spec.every);
				return ms === null ? -1 : now + ms;
			}
			case "at":
				return spec.ts;
			case "cron":
				return nextCronTime(spec.expr, now);
		}
	}

	get size(): number {
		return this.jobs.size;
	}

	stopAll(): void {
		if (this.tickTimer) clearInterval(this.tickTimer);
		this.tickTimer = null;
		this.jobs.clear();
	}

	private ensureTick(): void {
		if (this.tickTimer) return;
		this.tickTimer = setInterval(() => this.tick(), this.tickMs);
	}

	private tick(): void {
		const now = Date.now();
		for (const [id, job] of [...this.jobs]) {
			if (job.nextAt > now) continue;
			try {
				job.onFire();
			} catch (e) {
				this.logger(`${id} 触发失败: ${e}`);
			}
			// 重复型：interval / cron；一次性：at
			if (job.spec.type === "interval") {
				const ms = parseInterval(job.spec.every);
				job.nextAt = ms === null ? -1 : now + ms;
			} else if (job.spec.type === "cron") {
				job.nextAt = nextCronTime(job.spec.expr, now + 1000);
			} else {
				this.jobs.delete(id);
			}
		}
	}
}
