/**
 * protocol.ts —— 统一服务事件协议（framework-design §1）
 *
 * 唯一共性：所有节点（服务进程）与主进程之间只通过本协议通信。
 *   上行：节点 → 主进程（ServiceEvent）
 *   下行：主进程 → 节点（ServiceCommand）
 *
 * 旧词表（ActorInput/ActorOutput）废除；AgentEvent 保留为 inbox 窄接口；
 * SinkEvent 保留为 UI 适配层（核心不依赖 UI 类型）。
 */

export type EventLevel = "trace" | "silent" | "info" | "notify" | "critical";

/**
 * 事件的处置意图（服务进程表达"急/不急"，门控处置决策的第二层"服务声明"）：
 *   - immediate：请主 agent 立即处理（唤醒）
 *   - defer：积攒进后台上下文池即可（不唤醒不打扰）
 * 不写 = 未声明，由门控按契约 disposition / 事件级别决定。
 */
export type EventIntent = "immediate" | "defer";

/** 节奏规格（Scheduler 用，Step B/C 接入） */
export type ScheduleSpec =
	| { type: "interval"; every: string }
	| { type: "cron"; expr: string }
	| { type: "at"; ts: number };

/** 上行：节点 → 主进程 */
export type ServiceEvent =
	| { kind: "ready"; ts: number }
	| { kind: "heartbeat"; ts: number }
	| { kind: "state"; updates: Record<string, unknown> }
	| {
			kind: "event";
			type: string;
			level: EventLevel;
			payload: unknown;
			/** 处置意图（可选；不写 = 门控按契约/级别决定） */
			intent?: EventIntent;
			correlationId?: string;
			ts: number;
	  }
	| {
			kind: "progress";
			taskId?: string;
			round: number;
			action: string;
			summary: string;
	  }
	| {
			kind: "result";
			taskId: string;
			status: "completed" | "error";
			output: string;
	  }
	| { kind: "reply"; requestId: string; content: string }
	| { kind: "request"; requestId: string; to: string; content: string };

/** 下行：主进程 → 节点 */
export type ServiceCommand =
	| { kind: "task"; taskId: string; content: string }
	| {
			kind: "ask";
			requestId: string;
			content: string;
			from?: "human" | "main";
			context?: unknown;
	  }
	| {
			kind: "configure";
			tools?: string[];
			systemPrompt?: string;
			version?: number;
	  }
	| { kind: "event"; type: string; payload: unknown; correlationId?: string }
	| { kind: "schedule"; spec: ScheduleSpec }
	| { kind: "shutdown"; reason: string };

// ─── 编解码（容错：坏行返回 null，不抛异常）──────────────

const EVENT_KINDS = new Set([
	"ready",
	"heartbeat",
	"state",
	"event",
	"progress",
	"result",
	"reply",
	"request",
]);

const COMMAND_KINDS = new Set([
	"task",
	"ask",
	"configure",
	"event",
	"schedule",
	"shutdown",
]);

function decodeLine<T>(line: string, kinds: Set<string>): T | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (typeof parsed !== "object" || parsed === null) return null;
		const kind = (parsed as { kind?: unknown }).kind;
		if (typeof kind !== "string" || !kinds.has(kind)) return null;
		return parsed as T;
	} catch {
		return null;
	}
}

export function encodeServiceEvent(e: ServiceEvent): string {
	return JSON.stringify(e);
}

export function decodeServiceEvent(line: string): ServiceEvent | null {
	return decodeLine<ServiceEvent>(line, EVENT_KINDS);
}

export function encodeServiceCommand(c: ServiceCommand): string {
	return JSON.stringify(c);
}

export function decodeServiceCommand(line: string): ServiceCommand | null {
	return decodeLine<ServiceCommand>(line, COMMAND_KINDS);
}
