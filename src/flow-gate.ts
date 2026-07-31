/**
 * flow-gate.ts —— 最小门控（framework-design §4.3，if 原语的雏形）
 *
 * 纯代码规则表决定事件去向：show / digest / notify / drop。
 * 规则优先（用户反馈规则 > 时段 > 契约 > level > 阈值），LLM 只在规则判定
 * 不了的边缘兜底（Phase 2 接入）。默认动作在构造时指定（当前默认 show，
 * 保持兼容现状；北极星方向是"默认不打扰"）。
 */

import type { EventLevel } from "./protocol";
import type { AgentEvent } from "./types";

export type GateAction = "show" | "digest" | "notify" | "drop";

export interface GateRule {
	match: {
		level?: EventLevel;
		eventType?: string;
		agentRole?: string;
		/** 时段（小时 0-23）：from <= hour < to；跨午夜用 from > to 表示 */
		time?: { from: number; to: number };
	};
	action: GateAction;
}

/** 时段匹配（纯函数，可单测）：from <= hour < to；from > to 表示跨午夜 */
export function matchesTime(from: number, to: number, hour: number): boolean {
	if (from <= to) return hour >= from && hour < to;
	return hour >= from || hour < to; // 跨午夜：如 22-6
}

export class FlowGate {
	private rules: GateRule[];
	private defaultAction: GateAction;

	constructor(defaultAction: GateAction = "show", rules: GateRule[] = []) {
		this.defaultAction = defaultAction;
		this.rules = [...rules]; // 优先级从高到低
	}

	/** 新规则插入队首（最高优先级） */
	addRule(rule: GateRule): void {
		this.rules.unshift(rule);
	}

	decide(event: AgentEvent): GateAction {
		for (const rule of this.rules) {
			if (this.matches(rule.match, event)) return rule.action;
		}
		return this.defaultAction;
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
