import path from "node:path";
import type { AgentRegistry } from "./agent-registry";
import { loadApprovals } from "./approvals";
import { dispatchAsync } from "./dispatcher";
import type { Inbox } from "./inbox";
import type { ServiceContract, ServicePermissions } from "./service-contract";
import { createServiceContract, writeServiceFiles } from "./service-factory";
import type { StateStore } from "./state-store";
import type { Supervisor } from "./supervisor";
import { ALL_TOOLS, resolveShell } from "./tools";
import type { DispatchConfig, SubAgentResult } from "./types";

/**
 * ToolExecutor —— 工具执行路由
 *
 * 负责将工具调用分发到对应工具函数，支持 worktree 路径隔离。
 * dispatch 支持两种模式：
 *   - 同步模式（dispatchFn 回调）：等待子 Agent 返回
 *   - 异步模式（inbox + registry）：火发，不等
 */
export class ToolExecutor {
	dispatchFn?: (config: DispatchConfig) => Promise<SubAgentResult>;
	inbox?: Inbox;
	registry?: AgentRegistry;
	threadId?: string;
	sink?: import("./sink").Sink;
	/** 服务契约权限（framework-design §9）；null = 旧模式不限制 */
	private contractPermissions: ServicePermissions | null = null;
	/** 全局状态模型（query_state 工具的数据源，framework-design §5） */
	stateStore?: StateStore;
	/** 服务集群（create_service 工具的热部署目标，framework-design §10） */
	supervisor?: Supervisor;
	/** 服务 id（批准点确认流按服务隔离，Phase4-B） */
	serviceId?: string;

	/** 注入服务契约权限（Supervisor/actor 启动时） */
	setPermissions(p: ServicePermissions | null): void {
		this.contractPermissions = p;
	}

	async executeToolCall(
		toolName: string,
		args: Record<string, unknown>,
		cwd?: string,
	): Promise<string> {
		// 权限 enforcement：契约声明之外的一律拒绝（framework-design §9）
		const denied = this.enforce(toolName, args);
		if (denied) return denied;

		// create_service：主 agent 生成并部署服务（framework-design §10，创生）
		if (toolName === "create_service") {
			if (!this.supervisor) return "create_service 不可用：Supervisor 未接入";
			const name = typeof args.name === "string" ? args.name.trim() : "";
			if (!name) return "create_service 需要 name 参数（服务名）";
			const archetypeArg =
				typeof args.archetype === "string" ? args.archetype : "pusher";
			const archetypes = ["pusher", "watcher", "interactive", "hybrid"];
			if (!archetypes.includes(archetypeArg)) {
				return `create_service archetype 必须是 ${archetypes.join("/")}`;
			}
			const contract = createServiceContract({
				name,
				description:
					typeof args.description === "string" ? args.description : name,
				archetype: archetypeArg as ServiceContract["archetype"],
			});
			const written = writeServiceFiles(contract);
			if (!written.ok) return `create_service 失败: ${written.error}`;
			this.supervisor.start(contract);
			return `[create_service] 已生成并部署: ${contract.id}（services/${contract.id}/，编辑 entry.ts 后 reload 生效）`;
		}

		// query_state：主 agent 的"知晓"（拉取式状态查询）
		if (toolName === "query_state") {
			if (!this.stateStore) return "query_state 不可用：StateStore 未接入";
			const serviceId =
				typeof args.serviceId === "string" ? args.serviceId : undefined;
			return JSON.stringify(this.stateStore.queryState(serviceId), null, 2);
		}

		// dispatch 工具
		if (toolName === "dispatch") {
			const task = String(args.task ?? "").trim();
			const role = String(args.role ?? "").trim();
			const format = String(args.format ?? "").trim();
			if (!task || task.length < 4)
				return "dispatch 任务描述过短，请重写 task 包含具体上下文";
			const planFile = Bun.file("plan.md");
			const hasPlan = await planFile.exists();
			if (!hasPlan && !args.exploratory) {
				process.stderr.write("[dispatch] plan.md 不存在，自动切换为探索模式\n");
			}
			const mode = (args.mode as string) === "actor" ? "actor" : "oneshot";
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

			// 异步模式：火发，不等
			if (this.inbox && this.registry && this.threadId) {
				const { agentId } = await dispatchAsync(
					config,
					this.inbox,
					this.registry,
					this.threadId,
					this.sink,
					mode,
				);
				return `[dispatch 已发出] agentId: ${agentId}`;
			}

			// 同步模式：等返回（兼容旧行为）
			if (this.dispatchFn) {
				const result = await this.dispatchFn(config);
				if (result.structured) {
					return `[dispatch 完成] 状态: ${result.status} 结构化结果: ${JSON.stringify(result.structured, null, 2)}`;
				}
				return `[dispatch 完成] 状态: ${result.status} 输出: ${result.output}`;
			}

			return "dispatch 不可用";
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
			const proc = Bun.spawnSync([shell.bin, shell.flag, command], {
				cwd,
				timeout: 30000,
			});
			return (
				proc.stdout.toString() +
				(proc.stderr.toString() ? `\nstderr:\n${proc.stderr.toString()}` : "")
			);
		}

		if (!tool.execute) return `错误：工具 ${toolName} 无法执行`;
		return await tool.execute(resolvedArgs);
	}

	private enforce(
		toolName: string,
		args: Record<string, unknown>,
	): string | null {
		const p = this.contractPermissions;
		if (!p) return null; // 无权限声明 = 旧模式不限制（逐步迁移）

		// 工具白名单（bash 默认不在内 = 默认禁用）
		const allowed = p.tools ?? ["read", "grep"];
		if (!allowed.includes(toolName)) {
			return `权限拒绝：工具 ${toolName} 不在白名单（允许: ${allowed.join(", ")}）`;
		}

		// 批准点：声明为需确认的操作（Phase4-B 确认流：approve 后放行）
		if (p.approval?.includes(toolName)) {
			const key = `${this.serviceId ?? "unknown"}:${toolName}`;
			if (loadApprovals().has(key)) return null; // 已批准过，放行
			return `权限拒绝：操作 ${toolName} 需要用户批准（daemon 执行: approve ${this.serviceId ?? "?"} ${toolName}）`;
		}

		// fs 路径白名单
		if (
			(toolName === "read" || toolName === "write") &&
			typeof args.path === "string"
		) {
			if (!isPathAllowed(String(args.path), p)) {
				return `权限拒绝：路径 ${args.path} 超出白名单`;
			}
		}
		return null;
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

/** 路径白名单：绝对路径必须落在允许前缀内；未声明前缀时只允许 cwd 内相对路径 */
function isPathAllowed(raw: string, perms: ServicePermissions): boolean {
	const p = raw.replace(/\\/g, "/");
	const prefixes = perms.paths ?? [];
	if (prefixes.length === 0) {
		// 未声明目录：只允许相对路径（不越出 cwd）
		return !p.startsWith("/") && !/^[a-zA-Z]:/.test(p) && !p.startsWith("../");
	}
	for (const prefix of prefixes) {
		const norm = prefix.replace(/\\/g, "/").replace(/\/+$/, "");
		if (p === norm || p.startsWith(`${norm}/`)) return true;
	}
	return false;
}
