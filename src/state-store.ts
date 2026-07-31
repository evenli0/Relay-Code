/**
 * state-store.ts —— 全局状态模型 L0（framework-design §5）
 *
 * 服务自报的结构化状态（state 事件）在这里汇聚成可查询的状态心智模型。
 * 状态是"现在是什么"（可查询、供推理），事件是"发生了什么"（流水、供审计）——
 * 这是 state 通道与 event 通道分离的落点。
 *
 * 存储选型：内存 Map + JSON 落盘（.relay/state/<serviceId>.json），零新依赖；
 * 主进程重启后 restore() 恢复——节点重启 ≠ 状态丢失。
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import type { ServiceEvent } from "./protocol";

interface ServiceStateEntry {
	serviceId: string;
	/** L0：结构化状态（state 事件增量合并） */
	state: Record<string, unknown>;
	/** 事件计数（L2 摘要用："今天 142 次无发现"） */
	eventCounts: Record<string, number>;
	lastEventAt: number;
	lastHeartbeat: number | null;
	updatedAt: number;
}

const STATE_DIR = ".relay/state";
const PERSIST_DEBOUNCE_MS = 500;

export class StateStore {
	private entries = new Map<string, ServiceStateEntry>();
	private persistTimer: ReturnType<typeof setTimeout> | null = null;

	/** 摄入一个上行事件（Supervisor.onNodeEvent 接入） */
	ingest(serviceId: string, event: ServiceEvent): void {
		const entry = this.ensure(serviceId);
		if (event.kind === "state") {
			entry.state = { ...entry.state, ...event.updates };
		} else if (event.kind === "event") {
			entry.eventCounts[event.type] = (entry.eventCounts[event.type] ?? 0) + 1;
			entry.lastEventAt = event.ts;
		} else if (event.kind === "heartbeat") {
			entry.lastHeartbeat = event.ts;
		}
		entry.updatedAt = Date.now();
		this.schedulePersist();
	}

	/** 查询单个服务的结构化状态（L0）；不传 serviceId 返回全部 */
	queryState(serviceId?: string): Record<string, unknown> | null {
		if (serviceId) {
			const e = this.entries.get(serviceId);
			return e ? { ...e.state } : null;
		}
		const all: Record<string, unknown> = {};
		for (const [id, e] of this.entries) {
			all[id] = { ...e.state };
		}
		return all;
	}

	/** 事件计数（L2 摘要用）；带 eventType 返回单个计数 */
	getEventCounts(
		serviceId: string,
		eventType?: string,
	): number | Record<string, number> | null {
		const e = this.entries.get(serviceId);
		if (!e) return null;
		if (eventType) return e.eventCounts[eventType] ?? 0;
		return { ...e.eventCounts };
	}

	/** 全部服务一行摘要（L1，供 LLM/终端/控制台） */
	getL1Summary(): string {
		if (this.entries.size === 0) return "";
		const lines: string[] = ["## 服务状态"];
		for (const e of this.entries.values()) {
			const stateStr = JSON.stringify(e.state).slice(0, 120);
			const counts = Object.entries(e.eventCounts)
				.map(([t, n]) => `${t}=${n}`)
				.join(" ");
			lines.push(
				`  ${e.serviceId}: ${stateStr}${counts ? ` | ${counts}` : ""}`,
			);
		}
		return lines.join("\n");
	}

	get size(): number {
		return this.entries.size;
	}

	/** 启动恢复：读 .relay/state/ 下的落盘快照，返回恢复数量 */
	restore(): number {
		if (!existsSync(STATE_DIR)) return 0;
		let restored = 0;
		for (const file of readdirSync(STATE_DIR)) {
			if (!file.endsWith(".json")) continue;
			try {
				const raw = JSON.parse(
					readFileSync(`${STATE_DIR}/${file}`, "utf-8"),
				) as ServiceStateEntry;
				this.entries.set(raw.serviceId, raw);
				restored++;
			} catch {
				/* 坏快照忽略 */
			}
		}
		return restored;
	}

	private ensure(serviceId: string): ServiceStateEntry {
		let e = this.entries.get(serviceId);
		if (!e) {
			e = {
				serviceId,
				state: {},
				eventCounts: {},
				lastEventAt: 0,
				lastHeartbeat: null,
				updatedAt: Date.now(),
			};
			this.entries.set(serviceId, e);
		}
		return e;
	}

	private schedulePersist(): void {
		if (this.persistTimer) return;
		this.persistTimer = setTimeout(() => {
			this.persistTimer = null;
			this.persist();
		}, PERSIST_DEBOUNCE_MS);
	}

	private persist(): void {
		if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
		for (const e of this.entries.values()) {
			try {
				writeFileSync(
					`${STATE_DIR}/${e.serviceId}.json`,
					JSON.stringify(e, null, 2),
					"utf-8",
				);
			} catch {
				/* 落盘失败不影响内存态 */
			}
		}
	}
}
