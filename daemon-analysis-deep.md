# Relay-Code Daemon 架构深度分析

> 分析日期: 2025-07-09  
> 项目版本: 0.1.0  
> 运行时: Bun (TypeScript)

---

## 一、总体架构图

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          L0 启动层 (Entry)                              │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  src/index.ts                                                    │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────────┐  ┌─────────────┐ │   │
│  │  │ CLI 解析  │→ │ 管道检测  │→ │ 模式路由      │→ │ daemonMode()│ │   │
│  │  │ --daemon  │  │ stdin    │  │ chat/daemon/  │  │ chatMode()  │ │   │
│  │  │ --chat    │  │ 检测     │  │ single        │  │ main()      │ │   │
│  │  └──────────┘  └──────────┘  └──────────────┘  └─────────────┘ │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                      │                                   │
│                                      ▼                                   │
│                         初始化 Core  Triad                               │
│              ┌───────────────────┼────────────────────┐                  │
│              ▼                   ▼                    ▼                  │
│        ┌──────────┐      ┌──────────────┐      ┌──────────────┐        │
│        │  Inbox   │      │AgentRegistry │      │Orchestrator  │        │
│        │ (收件箱)  │      │ (注册表)     │      │ (编排器)     │        │
│        └──────────┘      └──────────────┘      └──────────────┘        │
└──────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                     L1 编排层 (Orchestration)                           │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  src/orchestrator.ts                                            │   │
│  │  ┌──────────────────────┐       ┌──────────────────────────┐   │   │
│  │  │  start()             │       │  runReAct()              │   │   │
│  │  │  ┌─ 事件循环          │       │  (单次兼容模式)           │   │   │
│  │  │  │ 1. inbox.drain()  │       └──────────────────────────┘   │   │
│  │  │  │ 2. 优先级分类      │                                       │   │
│  │  │  │ 3. user优先处理    │─────── reactLoop() ──────────────────►│   │
│  │  │  │ 4. agentBatch处理  │                                       │   │
│  │  │  └─ 5. 周期性清理     │                                       │   │
│  │  └──────────────────────┘                                       │   │
│  │                                                                   │   │
│  │  ┌────────────────────────────────────────────────────────────┐   │   │
│  │  │  reactLoop() — ReAct 推理循环                              │   │   │
│  │  │  1. 注入集群快照 (agentRegistry.getSnapshot())             │   │   │
│  │  │  2. 注入 Plan 状态 (PlanManager)                           │   │   │
│  │  │  3. callLLM(messages, ALL_TOOLS) → LLMResponse             │   │   │
│  │  │  4. 解析 tool_calls → 并行执行                             │   │   │
│  │  │  5. 工具结果回写 messages                                  │   │   │
│  │  │  6. 迭代直到无 tool_calls 或达到 MAX_REACT_ITERATIONS      │   │   │
│  │  └────────────────────────────────────────────────────────────┘   │   │
│  └──────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                      L2 执行层 (Execution)                               │
│                                                                          │
│  ┌──────────────────────────┐    ┌──────────────────────────────┐       │
│  │  src/harness.ts          │    │  src/tool-executor.ts        │       │
│  │  Facade 外观层           │───►│  工具调用路由                 │       │
│  │  ┌─ PlanManager          │    │  ┌─ executeToolCall()        │       │
│  │  ├─ ToolExecutor         │    │  │  ├─ read/write/grep/bash │       │
│  │  ├─ dispatch (同步)      │    │  │  ├─ dispatch (同步回调)   │       │
│  │  └─ dispatchFireAndForget│    │  │  └─ dispatch (异步火发)   │       │
│  └──────────────────────────┘    │  └──────────────────────────┘       │
│                                   │                                      │
│                                   ▼                                      │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  src/dispatcher.ts — SubAgent 生命周期管理                       │   │
│  │                                                                   │   │
│  │  ┌────────────────┐     ┌────────────────────┐                   │   │
│  │  │  dispatch()    │     │  dispatchAsync()   │                   │   │
│  │  │  同步模式       │     │  异步火发模式       │                   │   │
│  │  │  1. 创建worktree│     │  1. registry.register()              │   │
│  │  │  2. 拼装messages│     │  2. 写 task JSON 到文件              │   │
│  │  │  3. new SubAgent│     │  3. Bun.spawn(subagent-cli.ts)       │   │
│  │  │  4. subAgent.run│     │  4. 注册 onExit 回调                 │   │
│  │  │  5. 变更检测     │     │  5. 完成后推事件到 inbox             │   │
│  │  │  6. 解析 JSON   │     │  6. 更新 registry 状态              │   │
│  │  └────────────────┘     └────────────────────┘                   │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                   │                                      │
│                                   ▼                                      │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  src/subagent-cli.ts — 子 Agent 进程入口                        │   │
│  │                                                                   │   │
│  │  1. 读取 task JSON 文件                                          │   │
│  │  2. assembleMessages() 拼装对话                                  │   │
│  │  3. 创建 SubAgent 实例                                           │   │
│  │  4. 写入 progress 文件 (轮次/动作/摘要)                          │   │
│  │  5. 写入 conversation JSONL (完整时间线)                          │   │
│  │  6. subAgent.run() → ReAct 循环                                   │   │
│  │  7. 写 result JSON 文件                                          │   │
│  │  8. process.exit(0/1)                                            │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                   │                                      │
│                                   ▼                                      │
│  ┌──────────────────────────────┐    ┌────────────────────────────┐    │
│  │  src/react-loop.ts          │    │  src/message-assembler.ts  │    │
│  │  ReAct 辅助函数              │    │  子 Agent 消息拼装         │    │
│  │  ┌─ parseToolArgs()         │    │  ┌─ 子 Agent system prompt │    │
│  │  ├─ buildAssistantMessage() │    │  ├─ 注入上下文文件          │    │
│  │  └─ buildToolMessage()      │    │  ├─ 注入 role/instructions │    │
│  └──────────────────────────────┘    │  └─ 注入 responseSchema   │    │
│                                       └────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                    L3 持久化层 (Persistence)                              │
│                                                                          │
│  ┌──────────────────────────┐    ┌──────────────────────────────┐       │
│  │  src/memory.ts           │    │  src/agent-registry.ts       │       │
│  │  对话记忆系统             │    │  子 Agent 状态追踪           │       │
│  │  ┌─ saveDialogue()       │    │  ┌─ L1: getSnapshot()       │       │
│  │  │  追加到 daily JSONL   │    │  ├─ L2: peek()/peekAsContext│       │
│  │  ├─ listMemoryFiles()    │    │  ├─ L3: readConversation()  │       │
│  │  └─ readMemoryFile()     │    │  └─ cleanup() 超时清理      │       │
│  └──────────────────────────┘    └──────────────────────────────┘       │
│                                                                          │
│  ┌──────────────────────────┐    ┌──────────────────────────────┐       │
│  │  src/plan-manager.ts     │    │  src/plan-state.ts           │       │
│  │  Plan 注入管理器          │    │  Plan 状态机                 │       │
│  │  ┌─ getPlanMessages()    │───►│  ┌─ 解析 plan.md 阶段       │       │
│  │  │  状态键去重注入        │    │  ├─ advance() 推进          │       │
│  │  └─ 依赖 PlanState       │    │  ├─ buildMessage()          │       │
│  └──────────────────────────┘    │  └─ load() 从文件加载       │       │
│                                   └──────────────────────────────┘       │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  磁盘文件结构                                                      │   │
│  │  memory/                          — 对话记录                     │   │
│  │    dialogue_YYYY-MM-DD.jsonl      — 按日分片                     │   │
│  │  .relay/                                                         │   │
│  │    tasks/                                                         │   │
│  │      agent-xxx.json               — 子 Agent 任务配置            │   │
│  │      agent-xxx.result.json        — 子 Agent 执行结果            │   │
│  │      agent-xxx.progress.json      — 子 Agent 进度快照            │   │
│  │      agent-xxx.conversation.jsonl  — 子 Agent 完整对话           │   │
│  │    worktrees/                     — git worktree 隔离运行目录    │   │
│  │  plan.md                          — 主计划文件                   │   │
│  └──────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 二、分层架构详解

### L0 启动层 — Entry & Bootstrap

| 模块 | 文件 | 职责 |
|------|------|------|
| CLI 入口 | `src/index.ts` | 参数解析、模式路由、.env 自动加载 |

**启动流程：**

```
main()
  ├─ 加载 .env (如果存在)
  ├─ 检测 stdin 管道模式 (非 TTY 时读取管道输入)
  ├─ 参数路由:
  │   ├─ --help      → showHelp()
  │   ├─ --version   → 输出版本号
  │   ├─ --chat      → chatMode()
  │   ├─ --daemon    → daemonMode()
  │   └─ 无参数       → showHelp()
  └─ 默认: 单次模式 → new Inbox + AgentRegistry + Orchestrator → runReAct()
```

**daemonMode() 初始化：**
1. 创建 `Inbox` 实例 — 事件收件箱
2. 创建 `AgentRegistry` 实例 — 子 Agent 注册表
3. 创建 `Orchestrator` 实例 — 传入 inbox + registry
4. 设置 stdin 监听（`readline.on("line")`）：  
   - `exit` → 关闭进程  
   - `status` → 打印集群快照  
   - `peek <id>` → 查看特定 Agent 细节  
   - 其他文本 → 推入 `inbox` 作为 `user_message` 事件  
5. 调用 `orchestrator.start()` — 进入事件循环

**关键设计决策：**
- `.env` 加载失败不报错，允许通过环境变量注入
- 管道模式优先于 CLI 参数，支持 Unix 式管道传递任务
- 三种模式共享同一个 `Orchestrator` 核心，只是调用方式不同

---

### L1 编排层 — Orchestration

| 模块 | 文件 | 职责 |
|------|------|------|
| 编排器 | `src/orchestrator.ts` | 事件循环、优先级调度、ReAct 推理循环 |
| 收件箱 | `src/inbox.ts` | 事件队列：push / drain / isEmpty |

#### Inbox — 事件收件箱

```typescript
class Inbox {
  private queue: AgentEvent[] = [];

  push(event: AgentEvent): void     // 入队
  drain(): AgentEvent[]             // 批量取出并清空
  isEmpty(): boolean                // 检查是否为空
  get size(): number                // 当前队列长度
}
```

事件类型 (`AgentEvent`)：
- `user_message` — 用户指令（threadId + content）
- `agent_done` — 子 Agent 完成（threadId + result + agentRole + agentId）
- `agent_error` — 子 Agent 错误（threadId + error + agentRole + agentId）

**设计亮点：** 轻量级无锁队列，不关心消息来源，只关心顺序和分类。

#### Orchestrator — 主编排器

**事件循环 (`start()`):**

```
while (true)
  ├─ 每 1000ms 轮询 inbox
  ├─ 每 10 轮执行 registry.cleanup()
  ├─ inbox.drain() → 取出全部事件
  ├─ 按 type 分类:
  │   ├─ user_message → processUserMessage(msg)
  │   ├─ agent_error  → 即时打印错误到 stderr
  │   └─ agent_done   → processAgentBatch(dones)
  └─ 清理计数器
```

**优先级策略：**
1. **User 消息优先** — 用户指令单独一轮处理，立即响应
2. **Agent 错误即时输出** — 不阻塞、不排队
3. **Agent 完成批量处理** — 多个完成结果合并一轮注入 LLM

**ReAct 循环 (`reactLoop()`):**

```
for (i = 0; i < MAX_REACT_ITERATIONS; i++)
  ├─ 1. 注入集群状态快照 (registry.getSnapshot(), 去重)
  ├─ 2. 注入 Plan 状态 (PlanManager.getPlanMessages(), 去重)
  ├─ 3. callLLM(messages, ALL_TOOLS) → LLMResponse
  ├─ 4. 无 tool_calls → 返回文本结果 (完成)
  ├─ 5. 有 tool_calls → 并行执行所有工具
  │   ├─ dispatch → 异步火发 (dispatchAsync) / 同步 (dispatch)
  │   ├─ read/write/grep/bash → ToolExecutor.executeToolCall()
  │   └─ 结果回写入 messages
  └─ 6. 迭代或超限返回
```

**错误处理策略：**
- LLM 超时（AbortError）→ 2s 后重试
- API Key 缺失 → 友好提示并终止
- 通用异常 → 1s 后重试
- 连续空结果 → 2 轮后提前终止

---

### L2 执行层 — Execution

| 模块 | 文件 | 职责 |
|------|------|------|
| 外观层 | `src/harness.ts` | 组合 PlanManager + ToolExecutor + dispatch |
| 工具执行器 | `src/tool-executor.ts` | 工具调用路由，同步/异步 dispatch |
| 分发器 | `src/dispatcher.ts` | SubAgent 创建、执行、结果回写 |
| 子 Agent CLI | `src/subagent-cli.ts` | 独立进程入口 |
| 消息拼装 | `src/message-assembler.ts` | 构造子 Agent 的对话消息 |
| ReAct 辅助 | `src/react-loop.ts` | 工具参数解析、消息构建 |

#### Harness — 外观层

```typescript
class Harness {
  planManager: PlanManager        // Plan 注入管理
  executor: ToolExecutor          // 工具执行路由
  dispatch(config)                // 同步 dispatch
  dispatchFireAndForget(config)   // 异步火发 dispatch
  executeToolCall(name, args)     // 工具调用入口
  getPlanMessages()              // 获取 Plan 注入消息
}
```

**双模式设计：**
- **同步模式**：无 inbox/registry → dispatch 走回调等待结果
- **异步模式**：有 inbox/registry → dispatch 走火发，结果通过 inbox 事件通知

#### ToolExecutor — 工具执行路由

核心逻辑 `executeToolCall()`：
1. **dispatch** 工具 → 检查是否异步模式（火发）还是同步模式（等待）
2. **其他工具** (read/write/grep/bash) → 从 ALL_TOOLS 查找执行函数
3. **worktree 路径解析** → 如果指定了 cwd，相对路径转为 worktree 内绝对路径
4. **bash 特殊处理** → 在 worktree 目录内以 spawnSync 执行

#### dispatcher.ts — 分发与 SubAgent

**同步 dispatch (dispatch())**：
1. 可选：创建 git worktree 隔离（`isolation: "worktree"`）
2. `assembleMessages(config)` — 拼装 ChatMessage[]
3. `new SubAgent(messages, tools, executor, cwd)` — 创建实例
4. `subAgent.run()` — 执行 ReAct 循环
5. 变更检测：有文件修改则保留 worktree，无则删除
6. 可选：解析结构化 JSON（responseSchema）

**异步火发 (dispatchAsync())**：
1. `registry.register(agentId, role, threadId)` — 注册状态
2. 写 task JSON 到 `.relay/tasks/{agentId}.json`
3. `Bun.spawn(["bun", "run", "src/subagent-cli.ts", taskPath])` — 启动独立进程
4. 注册 `onExit` 回调：
   - 成功 → `registry.markDone()` + inbox.push(`agent_done`)
   - 失败 → `registry.markError()` + inbox.push(`agent_error`)
5. `proc.unref()` — 不阻塞父进程退出

#### SubAgent — 子 Agent 执行器

独立 ReAct 循环，共享相同架构：
```
for (i = 0; i < maxRounds; i++)
  ├─ 超时检测 (maxTimeMs)
  ├─ callLLM(messages, allowedTools) + AbortController 超时
  ├─ 无 tool_calls → 返回 completed + output
  ├─ JSON 解析失败 → maxTokens 翻倍重试
  ├─ 并行执行工具 → 结果回写
  ├─ 进度回调 → 写 progress 文件
  ├─ 空结果检测 → 连续 2 轮空则提前终止
  └─ 对话追加 → conversation JSONL
```

**子 Agent 安全措施：**
- `maxRounds` 限制（默认 30，不超过全局 MAX_REACT_ITERATIONS=60）
- `maxTimeMs` 总执行时间限制
- `LLM_CALL_TIMEOUT_MS = 120s` 单次调用超时
- `allowedTools` 白名单限制
- 截断检测 + maxTokens 动态翻倍

#### subagent-cli.ts — 独立进程入口

```
读取 task JSON → assembleMessages → 创建/写入 progress + conversation 文件
→ new SubAgent().run() → 写 result JSON → process.exit(0/1)
```

**IPC 通信机制：** 文件系统作为通信媒介
- 输入：`{agentId}.json` (DispatchConfig)
- 进度：`{agentId}.progress.json` (AgentProgress)
- 对话：`{agentId}.conversation.jsonl` (JSON Lines)
- 输出：`{agentId}.result.json` (SubAgentResult)

子 Agent 和 daemon 之间**没有网络 IPC 或进程间管道**，全部通过文件交换数据。daemon 监听 `Bun.spawn().onExit` 回调来得知子 Agent 完成。

---

### L3 持久化层 — Persistence

| 模块 | 文件 | 职责 |
|------|------|------|
| 对话记忆 | `src/memory.ts` | 按日分片的 JSONL 对话记录 |
| 状态追踪 | `src/agent-registry.ts` | 三层子 Agent 状态追踪 |
| Plan 管理 | `src/plan-manager.ts` | Plan 注入去重管理 |
| Plan 状态机 | `src/plan-state.ts` | plan.md 解析与阶段推进 |

#### memory.ts — 对话持久化

```typescript
interface DialogueEntry {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  ts: string;          // ISO 时间戳
  session: string;     // 进程级会话 ID
}
```

- 文件：`memory/dialogue_YYYY-MM-DD.jsonl`
- 写入：原子 append（无竞争条件）
- 查询：`listMemoryFiles()` / `readMemoryFile(path)`
- 会话隔离：每个进程生成唯一 `SESSION_ID`，可通过 session 字段关联

#### agent-registry.ts — 三层状态追踪

**L1 — getSnapshot()：** 一行式集群概览，不进 LLM 上下文
```
## 子 Agent 运行状态
  ⟳ 代码审查 (a3f8b2c1): 第5轮 read — 分析中...
  ✓ 测试生成 (d4e5f6a2): 已完成
  ✗ 部署脚本 (b7c8d9e3): 超时错误
```

**L2 — peek(id) / peekAsContext(id)：** 按需注入 LLM 的详细状态
- 当前进度（轮次、动作、摘要、耗时）
- 近期时间线（最近 8 条历史）
- 完成摘要

**L3 — readConversation(id)：** 从文件读取完整 JSONL 对话，深度排查用

**生命周期管理：**
- `register(id, role, threadId)` → running
- `markDone(id, summary)` / `markError(id, error)` → done / error
- `appendHistory(id, entry)` → 追加轮次历史（内存，最多 20 条）
- `cleanup(maxAgeMs=600s)` → 清理超时的非 running 状态

#### plan-manager.ts + plan-state.ts — 计划管理

**PlanState 状态机：**
```
解析 plan.md → 提取阶段列表 (Phase[]) → 状态追踪 (pending/running/completed/failed)
  ├─ getPhaseDigest() → 状态键 (用于去重)
  ├─ advance() → 当前阶段完成，推进到下一阶段
  ├─ isCompleted() → 全部完成检查
  └─ buildMessage() → 构造注入 LLM 的 Plan 编排指令
```

**PlanManager 去重注入：**
- `getPlanMessages()` → 仅当 `getStatusKey()` 变化时才返回消息
- 避免重复注入相同 Plan 状态，防止上下文爆炸

**plan.md 格式约定：**
```markdown
## 阶段 1：需求分析 ✅
  - [x] 分析用户需求文档
  - [x] 识别关键功能点

## 阶段 2：架构设计 ⬜
  - [ ] 设计系统架构
  - [ ] 定义模块接口
```

---

## 三、数据流分析

### 3.1 用户指令数据流

```
用户输入 "分析代码结构"
  │
  ▼
index.ts → readline.on("line")
  │ push({type: "user_message", content: "分析代码结构"})
  ▼
Inbox.queue
  │ drain()
  ▼
Orchestrator.start() → processUserMessage(msg)
  │
  ├─ 1. inject registry snapshot → messages
  ├─ 2. inject plan status → messages
  ├─ 3. messages.push({role: "user", content: input})
  │
  ▼
reactLoop()
  ├─ callLLM() → tool_calls
  ├─ executeToolCall("read", {path: "src/"})
  ├─ callLLM() → dispatch
  ├─ dispatchAsync() → Bun.spawn(subagent-cli.ts)
  │   └─ "已发出，agentId: agent-xxx"
  ├─ callLLM() → 无 tool_calls → 返回结果给用户
  │
  ▼
控制台输出 + 等待下一指令
```

### 3.2 子 Agent 完成数据流

```
SubAgent 独立进程完成
  │ writeFileSync(result.json)
  │ process.exit(0)
  ▼
Bun.spawn().onExit 回调
  │ 读取 result.json
  │ registry.markDone(agentId, summary)
  │ inbox.push({type: "agent_done", result, agentRole, agentId})
  ▼
Orchestrator.start() 下一轮循环
  │ drain() → 检测到 agent_done
  │ processAgentBatch([dones...])
  │
  ├─ 批量格式化为 Markdown detail
  ├─ 打印到控制台（子 Agent 完成通知）
  ├─ 注入 LLM（system message）
  └─ reactLoop() → LLM 生成总结
```

### 3.3 启动到关闭的完整生命周期

```
1. main() 调用
2. .env 加载
3. 参数/管道检测
4. daemonMode():
   a. new Inbox()
   b. new AgentRegistry()
   c. new Orchestrator(inbox, registry)
   d. 设置 stdin readline 监听
   e. orchestrator.start()

5. 事件循环 (无限):
   ├─ 1000ms 轮询
   ├─ 分类处理事件
   ├─ 周期性 cleanup
   └─ 子 Agent 任务:
       ├─ dispatchAsync → spawn 子进程
       ├─ 子进程独立执行 ReAct
       └─ 完成 → inbox 事件 → 编排器处理

6. 用户输入 "exit":
   ├─ readline.close()
   └─ process.exit(0)

7. 进程终止 → 所有 unref() 子进程继续运行直到完成
```

---

## 四、模块职责速查

| 模块 | 文件 | 核心职责 |
|------|------|----------|
| `Inbox` | `inbox.ts` | 事件队列，push/drain/isEmpty |
| `AgentRegistry` | `agent-registry.ts` | 子 Agent 三层状态追踪 + 生命周期管理 |
| `Orchestrator` | `orchestrator.ts` | 事件循环 + 优先级调度 + ReAct 循环 |
| `Harness` | `harness.ts` | Facade，组合 PlanManager+ToolExecutor+dispatch |
| `ToolExecutor` | `tool-executor.ts` | 工具调用路由，dispatch 同步/异步分发 |
| `dispatch` | `dispatcher.ts` | SubAgent 创建与执行，worktree 隔离 |
| `SubAgent` | `dispatcher.ts` | 子 Agent ReAct 执行器 |
| `subagent-cli` | `subagent-cli.ts` | 独立子进程入口，文件 IPC 接口 |
| `message-assembler` | `message-assembler.ts` | 子 Agent 对话消息拼装 |
| `PlanManager` | `plan-manager.ts` | Plan 注入去重管理 |
| `PlanState` | `plan-state.ts` | plan.md 解析 + 阶段状态机 |
| `memory` | `memory.ts` | 按日分片 JSONL 对话持久化 |
| `react-loop` | `react-loop.ts` | 工具参数解析、消息构建辅助 |
| `worktree` | `worktree.ts` | git worktree 创建/删除/变更检测 |
| `types` | `types.ts` | 全局类型定义与常量 |
| `prompts` | `prompts.ts` | 主 Agent 系统提示模板 |
| `llm` | `llm.ts` | LLM API 调用封装 |
| `display` | `display.ts` | 终端 UI（spinner/status line/进度条） |
| `tools` | `tools.ts` | 工具定义数组 (read/write/grep/bash) |
| `errors` | `errors.ts` | 错误处理工具函数 |

---

## 五、架构设计亮点

### 5.1 事件驱动 + 异步火发模式
- 主 Agent 不阻塞等待子 Agent 完成，通过 `inbox` 事件队列解耦
- `dispatchAsync` 火发后立即返回，子 Agent 在独立进程运行
- 批量处理完成通知，减少 LLM 上下文切换次数

### 5.2 文件系统 IPC
- 不使用网络端口、Unix Socket 或管道
- 通过 JSON 文件交换任务输入/输出/进度/对话
- 天然支持进程隔离（SubAgent 崩溃不影响 daemon）
- 持久化留存便于调试和审计

### 5.3 三层状态追踪 (L1/L2/L3)
- L1 快照：零成本注入，LLM 不看到
- L2 详情：按需注入，避免上下文爆炸
- L3 完整对话：文件级深度排查
- 智能去重：只有状态变化时才注入

### 5.4 优先级调度
- User 消息优先处理，保证交互响应速度
- Agent 错误即时输出，不排队
- Agent 完成批量合并，减少 LLM 调用次数

### 5.5 Worktree 执行隔离
- 使用 git worktree 为子 Agent 创建独立工作目录
- 避免多个子 Agent 并行写文件冲突
- 变更检测：有修改保留 worktree，无修改自动清理

### 5.6 Plan 状态机驱动
- `plan.md` 作为外部 DSL，解析为阶段状态机
- `PlanState` 跟踪阶段推进
- `PlanManager` 去重注入，避免 LLM 上下文膨胀

### 5.7 优雅的错误处理
- LLM 调用超时 → 自动重试
- API Key 缺失 → 友好提示
- 截断检测 → maxTokens 动态翻倍
- 连续空结果 → 提前终止

---

## 六、潜在改进点

### 6.1 亟需改进

| 问题 | 描述 | 建议 |
|------|------|------|
| **单点故障** | Orchestrator 单进程运行，崩溃导致所有子 Agent 状态丢失 | 引入进程管理（PM2 / systemd）实现重启恢复 |
| **文件系统竞争** | 多个子 Agent 同时写 result JSON 但路径不同，但 registry 状态仅在内存中 | 引入 SQLite 替代文件系统 IPC，或至少做 registry 持久化快照 |
| **内存泄漏风险** | `Orchestrator.messages` 无限增长，长时间运行可能 OOM | 引入滑动窗口（保留最近 N 轮），或定期 checkpoint 并截断 |
| **缺乏并发控制** | 多个 user_message 同时入队可能互相干扰 | 引入 per-thread 队列或互斥锁 |

### 6.2 建议改进

| 问题 | 描述 | 建议 |
|------|------|------|
| **无健康检查** | 子 Agent 进程可能挂死但没有心跳检测 | 子 Agent 定期写 heartbeat 文件，daemon 检测超时后 kill 重启 |
| **日志分散** | 日志分布在 memory/、.relay/tasks/、stdout/stderr 多个位置 | 统一结构化日志，支持日志级别和采集 |
| **缺乏速率限制** | dispatchAsync 无限制，可能同时 spawn 大量子进程 | 引入最大并发数 Semaphore（如 max 5 个同时运行） |
| **Plan 仅单文件** | `plan.md` 仅支持单文件，多项目复杂场景不足 | 支持 `plans/` 目录多 plan 文件 + 场景切换 |
| **没有会话管理** | `session` 字段已定义但未用于隔离 | 实现多会话隔离，每个会话独立消息上下文和 Agent 注册表 |
| **子 Agent 无缓存** | 相同任务可能重复执行 | 引入任务哈希缓存，相同输入直接返回历史结果 |
| **缺少 TLS/认证** | 虽然当前是本地 CLI 工具，但扩展为网络服务时需要 | 预留 Auth 中间件接口 |
| **测试覆盖不足** | 核心模块缺少单元测试 | 增加 Orchestrator、Dispatcher、AgentRegistry 的单元测试 |
| **配置硬编码** | `TASKS_DIR=".relay/tasks"`、`MEMORY_DIR="memory"` 等路径硬编码 | 统一配置管理，支持环境变量覆盖 |
| **Bun 特定 API** | 大量使用 `Bun.spawn`、`Bun.file` 等 Bun 专有 API | 抽象平台层，支持 Node.js 兼容运行 |

### 6.3 架构演进方向

```
当前: 单进程 daemon + 独立子进程 (文件 IPC)
  │
  ├─ 短中期: 引入消息队列 (Redis/NATS) 替代文件 IPC
  │   ├─ 子 Agent 改为 Worker 模式
  │   ├─ 支持分布式部署
  │   └─ 任务持久化 + 失败重试
  │
  └─ 长期: 微服务化
      ├─ Orchestrator Service
      ├─ Agent Pool (SubAgent 集群)
      ├─ Memory Service (对话存储)
      └─ API Gateway (HTTP/WebSocket 接口)
```

---

## 七、技术栈与依赖

| 组件 | 技术选型 |
|------|----------|
| 运行时 | Bun (TypeScript) |
| LLM API | DeepSeek (OpenAI 兼容接口) |
| IPC | 文件系统 (JSON + JSONL) |
| 隔离 | git worktree |
| 持久化 | 文件系统 (JSONL 按日分片) |
| CLI | 原生 readline |
| 进程管理 | Bun.spawn / proc.unref() |

---

## 八、总结

Relay-Code 的 daemon 架构是一个**事件驱动的多 Agent 编排系统**，核心设计理念是：

1. **异步优先** — 主 Agent 不阻塞等待子 Agent，通过事件队列解耦
2. **文件即契约** — 文件系统作为进程间通信的共享总线
3. **分层关注** — 启动层 / 编排层 / 执行层 / 持久化层职责清晰
4. **智能上下文管理** — 三层状态追踪 + 去重注入，防止 LLM 上下文爆炸

当前架构适合单机、中等规模的任务编排场景。扩展性瓶颈主要在文件系统 IPC 和单进程编排器。引入消息队列和持久化状态存储是通往分布式架构的关键路径。
