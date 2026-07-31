/**
 * service-contract.ts —— 服务契约（framework-design §2，最小字段集）
 *
 * 服务 = 一个目录工件（service.json + entry.ts）。三种来源
 * （用户定义 / 主 agent 生成 / 生态安装）都产出同一格式。
 * 行为从契约来，不从代码来（"设计即服务"）。
 */

export type Archetype = "pusher" | "watcher" | "interactive" | "hybrid";
export type ExecutionMode = "react" | "cron" | "watch" | "external";

export interface ServicePermissions {
	/** fs 白名单：read / write / exec */
	fs?: ("read" | "write" | "exec")[];
	/** 网络白名单：允许的域名/URL 前缀 */
	net?: string[];
	/** 工具白名单（bash 默认禁用） */
	tools?: string[];
	/** 批准点：需要用户确认的操作清单（Phase 4 接入确认 UI，本轮仅声明） */
	approval?: string[];
}

export interface ServiceContract {
	/** 全局唯一，目录名一致 */
	id: string;
	version: string;
	name: string;
	description: string;
	archetype: Archetype;
	/** harness 异构声明：react / cron / watch / external */
	execution: ExecutionMode;
	/** 相对入口文件（bun run services/<id>/<entry>） */
	entry: string;
	/** 节点系统提示词（可省略，entry 自带） */
	prompt?: string;
	/** API 模型（节点级，异构模型） */
	model?: string;
	/** 工具模型：框架工具 + 挂载的 MCP/外部能力 */
	tools: string[];
	/** 技能包 */
	skills?: string[];
	/** 能力声明（主 agent 发现节点用） */
	capabilities: string[];
	/** 能发出的事件类型（上行校验） */
	emits: string[];
	/** 能接收的事件类型（路由依据） */
	consumes: string[];
	permissions: ServicePermissions;
}

const ARCHETYPES: Archetype[] = ["pusher", "watcher", "interactive", "hybrid"];
const EXECUTIONS: ExecutionMode[] = ["react", "cron", "watch", "external"];

export type ContractValidation =
	| { ok: true; contract: ServiceContract }
	| { ok: false; errors: string[] };

export function validateContract(raw: unknown): ContractValidation {
	if (typeof raw !== "object" || raw === null) {
		return { ok: false, errors: ["契约必须是对象"] };
	}
	const c = raw as Record<string, unknown>;
	const errors: string[] = [];

	const required: [keyof ServiceContract, string][] = [
		["id", "id 必填（全局唯一）"],
		["version", "version 必填"],
		["name", "name 必填"],
		["description", "description 必填"],
		["archetype", "archetype 必填"],
		["execution", "execution 必填"],
		["entry", "entry 必填"],
		["tools", "tools 必填"],
		["capabilities", "capabilities 必填"],
		["emits", "emits 必填"],
		["consumes", "consumes 必填"],
		["permissions", "permissions 必填"],
	];
	for (const [key, msg] of required) {
		if (c[key] === undefined) errors.push(msg);
	}

	if (typeof c.id === "string" && !/^[a-z0-9][a-z0-9-]*$/.test(c.id)) {
		errors.push("id 只能是小写字母/数字/连字符");
	}

	if (
		typeof c.archetype === "string" &&
		!ARCHETYPES.includes(c.archetype as Archetype)
	) {
		errors.push(`archetype 必须是 ${ARCHETYPES.join("/")}`);
	}
	if (
		typeof c.execution === "string" &&
		!EXECUTIONS.includes(c.execution as ExecutionMode)
	) {
		errors.push(`execution 必须是 ${EXECUTIONS.join("/")}`);
	}

	for (const key of ["tools", "skills", "capabilities", "emits", "consumes"]) {
		const v = c[key];
		if (v !== undefined && !Array.isArray(v)) {
			errors.push(`${key} 必须是数组`);
		}
	}

	const perms = c.permissions;
	if (perms !== undefined) {
		if (typeof perms !== "object" || perms === null) {
			errors.push("permissions 必须是对象");
		} else {
			const p = perms as Record<string, unknown>;
			for (const key of ["fs", "net", "tools", "approval"]) {
				if (p[key] !== undefined && !Array.isArray(p[key])) {
					errors.push(`permissions.${key} 必须是数组`);
				}
			}
		}
	}

	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, contract: raw as ServiceContract };
}
