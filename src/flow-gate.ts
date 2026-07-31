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
	};
	action: GateAction;
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
		return true;
	}
}
