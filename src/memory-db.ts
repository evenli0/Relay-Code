/**
 * memory-db.ts —— 结构化记忆库（Phase2-D 选型落地）
 *
 * 选型：bun:sqlite（Bun 内置，零依赖）。
 * 分层：JSONL（memory.ts）保留为审计日志；结构化查询/状态历史/事实库在这里。
 * 向量检索推迟到 Phase 4（关联层）再评估——现在没有语义检索的真实需求。
 */

import { Database } from "bun:sqlite";

export interface DialogueRow {
	id: number;
	role: string;
	content: string;
	ts: number;
	service: string | null;
}

export interface StateHistoryRow {
	ts: number;
	snapshot: string;
}

export class MemoryDb {
	private db: Database;

	constructor(path = ".relay/memory.db") {
		this.db = new Database(path, { create: true });
		this.db.run(`CREATE TABLE IF NOT EXISTS dialogue (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			role TEXT NOT NULL,
			content TEXT NOT NULL,
			ts INTEGER NOT NULL,
			service TEXT
		)`);
		this.db.run(`CREATE TABLE IF NOT EXISTS facts (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL,
			updated_at INTEGER NOT NULL
		)`);
		this.db.run(`CREATE TABLE IF NOT EXISTS state_history (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			service TEXT NOT NULL,
			ts INTEGER NOT NULL,
			snapshot TEXT NOT NULL
		)`);
	}

	/** 结构化对话/事件日志（JSONL 仍是审计日志，这里是可查询层） */
	logDialogue(role: string, content: string, service?: string): void {
		this.db.run(
			"INSERT INTO dialogue (role, content, ts, service) VALUES (?, ?, ?, ?)",
			[role, content, Date.now(), service ?? null],
		);
	}

	queryDialogue(
		opts: { service?: string; limit?: number; since?: number } = {},
	): DialogueRow[] {
		const { service, limit = 50, since } = opts;
		let sql = "SELECT * FROM dialogue";
		const where: string[] = [];
		const args: (string | number)[] = [];
		if (service) {
			where.push("service = ?");
			args.push(service);
		}
		if (since !== undefined) {
			where.push("ts >= ?");
			args.push(since);
		}
		if (where.length > 0) sql += ` WHERE ${where.join(" AND ")}`;
		sql += " ORDER BY id DESC LIMIT ?";
		args.push(limit);
		return this.db.query(sql).all(...args) as DialogueRow[];
	}

	/** 全局事实库（源信誉、用户偏好等跨服务事实） */
	setFact(key: string, value: string): void {
		this.db.run(
			"INSERT INTO facts (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
			[key, value, Date.now()],
		);
	}

	getFact(key: string): string | null {
		const row = this.db
			.query("SELECT value FROM facts WHERE key = ?")
			.get(key) as { value: string } | null;
		return row?.value ?? null;
	}

	/** 状态历史（效率曲线/趋势的数据源） */
	recordState(service: string, snapshot: string): void {
		this.db.run(
			"INSERT INTO state_history (service, ts, snapshot) VALUES (?, ?, ?)",
			[service, Date.now(), snapshot],
		);
	}

	recentStates(service: string, limit = 20): StateHistoryRow[] {
		return this.db
			.query(
				"SELECT ts, snapshot FROM state_history WHERE service = ? ORDER BY id DESC LIMIT ?",
			)
			.all(service, limit) as StateHistoryRow[];
	}

	close(): void {
		this.db.close();
	}
}
