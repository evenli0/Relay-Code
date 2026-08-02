import type { AgentRegistry } from "./agent-registry";
import { dispatch, dispatchAsync } from "./dispatcher";
import type { FlowGate } from "./flow-gate";
import type { Inbox } from "./inbox";
import { assembleMessages } from "./message-assembler";
import { PlanManager } from "./plan-manager";
import type { Sink } from "./sink";
import type { StateStore } from "./state-store";
import type { Supervisor } from "./supervisor";
import { ToolExecutor } from "./tool-executor";
import type { ChatMessage, DispatchConfig, SubAgentResult } from "./types";

/**
 * Harness —— 外观（Facade）
 *
 * 组合 PlanManager + ToolExecutor + dispatch + message-assembler，
 * 对外提供统一接口。支持同步和异步两种 dispatch 模式。
 */
export class Harness {
	private planManager = new PlanManager();
	private executor = new ToolExecutor();
	private _inbox?: Inbox;
	private _registry?: AgentRegistry;
	private _threadId?: string;

	constructor(inbox?: Inbox, registry?: AgentRegistry, threadId?: string) {
		// 同步兼容：注入 dispatch 回调
		this.executor.dispatchFn = (config) => this.dispatch(config);
		// 异步模式仅在显式传入所有参数时启用
		if (inbox && registry && threadId) {
			this._inbox = inbox;
			this._registry = registry;
			this._threadId = threadId;
			this.executor.inbox = inbox;
			this.executor.registry = registry;
			this.executor.threadId = threadId;
		}
	}

	/** 注入 Sink，传递到 ToolExecutor → dispatchAsync */
	setSink(sink: Sink): void {
		this.executor.sink = sink;
	}

	/** 接入全局状态模型（query_state 工具的数据源） */
	setStateStore(store: StateStore): void {
		this.executor.stateStore = store;
	}

	/** 接入服务集群（create_service 工具的热部署目标） */
	setSupervisor(s: Supervisor): void {
		this.executor.supervisor = s;
	}

	/** 接入门控（set_rule 工具的学习闭环目标，与 orchestrator 共享实例） */
	setGate(g: FlowGate): void {
		this.executor.gate = g;
	}

	/** 接入 Flow 引擎（run_flow 工具的 fan-out/merge 执行器） */
	setFlowEngine(engine: import("./flow-engine").FlowEngine): void {
		this.executor.flowEngine = engine;
	}

	/** 更新 threadId（每次新对话时） */
	setThreadId(threadId: string): void {
		this._threadId = threadId;
		if (this.executor.inbox && this.executor.registry) {
			this.executor.threadId = threadId;
		}
	}

	getPlanMessages(): Promise<ChatMessage[]> {
		return this.planManager.getPlanMessages();
	}

	async executeToolCall(
		toolName: string,
		args: Record<string, unknown>,
		cwd?: string,
	): Promise<string> {
		return this.executor.executeToolCall(toolName, args, cwd);
	}

	async dispatch(config: DispatchConfig): Promise<SubAgentResult> {
		return dispatch(config, this.executor);
	}

	/** 异步火发 dispatch */
	async dispatchFireAndForget(
		config: DispatchConfig,
	): Promise<{ status: string; agentId: string }> {
		if (!this._inbox || !this._registry || !this._threadId) {
			throw new Error("dispatchFireAndForget 需要 inbox + registry + threadId");
		}
		return dispatchAsync(
			config,
			this._inbox,
			this._registry,
			this._threadId,
			this.executor.sink,
		);
	}

	/** 拼装子Agent 消息（测试用） */
	assembleMessages(config: DispatchConfig): Promise<ChatMessage[]> {
		return assembleMessages(config);
	}
}
