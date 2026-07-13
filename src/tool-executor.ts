import path from "node:path";
import { ALL_TOOLS } from "./tools";
import type { DispatchConfig, SubAgentResult } from "./types";

/**
 * ToolExecutor —— 工具执行路由
 *
 * 负责将工具调用分发到对应工具函数，支持 worktree 路径隔离。
 * dispatch 回调由外部注入（通常来自 Harness），使 SubAgent 也能调用 dispatch。
 */
export class ToolExecutor {
	dispatchFn?: (config: DispatchConfig) => Promise<SubAgentResult>;

	async executeToolCall(
		toolName: string,
		args: Record<string, unknown>,
		cwd?: string,
	): Promise<string> {
		// dispatch 委托给外部回调
		if (toolName === "dispatch") {
			if (!this.dispatchFn) return "dispatch 不可用";
			const task = String(args.task ?? "").trim();
			const role = String(args.role ?? "").trim();
			const format = String(args.format ?? "").trim();
			if (!task || task.length < 10)
				return "dispatch 任务描述过短（<10字符），请重写 task 包含具体上下文";
			const planFile = Bun.file("plan.md");
			if (!(await planFile.exists())) {
				if (!args.exploratory)
					return "dispatch 需要 plan.md 才能执行。请先用 write 写下计划，再 dispatch。";
			}
			const config: DispatchConfig = {
				prompt: {
					task,
					role: role || undefined,
					instructions: role ? `你是${role}。${task}` : task,
				},
				responseSchema: format
					? {
							type: "object",
							properties: {
								keyFindings: { type: "array" },
								summary: { type: "string" },
							},
						}
					: { type: "object", properties: { result: { type: "string" } } },
				max_rounds: 30,
			};
			const result = await this.dispatchFn(config);
			if (result.structured) {
				return `[dispatch完成]状态: ${result.status}结构化结果:${JSON.stringify(result.structured, null, 2)}`;
			}
			return `[dispatch完成]状态: ${result.status}输出: ${result.output}`;
		} // 路径解析：worktree 隔离下，相对路径 → worktree 内的绝对路径
		let resolvedArgs = args;
		if (cwd) {
			resolvedArgs = this.resolveCwdArgs(toolName, args, cwd);
		}

		const tool = ALL_TOOLS.find((t) => t.function.name === toolName);
		if (!tool) return `未知工具：${toolName}`;

		// bash 需要特殊处理：在 worktree 目录执行
		if (toolName === "bash" && cwd) {
			const command = String(resolvedArgs.command ?? "");
			const proc = Bun.spawnSync(["bash", "-c", command], { cwd });
			return (
				proc.stdout.toString() +
				(proc.stderr.toString() ? `\nstderr:\n${proc.stderr.toString()}` : "")
			);
		}

		if (!tool.execute) return `错误：工具 ${toolName} 无法执行`;
		return await tool.execute(resolvedArgs);
	}

	private resolveCwdArgs(
		_toolName: string,
		args: Record<string, unknown>,
		cwd: string,
	): Record<string, unknown> {
		const newArgs = { ...args };
		const pathArg = newArgs.path;
		if (typeof pathArg === "string" && !path.isAbsolute(pathArg)) {
			newArgs.path = path.resolve(cwd, pathArg);
		}
		return newArgs;
	}
}
