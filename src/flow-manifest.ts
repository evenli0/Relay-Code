/**
 * flow-manifest.ts —— 编排收编层（framework-design §4，Flow 是数据）
 *
 * 编排机制散在三处（契约 disposition/consumes/schedule + 门控规则 jsonl），
 * 本模块把它们收编成一份统一的"集群编排图"（FlowManifest）：
 *   事件处置表（谁的事件 → 什么处置，来源：契约/规则/默认）
 *   路由图（谁 → 谁，pipe 原语）
 *   节奏表（谁按什么节奏跑，timer 原语）
 *
 * 用途：静态交叉校验（流断链启动即报）、控制台渲染、审计定位。
 * 不替代执行器——门控/路由/调度照常干活，这里只负责"可验证、可渲染"。
 */

import type { Disposition, GateRule } from "./flow-gate";
import type { ScheduleSpec } from "./protocol";
import type { ServiceContract } from "./service-contract";

/** 事件处置边：谁的事件 → 什么处置（含来源，控制台显示"为什么"；default = 按级别默认分级） */
export interface FlowEventEdge {
	eventType: string;
	serviceId: string;
	disposition: Disposition | "default";
	source: "contract" | "rule" | "default";
}

/** 路由边（pipe）：事件从哪个服务发出 → 投递给谁（契约 consumes 索引） */
export interface FlowRoute {
	eventType: string;
	from: string;
	to: string[];
}

/** 节奏（timer）：服务按什么节奏被唤醒 */
export interface FlowSchedule {
	serviceId: string;
	spec: ScheduleSpec;
}

/** 集群编排图（一份文件看懂整个集群怎么编排） */
export interface FlowManifest {
	services: string[];
	events: FlowEventEdge[];
	routes: FlowRoute[];
	schedules: FlowSchedule[];
	/** 孤儿规则：引用的事件类型当前没有任何服务发出（断链或预声明） */
	orphanRules: GateRule[];
}

/** 收编：从契约集合 + 门控规则生成编排图 */
export function buildFlowManifest(
	contracts: ServiceContract[],
	rules: GateRule[],
): FlowManifest {
	const events: FlowEventEdge[] = [];
	const routes: FlowRoute[] = [];
	const schedules: FlowSchedule[] = [];
	const orphanRules: GateRule[] = [];

	for (const c of contracts) {
		// 事件处置表：契约 disposition 声明的 + 未声明的 emits（默认分级）
		const declared = c.disposition ?? {};
		for (const type of c.emits) {
			events.push({
				eventType: type,
				serviceId: c.id,
				disposition: declared[type] ?? "default",
				source: declared[type] ? "contract" : "default",
			});
		}
		// 节奏表
		if (c.schedule) schedules.push({ serviceId: c.id, spec: c.schedule });
	}

	// 路由图：consumes 声明 → 谁发出这类事件
	const emitIndex = new Map<string, string[]>();
	for (const c of contracts) {
		for (const type of c.emits) {
			const list = emitIndex.get(type) ?? [];
			if (!list.includes(c.id)) list.push(c.id);
			emitIndex.set(type, list);
		}
	}
	for (const c of contracts) {
		for (const type of c.consumes) {
			const from = emitIndex.get(type) ?? [];
			if (from.length === 0) continue;
			for (const f of from) {
				routes.push({ eventType: type, from: f, to: [c.id] });
			}
		}
	}

	// 用户规则覆盖：规则引用的类型 → 处置来源标 rule（若该类型确有服务发出）；
	// 无源事件的规则进 orphanRules（断链或预声明，校验时 warning）
	for (const rule of rules) {
		const eventType = rule.match.eventType;
		if (!eventType) continue;
		let covered = false;
		for (const edge of events) {
			if (edge.eventType === eventType) {
				edge.disposition = rule.action;
				edge.source = "rule";
				covered = true;
			}
		}
		if (!covered) orphanRules.push(rule);
	}

	return {
		services: contracts.map((c) => c.id),
		events,
		routes,
		schedules,
		orphanRules,
	};
}

/**
 * 静态交叉校验：流断链启动即报，不等到运行时静默失效。
 * errors = 必须修复（如路由指向不存在的服务）；warnings = 值得注意（如规则引用无源事件）。
 */
export function validateFlowManifest(
	manifest: FlowManifest,
	contracts: ServiceContract[],
): { errors: string[]; warnings: string[] } {
	const errors: string[] = [];
	const warnings: string[] = [];

	const ids = new Set(manifest.services);
	const emitSet = new Set<string>();
	for (const c of contracts) for (const t of c.emits) emitSet.add(t);

	// 路由对端必须存在
	for (const r of manifest.routes) {
		if (!ids.has(r.from)) {
			errors.push(`路由断链: 事件 ${r.eventType} 的发出方 ${r.from} 不存在`);
		}
		for (const t of r.to) {
			if (!ids.has(t))
				errors.push(`路由断链: 事件 ${r.eventType} 的接收方 ${t} 不存在`);
		}
	}
	// 节奏服务必须存在
	for (const s of manifest.schedules) {
		if (!ids.has(s.serviceId)) {
			errors.push(`节奏引用不存在服务: ${s.serviceId}`);
		}
	}
	// 处置声明引用的类型必须有人发出
	for (const c of contracts) {
		for (const type of Object.keys(c.disposition ?? {})) {
			if (!emitSet.has(type)) {
				warnings.push(
					`${c.id} 声明了 ${type} 的处置，但没有服务发出该事件（断链或预声明）`,
				);
			}
		}
	}
	// 孤儿规则：规则引用的事件类型无人发出
	for (const rule of manifest.orphanRules) {
		warnings.push(
			`规则引用事件 ${rule.match.eventType} 没有任何服务发出（断链或预声明）`,
		);
	}

	return { errors, warnings };
}
