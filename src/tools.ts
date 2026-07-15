import { unwrapError } from "./errors";
import type { ToolDefinition } from "./types";
import { existsSync } from "node:fs";

const isWindows = process.platform === "win32";

function resolveShell(): { bin: string; flag: string } {
  if (!isWindows) return { bin: "bash", flag: "-c" };
  // Windows: 探测 Git Bash
  const gitBashPaths = [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  ];
  for (const p of gitBashPaths) {
    if (existsSync(p)) return { bin: p, flag: "-c" };
  }
  // fallback 到 cmd
  return { bin: "cmd", flag: "/c" };
}

function resolveGrep(): { bin: string; args: string[] } | null {
  if (!isWindows) return null; // Unix: 使用默认 grep
  const gitUsrBin = "C:\\Program Files\\Git\\usr\\bin\\grep.exe";
  if (existsSync(gitUsrBin)) {
    return { bin: gitUsrBin, args: [] };
  }
  return null; // 使用 PowerShell fallback
}

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

		// Windows: 尝试 Git Bash grep → PowerShell Select-String
		if (isWindows) {
			const gitGrep = resolveGrep();
			if (gitGrep) {
				try {
					const proc = Bun.spawnSync([gitGrep.bin, "-rn", pattern, searchPath]);
					if (proc.exitCode === 0) return proc.stdout.toString();
					if (proc.exitCode === 1) return "未找到匹配";
					return `grep 错误：${proc.stderr.toString()}`;
				} catch { /* fall through */ }
			}
			// PowerShell fallback
			try {
				const psCmd = `Select-String -Pattern '${pattern}' -Path '${searchPath}\\*' -Recurse | ForEach-Object { "\\($_.Filename):\\($_.LineNumber):\\($_.Line.Trim())" }`;
				const proc = Bun.spawnSync(["powershell", "-Command", psCmd]);
				if (proc.exitCode === 0) return proc.stdout.toString() || "未找到匹配";
			} catch { /* fall through */ }
			return "grep 执行失败（Windows 上未安装 Git Bash，且 PowerShell 搜索也失败）";
		}

		// Unix 原有逻辑
		try {
			const proc = Bun.spawnSync(["grep", "-rn", pattern, searchPath]);
			if (proc.exitCode === 0) return proc.stdout.toString();
			if (proc.exitCode === 1) return "未找到匹配";
			return `grep 错误：${proc.stderr.toString()}`;
		} catch {
			return "grep 执行失败（当前环境可能不支持 grep 命令）";
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
		const shell = resolveShell();
		try {
			const proc = Bun.spawnSync([shell.bin, shell.flag, command], {
				timeout: 30_000, // 30秒超时
			});
			return (
				proc.stdout.toString() +
				(proc.stderr.toString() ? `\nstderr:\n${proc.stderr.toString()}` : "")
			);
		} catch {
			return `bash 执行失败（当前环境可能不支持 ${shell.bin}）`;
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
				exploratory: {
					type: "boolean",
					description: "设为 true 可在没有 plan.md 的情况下执行探索性任务",
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
