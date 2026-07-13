import { unwrapError } from "./errors";
import type { ToolDefinition } from "./types";

/** read 工具：读取本地文件 */
const readTool: ToolDefinition = {
	type: "function",
	function: {
		name: "read",
		description: "读取本地文件内容",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "文件路径" },
			},
			required: ["path"],
		},
	},
	async execute(args) {
		const path = String(args.path ?? "");
		const file = Bun.file(path);
		const exists = await file.exists();
		if (!exists) return `错误：文件 ${path} 不存在`;
		try {
			return await file.text();
		} catch (e: unknown) {
			return `错误：读取文件 ${path} 失败 — ${unwrapError(e).message ?? e ?? "未知错误"}`;
		}
	},
};

/** write 工具：写入本地文件 */
const writeTool: ToolDefinition = {
	type: "function",
	function: {
		name: "write",
		description: "写入内容到本地文件（覆盖已存在的文件）",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "文件路径" },
				content: { type: "string", description: "写入内容" },
			},
			required: ["path", "content"],
		},
	},
	async execute(args) {
		const path = String(args.path ?? "");
		const content = String(args.content ?? "");
		try {
			await Bun.write(path, content);
			return `文件 ${path} 写入成功（${content.length} 字符）`;
		} catch (e: unknown) {
			return `错误：写入文件 ${path} 失败 — ${unwrapError(e).message ?? e ?? "未知错误"}`;
		}
	},
};

/** grep 工具：在文件中搜索文本 */
const grepTool: ToolDefinition = {
	type: "function",
	function: {
		name: "grep",
		description: "在文件或目录中搜索文本",
		parameters: {
			type: "object",
			properties: {
				pattern: { type: "string", description: "搜索模式" },
				path: { type: "string", description: "搜索路径（默认当前目录）" },
			},
			required: ["pattern"],
		},
	},
	async execute(args) {
		const pattern = String(args.pattern ?? "");
		const searchPath = args.path ? String(args.path) : ".";
		try {
			const proc = Bun.spawnSync(["grep", "-rn", pattern, searchPath]);
			if (proc.exitCode === 0) return proc.stdout.toString();
			if (proc.exitCode === 1) return "未找到匹配";
			return `grep 错误：${proc.stderr.toString()}`;
		} catch {
			return `grep 执行失败（当前环境可能不支持 grep 命令）`;
		}
	},
};

/** bash 工具：执行 shell 命令 */
const bashTool: ToolDefinition = {
	type: "function",
	function: {
		name: "bash",
		description: "执行 shell 命令",
		parameters: {
			type: "object",
			properties: {
				command: { type: "string", description: "要执行的命令" },
			},
			required: ["command"],
		},
	},
	async execute(args) {
		const command = String(args.command ?? "");
		try {
			const proc = Bun.spawnSync(["bash", "-c", command]);
			return (
				proc.stdout.toString() +
				(proc.stderr.toString() ? `\nstderr:\n${proc.stderr.toString()}` : "")
			);
		} catch {
			return `bash 执行失败（当前环境可能不支持 bash）`;
		}
	},
};

/** dispatch 工具的 schema（供编排Agent LLM 识别） */
const dispatchTool: ToolDefinition = {
	type: "function",
	function: {
		name: "dispatch",
		description: [
			"工作流编排：派生子Agent并行执行子任务。仅在用户要求工作流/并行/动态编排时使用。",
			"",
			'⚠ 先 write("plan.md", 内容) 写下计划，否则被拒绝。',
			"",
			"必填参数结构（照这个格式填，不要改字段名）：",
			"dispatch({",
			"  prompt: {",
			'    task: "子Agent要完成的具体任务（必填）",',
			'    role: "子Agent的角色身份（可选）",',
			'    instructions: "行为指引（可选）"',
			"  },",
			'  responseSchema: { type: "object", properties: { ... } }  // 必填',
			"})",
			"",
			"注意：prompt 是一个对象，不是字符串！task 必须放在 prompt 里面！",
			'错误写法：dispatch({ task: "xxx" })',
			'正确写法：dispatch({ prompt: { task: "xxx" } })',
			"",
			"可选参数：",
			'  preload: ["文件路径"],',
			'  isolation: "worktree",',
			"  exploratory: true,",
			"  max_rounds: 5,",
			"  max_time_ms: 300000,",
			'  phase: "阶段名称"',
		].join("\n"),
		parameters: {
			type: "object",
			required: ["prompt", "responseSchema"],
			properties: {
				prompt: {
					type: "object",
					required: ["task"],
					properties: {
						task: {
							type: "string",
							description: "（必填）子Agent要完成的具体任务",
						},
						role: {
							type: "string",
							description: "（可选）子Agent的角色，如「安全审计员」",
						},
						instructions: {
							type: "string",
							description:
								"（可选）子Agent的行为指引。根据 task 和 role 生成详细的身份描述和输出规范，能显著提高回答质量",
						},
					},
				},
				preload: {
					type: "array",
					items: { type: "string" },
					description:
						"子Agent的上下文前缀（文件路径）。同preload组合可命中KV Cache，多个子Agent共享时省钱。不是给子Agent传阅读材料——是构建缓存前缀。",
				},
				responseSchema: {
					type: "object",
					description:
						"子Agent返回的JSON结构定义。用于获取结构化结果（如 keyDecisions）做后续决策。",
				},
				phase: {
					type: "string",
					description: "（可选）当前执行的阶段名称，和 plan.md 中的阶段对齐",
				},
				exploratory: {
					type: "boolean",
					description:
						"（可选）探索模式：true=跳过 plan.md 检查，用于非计划的探索性任务",
				},
				isolation: {
					type: "string",
					enum: ["worktree"],
					description:
						"（可选）隔离模式：worktree=在独立git worktree中执行，避免并行写冲突。仅当多个子Agent可能写同一文件时使用。",
				},
				allowed_tools: {
					type: "array",
					items: {
						type: "string",
						enum: ["read", "write", "edit", "grep", "bash"],
					},
					description:
						"（可选）子Agent可用工具。不传=全部可用，传[]=纯LLM无工具。",
				},
			},
		},
	},
};

/** 所有可用的工具定义 */
export const ALL_TOOLS: ToolDefinition[] = [
	readTool,
	writeTool,
	grepTool,
	bashTool,
	dispatchTool,
];

/** 根据工具名称执行（不走权限检查，直接调用） */
export async function executeTool(
	toolName: string,
	args: Record<string, unknown>,
): Promise<string> {
	const tool = ALL_TOOLS.find((t) => t.function.name === toolName);
	if (!tool) return `错误：未知工具 ${toolName}`;
	if (!tool.execute) return `错误：工具 ${toolName} 无法执行`;
	return await tool.execute(args);
}
