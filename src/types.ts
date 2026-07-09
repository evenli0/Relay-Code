/** Agent ID，全局唯一 */
export type AgentId = string

/** 子Agent状态 */
export type AgentStatus = "pending" | "running" | "completed" | "error"

/** dispatch 参数 */
export interface DispatchOpts {
  recipient: AgentId
  prompt: string
  allowed_tools?: string[]
}

/** 子Agent执行结果 */
export interface AgentResult {
  agent_id: AgentId
  status: AgentStatus
  output: string
  process: string
}

/** Agent 注册记录 */
export interface AgentRecord {
  id: AgentId
  parent_id: AgentId | null
  status: AgentStatus
  task: string
  result: AgentResult | null
  depth: number
  created_at: Date
}

// ---- Tool Calling 类型 ----

/** LLM 调用返回（支持 tool calling） */
export interface LLMResponse {
  content: string | null
  tool_calls?: ToolCall[]
}

/** OpenAI 兼容的工具调用 */
export interface ToolCall {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

/** 工具定义（schema + 执行函数） */
export interface ToolDefinition {
  type: "function"
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
  execute: (args: Record<string, unknown>) => Promise<string>
}

/** ReAct 循环中的消息格式 */
export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string }

/** 资源清单中的一条 */
export interface Resource {
  name: string
  path?: string
  type: "memory" | "asset"
  cached: boolean
  pricePer1K: number
  description: string
}

/** 最大 ReAct 循环轮数 */
export const MAX_REACT_ITERATIONS = 20

// ---- SubAgent / Harness 类型 ----

/** Dispatch 配置（编排Agent传给dispatch工具的完整参数） */
export interface DispatchConfig {
  preload?: string[]
  prompt: {
    role?: string
    constraints?: string[]
    task: string
    anything_else?: string
  }
  allowed_tools?: string[]
}

/** 子Agent执行过程的每一步 */
export interface ProcessStep {
  step: number
  type: "llm_call" | "tool_call" | "tool_result" | "interception" | "final"
  content: string
  tool_name?: string
  tool_args?: string
}

/** 子Agent完整回执 */
export interface SubAgentResult {
  status: "completed" | "error"
  output: string
  process: ProcessStep[]
}

/** 编排Agent的固定ID */
export const ORCHESTRATOR_ID = "orchestrator"
/** 编排Agent默认权限（全部工具） */
export const ORCHESTRATOR_PERMISSIONS = ["read", "write", "grep", "bash", "dispatch"]
