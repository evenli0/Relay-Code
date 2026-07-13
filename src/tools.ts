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
		description:
			"工作流编排：派生子Agent并行执行子任务。三个参数按顺序填：dispatch(任务, 角色, 格式描述)",
		parameters: {
			type: "object",
			required: ["task"],
			properties: {
				task: {
					type: "string",
					description: "（必填）子Agent要完成的具体任务",
				},
				role: {
					type: "string",
					description: "（可选）子Agent的角色身份",
				},
				format: {
					type: "string",
					description: "（可选）返回数据格式说明",
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
