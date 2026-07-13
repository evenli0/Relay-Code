import { dispatch } from "./dispatcher";
import { assembleMessages } from "./message-assembler";
import { PlanManager } from "./plan-manager";
import { ToolExecutor } from "./tool-executor";
import type { ChatMessage, DispatchConfig, SubAgentResult } from "./types";

/**
 * Harness —— 外观（Facade）
 *
 * 组合 PlanManager + ToolExecutor + dispatch + message-assembler，
 * 对外提供统一接口。内部实现已拆分为独立模块。
 */
export class Harness {
	private planManager = new PlanManager();
	private executor = new ToolExecutor();

	constructor() {
		// 注入 dispatch 回调，使 executor（含 SubAgent）能递归调用 dispatch
		this.executor.dispatchFn = (config) => this.dispatch(config);
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

	/** 拼装子Agent 消息（测试用） */
	assembleMessages(config: DispatchConfig): Promise<ChatMessage[]> {
		return assembleMessages(config);
	}
}
