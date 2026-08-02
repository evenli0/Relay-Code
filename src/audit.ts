/**
 * audit.ts —— 事件审计（framework-design §6 EventBus.ingest 落盘 + §11.2 审计检索）
 *
 * 所有事件（全 kind，含 heartbeat/state——审计的本义是全量）经统一入口
 * 落盘 .relay/events/<日期>.jsonl（按天分文件），检索时过滤。
 * "节点说了什么、主 agent 采信了什么"可回溯——诚实条款的审计底座。
 */

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
} from "node:fs";
import type { ServiceEvent } from "./protocol";

const AUDIT_DIR = ".relay/events";

export interface AuditEntry {
	ts: number;
	serviceId: string;
	kind: string;
	/** event kind 时：事件类型 */
	type?: string;
	level?: string;
	payload?: unknown;
}

/** 服务事件 → 审计条目（统一格式） */
export function toAuditEntry(serviceId: string, msg: ServiceEvent): AuditEntry {
	const ts = "ts" in msg && typeof msg.ts === "number" ? msg.ts : Date.now();
	if (msg.kind === "event") {
		return {
			ts,
			serviceId,
			kind: "event",
			type: msg.type,
			level: msg.level,
			payload: msg.payload,
		};
	}
	return { ts, serviceId, kind: msg.kind };
}

/** 追加一条审计（按天分文件，幂等建目录） */
export function appendAudit(entry: AuditEntry): void {
	if (!existsSync(AUDIT_DIR)) mkdirSync(AUDIT_DIR, { recursive: true });
	const date = new Date(entry.ts).toISOString().slice(0, 10);
	appendFileSync(
		`${AUDIT_DIR}/${date}.jsonl`,
		`${JSON.stringify(entry)}\n`,
		"utf-8",
	);
}

export interface AuditQuery {
	serviceId?: string;
	eventType?: string;
	level?: string;
	/** 返回最近 N 条（倒序）；默认 20 */
	limit?: number;
}

/** 检索审计：按条件过滤，最近优先（坏行忽略） */
export function queryAudit(q: AuditQuery = {}): AuditEntry[] {
	if (!existsSync(AUDIT_DIR)) return [];
	const limit = q.limit ?? 20;
	const entries: AuditEntry[] = [];
	for (const file of readdirSync(AUDIT_DIR)) {
		if (!file.endsWith(".jsonl")) continue;
		for (const line of readFileSync(`${AUDIT_DIR}/${file}`, "utf-8").split(
			"\n",
		)) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const e = JSON.parse(trimmed) as AuditEntry;
				if (q.serviceId && e.serviceId !== q.serviceId) continue;
				if (q.eventType && e.type !== q.eventType) continue;
				if (q.level && e.level !== q.level) continue;
				entries.push(e);
			} catch {
				/* 坏行忽略 */
			}
		}
	}
	return entries.sort((a, b) => b.ts - a.ts).slice(0, limit);
}
