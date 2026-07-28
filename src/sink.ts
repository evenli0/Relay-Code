/**
 * sink.ts —— 事件总线
 *
 * 对标 Reasonix internal/event 的 Sink 模式。
 * Agent 引擎只产出 SinkEvent，不关心谁来消费。
 * 每个前端（终端/WebSocket/headless）实现 Sink 接口即可。
 */
export type SinkEvent =
	| { kind: "agent_dispatched"; agentId: string; role: string; task: string }
	| {
			kind: "agent_progress";
			agentId: string;
			round: number;
			action: string;
	  }
	| {
			kind: "agent_done";
			agentId: string;
			role: string;
			output: string;
	  }
	| {
			kind: "agent_error";
			agentId: string;
			role: string;
			error: string;
	  }
	| { kind: "llm_response"; text: string }
	| {
			kind: "tool_called";
			agentType: "main" | "sub";
			tool: string;
			args: string;
	  }
	| { kind: "notice"; level: "info" | "warn"; text: string };

export interface Sink {
	emit(e: SinkEvent): void;
}

/**
 * MultiSink 把一个事件广播到所有已注册的 Sink。
 * 对标 Reasonix 的 event.Sync 包装 —— 保证顺序、隔离影响。
 */
export class MultiSink implements Sink {
	private sinks: Sink[] = [];

	add(s: Sink): void {
		this.sinks.push(s);
	}

	emit(e: SinkEvent): void {
		for (const s of this.sinks) {
			try {
				s.emit(e);
			} catch {
				/* 单个 sink 的异常不影响其他 */
			}
		}
	}
}
