import { PlanState } from "./plan-state";
import type { ChatMessage } from "./types";

/**
 * PlanManager —— PlanState 驱动的 plan 注入管理
 *
 * 职责：
 * 1. 通过 PlanState 解析 plan.md 的阶段标记
 * 2. 跟踪已注入的阶段状态键，避免重复注入相同状态
 * 3. 仅注入格式化后的阶段概览 + 执行规则（非原始全文）
 *
 * 核心改进：使用 PlanState.getStatusKey() 替代内容哈希去重，
 * 仅在阶段状态发生变化时重新注入。
 */
export class PlanManager {
	/** 上一次注入时的状态键；注入前后状态键不变则跳过。 */
	private injectedStatusKey: string | null = null;

	async getPlanMessages(): Promise<ChatMessage[]> {
		const plan = await PlanState.load();
		if (!plan || plan.isCompleted()) return [];

		// 状态键去重：相同阶段状态不重复注入
		const key = plan.getStatusKey();
		if (this.injectedStatusKey === key) return [];
		this.injectedStatusKey = key;

		return [plan.buildMessage()];
	}
}
