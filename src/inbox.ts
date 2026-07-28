import type { AgentEvent } from "./types";

/**
 * Inbox —— 事件收件箱
 *
 * 所有事件（User 指令、子 Agent 完成/错误）都进这里。
 * 不关心消息来源，只关心消息顺序和优先级。
 */
export class Inbox {
	private queue: AgentEvent[] = [];

	/** 推入一个事件 */
	push(event: AgentEvent): void {
		this.queue.push(event);
	}

	/** 取出并清空当前全部事件 */
	drain(): AgentEvent[] {
		const batch = [...this.queue];
		this.queue = [];
		return batch;
	}

	/** 是否有待处理事件 */
	isEmpty(): boolean {
		return this.queue.length === 0;
	}

	/** 当前事件数量 */
	get size(): number {
		return this.queue.length;
	}
}
