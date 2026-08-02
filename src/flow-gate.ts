/**
 * flow-gate.ts —— 处置门控（framework-design §4.3，if 原语的雏形）
 *
 * 处置模式（Disposition）四旋钮，每个事件最终落到一种处置：
 *   - immediate：唤醒主 agent 立即处理（自动化 push：该响的闹钟会响）
 *   - defer：积攒进后台上下文池（不唤醒不打扰，供唤醒/开口时全景注入）
 *   - notify：推送给人（终端 / dashboard 通知出口）
 *   - archive：记录后丢弃
 * 隐式组合规则：除 archive 外所有事件都进后台池（全景积累）；
 * immediate = 唤醒大脑（大脑带全景决策，处理完才决定是否告知用户）。
 *
 * 决策顺序（高 → 低）：用户规则（含 LLM 沉淀）→ 服务声明（事件 intent /
 * 契约 disposition）→ 默认分级（事件级别）。建造者永远最高层。
 */

import type { EventIntent, EventLevel } from "./protocol";
import type { AgentEvent } from "./types";

export type Disposition = "immediate" | "defer" | "notify" | "archive";

export interface GateRule {
	match: {
		level?: EventLevel;
		eventType?: string;
		agentRole?: string;
		/** 时段（小时 0-23）：from <= hour < to；跨午夜用 from > to 表示 */
		time?: { from: number; to: number };
	};
	action: Disposition;
}

/** 旧 action 值兼容（notify-rules.jsonl 历史数据：show/digest/drop → 新处置） */
export function normalizeDisposition(
	raw: string | undefined,
): Disposition | null {
	if (!raw) return null;
	switch (raw) {
		case "immediate":
		case "defer":
		case "notify":
		case "archive":
			return raw;
		case "show": // 旧：给人看
			return "notify";
		case "digest": // 旧：静默归档
			return "defer";
		case "drop": // 旧：丢弃
			return "archive";
		default:
			return null;
	}
}

/**
 * 默认分级（无规则无声明时的兜底）：
 * silent/trace → defer（默认不打扰）；info/notify → notify（给人看）；
 * critical → immediate（该响的闹钟会响）。
 */
export function defaultForLevel(level: EventLevel | undefined): Disposition {
	switch (level) {
		case "silent":
		case "trace":
			return "defer";
		case "critical":
			return "immediate";
		default:
			return "notify"; // info / notify / undefined
	}
}

/** 时段匹配（纯函数，可单测）：from <= hour < to；from > to 表示跨午夜 */
export function matchesTime(from: number, to: number, hour: number): boolean {
	if (from <= to) return hour >= from && hour < to;
	return hour >= from || hour < to; // 跨午夜：如 22-6
}

export class FlowGate {
	private rules: GateRule[];
	private defaultAction: Disposition | undefined;

	constructor(defaultAction?: Disposition, rules: GateRule[] = []) {
		this.defaultAction = defaultAction;
		this.rules = [...rules]; // 优先级从高到低
	}

	/** 新规则插入队首（最高优先级） */
	addRule(rule: GateRule): void {
		this.rules.unshift(rule);
	}

	/**
	 * 处置决策：用户规则（最高）→ 服务声明（declared）→ 构造默认 → 级别分级。
	 * @param declared 服务声明（事件 intent / 契约 disposition），undefined = 未声明
	 */
	decide(event: AgentEvent, declared?: Disposition): Disposition {
		for (const rule of this.rules) {
			if (this.matches(rule.match, event)) return rule.action;
		}
		return declared ?? this.defaultAction ?? defaultForLevel(event.level);
	}

	private matches(m: GateRule["match"], e: AgentEvent): boolean {
		if (m.level !== undefined && e.level !== m.level) return false;
		if (m.eventType !== undefined && e.eventType !== m.eventType) return false;
		if (m.agentRole !== undefined && e.agentRole !== m.agentRole) return false;
		if (m.time !== undefined) {
			const hour = new Date().getHours();
			if (!matchesTime(m.time.from, m.time.to, hour)) return false;
		}
		return true;
	}
}

/** 事件 intent → 处置（服务声明层：进程表达"急/不急"） */
export function intentToDisposition(
	intent: EventIntent | undefined,
): Disposition | undefined {
	if (intent === "immediate") return "immediate";
	if (intent === "defer") return "defer";
	return undefined;
}
