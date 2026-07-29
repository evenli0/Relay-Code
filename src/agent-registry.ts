import { existsSync, readFileSync } from "node:fs";
import type { ActorHandle } from "./actor-handle";

/**
 * AgentRegistry —— 子 Agent 状态追踪
 *
 * 三层数据：
 *   L1: getSnapshot() — 一行状态栏，不进 LLM 上下文
 *   L2: peek(id)     — 近期时间线，按需注入 LLM
 *   L3: readConversation(id) — 完整对话文件，深度排查用
 *
 * Actor 模式：注册常驻 ActorHandle，支持 sendToActor() 直接对话。
 */

// ─── 类型 ───────────────────────────────────────────

export interface AgentProgress {
	round: number;
	totalRounds?: number;
	lastAction: string;
	lastSummary: string;
	elapsedMs: number;
	updatedAt: number;
}

export interface AgentPeek {
	id: string;
	role: string;
	threadId: string;
	status: "running" | "done" | "error";
	startedAt: number;
	progress: AgentProgress | null;
	summary?: string; // done/error 时的结果摘要
}

export interface AgentHistoryEntry {
	round: number;
	timestamp: number;
	action: string;
	result?: string;
}

// ─── 文件路径 ─────────────────────────────────────────

const TASKS_DIR = ".relay/tasks";

function progressPath(agentId: string): string {
	return `${TASKS_DIR}/${agentId}.progress.json`;
}

function conversationPath(agentId: string): string {
	return `${TASKS_DIR}/${agentId}.conversation.jsonl`;
}

// ─── 单 Agent 状态 ───────────────────────────────────

interface AgentState {
	id: string;
	role: string;
	threadId: string;
	status: "running" | "done" | "error";
	startedAt: number;
	summary?: string;
	/** Level 3：最近的轮次历史（内存缓存） */
	recentHistory: AgentHistoryEntry[];
}

// ─── 类 ─────────────────────────────────────────────

export class AgentRegistry {
	private agents = new Map<string, AgentState>();
	private actorHandles = new Map<string, ActorHandle>();

	// ── 生命周期 ─────────────────────────────────────

	register(id: string, role: string, threadId: string): void {
		this.agents.set(id, {
			id,
			role,
			threadId,
			status: "running",
			startedAt: Date.now(),
			recentHistory: [],
		});
	}

	/** Actor 模式注册：存储 ActorHandle 供后续 sendToActor */
	registerActor(
		id: string,
		role: string,
		threadId: string,
		handle: ActorHandle,
	): void {
		this.agents.set(id, {
			id,
			role,
			threadId,
			status: "running",
			startedAt: Date.now(),
			recentHistory: [],
		});
		this.actorHandles.set(id, handle);
	}

	/** 更新子 Agent 进度（内存中，供 peek 使用） */
	updateProgress(
		id: string,
		round: number,
		action: string,
		summary: string,
	): void {
		const a = this.agents.get(id);
		if (!a) return;
		a.recentHistory.push({
			round,
			timestamp: Date.now(),
			action,
			result: summary.slice(0, 100),
		});
		if (a.recentHistory.length > 20) a.recentHistory.shift();
	}

	/** 获取 Actor 的遥控器（供人类/web 直接对话） */
	getHandle(id: string): ActorHandle | undefined {
		// 支持短 ID 匹配
		if (!this.actorHandles.has(id)) {
			for (const [fullId, handle] of this.actorHandles) {
				if (fullId.endsWith(id)) return handle;
			}
			return undefined;
		}
		return this.actorHandles.get(id);
	}

	/** 人类/main 直接给 Actor 发消息 */
	sendToActor(
		agentId: string,
		msg: import("./actor").ActorInput,
	): string | null {
		const handle = this.getHandle(agentId);
		if (!handle) return `Actor ${agentId} 不存在或不是 Actor 模式`;
		handle.send(msg);
		return null; // null = 成功，string = 错误消息
	}

	markDone(id: string, summary: string): void {
		const a = this.agents.get(id);
		if (a) {
			a.status = "done";
			a.summary = summary.slice(0, 200);
		}
	}

	markError(id: string, error: string): void {
		const a = this.agents.get(id);
		if (a) {
			a.status = "error";
			a.summary = error.slice(0, 200);
		}
	}

	/** 追加一条历史记录 */
	appendHistory(id: string, entry: AgentHistoryEntry): void {
		const a = this.agents.get(id);
		if (a) {
			a.recentHistory.push(entry);
			// 只保留最近 20 条
			if (a.recentHistory.length > 20) {
				a.recentHistory.shift();
			}
		}
	}

	// ── L1: 一行状态 ─────────────────────────────────

	/** 返回给终端/LLM 看的集群状态摘要，不进上下文 */
	getSnapshot(): string {
		if (this.agents.size === 0) return "";

		const lines: string[] = ["## 子 Agent 运行状态"];
		for (const a of this.agents.values()) {
			const icon =
				a.status === "running" ? "⟳" : a.status === "done" ? "✓" : "✗";
			const shortId = a.id.slice(-8);

			// 尝试读进度文件获取最新状态
			const progress = this._readProgress(a.id);

			let detail = "";
			if (a.status === "running") {
				if (progress) {
					detail = `第${progress.round}轮 ${progress.lastAction} — ${progress.lastSummary}`;
				} else {
					detail = "启动中...";
				}
			} else {
				detail = a.summary?.slice(0, 80) ?? "";
			}

			lines.push(`  ${icon} ${a.role} (${shortId}): ${detail}`);
		}
		return lines.join("\n");
	}

	// ── L2: 近期时间线 ────────────────────────────────

	/** 查看某个 agent 的近期状态，不进 LLM 上下文 */
	peek(agentId: string): AgentPeek | null {
		const a = this.agents.get(agentId);
		if (!a) return null;

		return {
			id: a.id,
			role: a.role,
			threadId: a.threadId,
			status: a.status,
			startedAt: a.startedAt,
			progress: this._readProgress(agentId),
			summary: a.summary,
		};
	}

	/** 列出所有 agent 的 peek 信息 */
	peekAll(): AgentPeek[] {
		return [...this.agents.keys()]
			.map((id) => this.peek(id))
			.filter((p): p is AgentPeek => p !== null);
	}

	/** 格式化 peek 为 LLM 可读文本 */
	peekAsContext(agentId: string): string {
		const p = this.peek(agentId);
		if (!p) return `Agent ${agentId} 不存在。`;

		const lines = [`## ${p.role} (${p.id.slice(-8)})`, `状态: ${p.status}`];

		if (p.progress) {
			lines.push(
				`进度: 第 ${p.progress.round} 轮`,
				`最近动作: ${p.progress.lastAction}`,
				`摘要: ${p.progress.lastSummary}`,
				`耗时: ${(p.progress.elapsedMs / 1000).toFixed(0)}s`,
			);
		}

		// 附上近期历史
		const a = this.agents.get(agentId);
		if (a && a.recentHistory.length > 0) {
			lines.push("", "## 近期时间线");
			for (const h of a.recentHistory.slice(-8)) {
				const result = h.result ? ` → ${h.result.slice(0, 60)}` : "";
				lines.push(`  R${h.round}: ${h.action}${result}`);
			}
		}

		if (p.status === "done" && p.summary) {
			lines.push("", `结果: ${p.summary}`);
		}

		return lines.join("\n");
	}

	// ── L3: 完整对话文件 ──────────────────────────────

	/** 读子 Agent 的完整对话，从文件加载 */
	readConversation(agentId: string): string | null {
		const path = conversationPath(agentId);
		if (!existsSync(path)) return null;
		try {
			return readFileSync(path, "utf-8");
		} catch {
			return null;
		}
	}

	/** 读进度文件 */
	private _readProgress(agentId: string): AgentProgress | null {
		const path = progressPath(agentId);
		if (!existsSync(path)) return null;
		try {
			return JSON.parse(readFileSync(path, "utf-8")) as AgentProgress;
		} catch {
			return null;
		}
	}

	// ── 清理 ──────────────────────────────────────────

	cleanup(maxAgeMs = 600_000): void {
		const now = Date.now();
		for (const [id, a] of this.agents) {
			if (a.status !== "running" && now - a.startedAt > maxAgeMs) {
				this.agents.delete(id);
			}
		}
	}

	get size(): number {
		return this.agents.size;
	}

	getRunning(): AgentState[] {
		return [...this.agents.values()].filter((a) => a.status === "running");
	}

	getAll(): AgentState[] {
		return [...this.agents.values()];
	}
}
