/**
 * correlator.ts —— 关联层（framework-design §8）
 *
 * "你学 X 赛道 + X 赛道今日异动"这类跨服务关联：
 *   1. 规则预筛（纯代码）：同实体 + 时间窗内 + 不同（服务/事件类型）→ 候选对；
 *   2. LLM 精判只在触发点（对话时注入候选摘要，供主 agent 判断是否值得告知）。
 *
 * 实体标签：服务事件 payload.entities（字符串数组）。无实体的事件不参与关联。
 */

export interface CorrelatedEvent {
	serviceId: string;
	eventType: string;
	entities: string[];
	ts: number;
	payload: unknown;
}

export interface CorrelatorOptions {
	/** 时间窗（ms）：窗口内同实体才算关联，默认 6h */
	windowMs?: number;
	/** 保留的事件数上限（防内存膨胀） */
	maxEvents?: number;
}

export interface CorrelationCandidate {
	entity: string;
	events: CorrelatedEvent[];
}

export class Correlator {
	private events: CorrelatedEvent[] = [];
	private opts: Required<CorrelatorOptions>;

	constructor(options: CorrelatorOptions = {}) {
		this.opts = {
			windowMs: options.windowMs ?? 6 * 3_600_000,
			maxEvents: options.maxEvents ?? 200,
		};
	}

	/** 摄入服务事件（payload.entities 为实体标签；无实体忽略） */
	ingest(
		serviceId: string,
		eventType: string,
		payload: unknown,
		ts: number,
	): void {
		const entities = extractEntities(payload);
		if (entities.length === 0) return;
		this.events.push({ serviceId, eventType, entities, ts, payload });
		if (this.events.length > this.opts.maxEvents) this.events.shift();
	}

	/**
	 * 候选关联对：同实体 + 时间窗内 + 涉及不同（服务或事件类型）。
	 * 同一服务同一事件类型的重复不构成关联。
	 */
	findCandidates(now = Date.now()): CorrelationCandidate[] {
		const entities = new Set(this.events.flatMap((e) => e.entities));
		const candidates: CorrelationCandidate[] = [];
		for (const entity of entities) {
			const hits = this.events.filter(
				(e) => e.entities.includes(entity) && now - e.ts <= this.opts.windowMs,
			);
			if (hits.length < 2) continue;
			const distinct = new Set(
				hits.map((e) => `${e.serviceId}:${e.eventType}`),
			);
			if (distinct.size < 2) continue;
			candidates.push({ entity, events: hits });
		}
		return candidates;
	}

	/** 对话时注入的候选摘要（触发点 1）；无候选返回空串 */
	getCorrelationSummary(now = Date.now()): string {
		const candidates = this.findCandidates(now);
		if (candidates.length === 0) return "";
		const lines = ["## 关联候选（跨服务上下文）"];
		for (const c of candidates) {
			const detail = c.events
				.map((e) => `${e.serviceId}.${e.eventType}`)
				.join(" + ");
			lines.push(`  ${c.entity}: ${detail}`);
		}
		return lines.join("\n");
	}
}

function extractEntities(payload: unknown): string[] {
	if (typeof payload !== "object" || payload === null) return [];
	const entities = (payload as Record<string, unknown>).entities;
	if (!Array.isArray(entities)) return [];
	return entities.filter((e): e is string => typeof e === "string");
}
