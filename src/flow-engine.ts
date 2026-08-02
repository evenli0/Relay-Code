/**
 * flow-engine.ts —— fan-out/merge 原语执行器（framework-design §4.1）
 *
 * 并行聚合：Flow 声明一组任务 → 引擎并行派发（复用同步 dispatch）→ 按
 * merge 条件合并（all = 全部拼接 / first = 第一个成功）→ 结果交回调用方。
 * 声明文件：flows/<id>.json（用户书写，纯数据）。
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dispatch } from "./dispatcher";
import type { ToolExecutor } from "./tool-executor";

/** fan-out 声明（flows/<id>.json，用户书写） */
export interface FanoutDefinition {
	id: string;
	description?: string;
	/** 并行任务组（每任务 = 一个子 agent 的 dispatch） */
	tasks: Array<{ task: string; role?: string }>;
	/** 聚合条件：all = 全部结果拼接；first = 取第一个成功 */
	merge: "all" | "first";
}

export type FanoutResult =
	| { ok: true; output: string; merge: "all" | "first" }
	| { ok: false; error: string };

export class FlowEngine {
	constructor(
		private executor: ToolExecutor,
		private flowsDir = "flows",
	) {}

	/** 已声明的 flow id 列表 */
	list(): string[] {
		if (!existsSync(this.flowsDir)) return [];
		return readdirSync(this.flowsDir)
			.filter((f) => f.endsWith(".json"))
			.map((f) => f.replace(/\.json$/, ""));
	}

	/** 读取并校验声明（坏文件/无效声明 → 错误） */
	load(id: string): FanoutDefinition | null {
		const path = `${this.flowsDir}/${id}.json`;
		if (!existsSync(path)) return null;
		try {
			const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
			const def = raw as FanoutDefinition;
			if (
				typeof def?.id !== "string" ||
				!Array.isArray(def.tasks) ||
				def.tasks.length === 0 ||
				!def.tasks.every((t) => typeof t.task === "string") ||
				(def.merge !== "all" && def.merge !== "first")
			) {
				return null;
			}
			return def;
		} catch {
			return null;
		}
	}

	/** 执行并行聚合：并行派发 → 按 merge 合并 */
	async runFanout(id: string): Promise<FanoutResult> {
		const def = this.load(id);
		if (!def) {
			return {
				ok: false,
				error: `flow ${id} 不存在或声明无效（flows/${id}.json: id/tasks/merge 必填）`,
			};
		}

		// 并行派发（复用同步 dispatch，每任务一个子 agent）
		const results = await Promise.all(
			def.tasks.map((t) =>
				dispatch(
					{
						prompt: {
							task: t.task,
							role: t.role,
							instructions: t.role ? `你是${t.role}。${t.task}` : t.task,
						},
						responseSchema: {
							type: "object",
							properties: { result: { type: "string" } },
						},
						max_rounds: 30,
					},
					this.executor,
				),
			),
		);

		// merge: first —— 取第一个成功
		if (def.merge === "first") {
			const ok = results.find((r) => r.status === "completed");
			if (!ok) {
				return {
					ok: false,
					error: `flow ${id} 所有任务失败: ${results
						.map((r) => r.output)
						.join(" | ")
						.slice(0, 200)}`,
				};
			}
			return { ok: true, output: ok.output, merge: "first" };
		}

		// merge: all —— 全部拼接（失败的标 [失败]）
		const parts = results.map((r, i) => {
			const t = def.tasks[i];
			const name = t?.role ?? (t ? t.task.slice(0, 30) : `任务${i + 1}`);
			const body = r.status === "completed" ? r.output : `[失败] ${r.output}`;
			return `### ${name}\n${body}`;
		});
		return { ok: true, output: parts.join("\n\n"), merge: "all" };
	}
}
