import path from "node:path";
import { ALL_TOOLS, resolveShell } from "./tools";
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
			if (!task || task.length < 4)
				return "dispatch 任务描述过短，请重写 task 包含具体上下文";
			const planFile = Bun.file("plan.md");
			const hasPlan = await planFile.exists();
			if (!hasPlan && !args.exploratory) {
				// 自动降级为探索模式
				process.stderr.write("[dispatch] plan.md 不存在，自动切换为探索模式\n");
			}
			const config: DispatchConfig = {
				prompt: {
					task,
					role: role || void 0,
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
				return `[dispatch 完成] 状态: ${result.status} 结构化结果: ${JSON.stringify(result.structured, null, 2)}`;
			}
			return `[dispatch 完成] 状态: ${result.status} 输出: ${result.output}`;
		}
		// 路径解析：worktree 隔离下，相对路径 → worktree 内的绝对路径
		let resolvedArgs = args;
		if (cwd) {
			resolvedArgs = this.resolveCwdArgs(toolName, args, cwd);
		}

		const tool = ALL_TOOLS.find((t) => t.function.name === toolName);
		if (!tool) return `未知工具：${toolName}`;

		// bash 需要特殊处理：在 worktree 目录执行
		if (toolName === "bash" && cwd) {
			const command = String(resolvedArgs.command ?? "");
			const shell = resolveShell();
			const proc = Bun.spawnSync([shell.bin, shell.flag, command], { cwd, timeout: 30000 });
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
