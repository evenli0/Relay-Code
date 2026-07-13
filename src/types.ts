// ---- Tool Calling 类型 ----

/** LLM 调用返回（支持 tool calling） */
export interface LLMResponse {
	content: string | null;
	reasoning_content?: string | null;
	tool_calls?: ToolCall[];
}

/** OpenAI 兼容的工具调用 */
export interface ToolCall {
	id: string;
	type: "function";
	function: {
		name: string;
		arguments: string;
	};
}

/** 工具定义（schema + 执行函数） */
export interface ToolDefinition {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
	execute?: (args: Record<string, unknown>) => Promise<string>;
}

/** ReAct 循环中的消息格式 */
export type ChatMessage =
	| { role: "system"; content: string }
	| { role: "user"; content: string }
	| {
			role: "assistant";
			content: string | null;
			tool_calls?: ToolCall[];
			reasoning_content?: string | null;
	  }
	| { role: "tool"; content: string; tool_call_id: string };

/** 最大 ReAct 循环轮数 */
export const MAX_REACT_ITERATIONS = 20;

/** LLM 单次调用超时（毫秒） */
export const LLM_CALL_TIMEOUT_MS = 120_000;

// ---- SubAgent / Harness 类型 ----

/** Dispatch 配置（编排Agent传给dispatch工具的完整参数） */
export interface DispatchConfig {
	preload?: string[];
	prompt: {
		task: string;
		role?: string;
		instructions?: string;
	};
	allowed_tools?: string[];
	/** 子Agent输出的JSON结构 */
	responseSchema: Record<string, unknown>;
	/** 可选：当前阶段名称，和 plan.md 对齐 */
	phase?: string;
	/** 探索模式：跳过 plan.md 检查，用于非计划的探索性任务 */
	exploratory?: boolean;

	/** worktree 隔离执行：在独立 git worktree 中运行，避免并行写冲突。仅当多个子Agent 可能写同一文件时需要。 */
	isolation?: "worktree";
	/** 可选：计划上下文（已弃用，改用 plan.md 文件） */
	plan?: {
		goal: string;
		phases: {
			name: string;
			description: string;
		}[];
	};
}

/** 子Agent完整回执 */
export interface SubAgentResult {
	status: "completed" | "error";
	output: string;
	/** 如果 dispatch 指定了 responseSchema，此处为解析后的结构化数据，否则为 null */
	structured?: Record<string, unknown> | null;
}

/** 运行时检查：判断原始参数是否为有效的 DispatchConfig */
export function isDispatchConfig(
	raw: Record<string, unknown>,
): raw is Record<string, unknown> & DispatchConfig {
	const prompt = raw.prompt;
	if (!prompt || typeof prompt !== "object") return false;
	return typeof (prompt as Record<string, unknown>).task === "string";
}
