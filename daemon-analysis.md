# Relay Code — Daemon 架构分析报告

## 一、整体架构概览

```
┌─────────────────────────────────────────────────────┐
│                     Daemon 模式                       │
│              (bun run src/index.ts --daemon)          │
│                                                      │
│  ┌─────────┐    ┌──────────────┐    ┌─────────────┐ │
│  │  stdin    │───▶│              │    │  AgentRegistry │ │
│  │ 监听器    │    │   Inbox      │    │  (状态追踪)    │ │
│  └─────────┘    │  (事件队列)    │    └─────────────┘ │
│                 │              │         ↕           │
│  ┌─────────┐    │  push/drain  │    ┌─────────────┐ │
│  │ 子Agent  │◀───▶│              │◀───▶│ Orchestrator  │ │
│  │ 结果文件  │    └──────────────┘    │  (事件循环)    │ │
│  └─────────┘                         └─────────────┘ │
│                                             │        │
│                                   ┌─────────▼──────┐ │
│                                   │    Harness      │ │
│                                   │  (Facade 外观)   │ │
│                                   └───┬─────────┬──┘ │
│                          ┌────────────▼──┐  ┌──▼──────┐
│                          │  PlanManager   │  │ToolExec │
│                          │  (plan.md 注入) │  │  utor   │
│                          └───────────────┘  └──┬──────┘
│                                      ┌─────────▼──────┐
│                                      │  dispatch 派发   │
│                                      │  → SubAgent     │
│                                      │  → subagent-cli  │
│                                      └────────────────┘
└─────────────────────────────────────────────────────┘
```

### 两种运行模式

| 模式 | 启动方式 | 说明 |
|------|---------|------|
| **单次/chat 模式** | `bun run src/index.ts <task>` 或 `--chat` | 同步 ReAct 循环，单次执行后退出 |
| **Daemon 模式** | `bun run src/index.ts --daemon` | 事件驱动循环，持续监听收件箱，异步派生子 Agent |

---

## 二、核心模块职责

| 模块 | 文件 | 职责 |
|------|------|------|
| **入口** | `index.ts` | 参数解析、模式分发（单次/chat/daemon）、.env 自动加载 |
| **Orchestrator** | `orchestrator.ts` | 主 Agent 事件循环 + ReAct 循环，调度核心 |
| **Inbox** | `inbox.ts` | 事件收件箱，统一的事件队列（push/drain） |
| **AgentRegistry** | `agent-registry.ts` | 子 Agent 生命周期管理 + 三层状态追踪 |
| **Harness** | `harness.ts` | 外观模式，组合 PlanManager + ToolExecutor + dispatch |
| **Dispatcher** | `dispatcher.ts` | dispatch 同步/异步派发 + SubAgent ReAct 执行器 |
| **subagent-cli** | `subagent-cli.ts` | 独立子进程入口，读取任务 JSON 后执行 SubAgent |
| **PlanManager** | `plan-manager.ts` | PlanState 驱动的 plan.md 阶段注入管理 |
| **PlanState** | `plan-state.ts` | plan.md 结构化解析 + 状态机 |
| **ToolExecutor** | `tool-executor.ts` | 工具调用执行器（支持同步/异步 dispatch 回调） |
| **Tools** | `tools.ts` | 5 个内置工具：read/write/grep/bash/dispatch |
| **message-assembler** | `message-assembler.ts` | 拼装子 Agent 的系统提示和用户消息 |
| **LLM** | `llm.ts` | OpenAI 兼容 LLM 调用封装 |
| **Memory** | `memory.ts` | 对话持久化（memory 目录） |
| **Display** | `display.ts` | 终端 UI：进度条、工具输出、HUD |
| **Types** | `types.ts` | 所有类型定义 + 常量 |
| **Errors** | `errors.ts` | 统一错误处理 |

---

## 三、完整工作流程

### 3.1 Daemon 模式启动流程

```
1. index.ts 解析参数，检测 --daemon
2. 创建 Inbox / AgentRegistry / Orchestrator
3. 启动 stdin 监听器（接收 "status"、"peek"、普通任务指令）
4. Orchestrator.start() 进入事件循环
5. 每轮循环：
   a. Inbox.isEmpty() 检查 → 无事件则 sleep(1s)
   b. Inbox.drain() 取出所有事件
   c. 按优先级处理：user_message → agent_error → agent_done
   d. 每 10 轮做一次 registry 清理
```

### 3.2 任务处理流程（从用户输入到结果返回）

```
用户输入任务
    │
    ▼
stdin → inbox.push({ type: "user_message", content: "..." })
    │
    ▼
Orchestrator.start()  drain 到该事件
    │
    ▼
processUserMessage()
    ├─ 首次 → 注入 system prompt（buildSystemPrompt）
    ├─ 非首次 → 注入集群状态
    ├─ 追加 user message
    └─ reactLoop()
         │
         ▼
    循环：callLLM → 解析 tool_calls → 执行工具 → 注入结果 → 继续
         │
         ├─ dispatch 调用 → Harness.dispatchFireAndForget()
         │     │
         │     ▼
         │  dispatchAsync()
         │    ├─ 生成 agentId
         │    ├─ 注册到 AgentRegistry
         │    ├─ 写任务 JSON 到 .relay/tasks/
         │    ├─ Bun.spawn("bun run subagent-cli.ts <task.json>")
         │    ├─ proc.unref()  ← 不阻塞主进程
         │    └─ 返回 { status: "dispatched", agentId }
         │
         ├─ read/write/grep/bash → 直接执行
         │
         └─ LLM 无 tool_call → 返回最终结果给用户
```

### 3.3 子 Agent 异步完成回调流程

```
子 Agent 独立进程执行完毕
    │
    ▼
subagent-cli.ts 写结果到 .result.json
    │  exit(0) / exit(1)
    ▼
dispatchAsync 的 onExit 回调触发
    ├─ 读取 .result.json
    ├─ registry.markDone() / markError()
    └─ inbox.push({ type: "agent_done" / "agent_error" })
         │
         ▼
Orchestrator 下一轮 drain 到该事件
    ├─ agent_done → processAgentBatch()
    │     ├─ 汇总多个完成结果
    │     ├─ 注入LLM: "X 个子 Agent 完成"
    │     └─ reactLoop() 让 LLM 合成回复
    └─ agent_error → 即时 stderr 通知
```

---

## 四、消息/通信机制

### 4.1 Inbox 事件模型

```
Inbox 是一个简单的事件队列：
  ┌─────────────────────────────┐
  │  queue: AgentEvent[]        │
  │                             │
  │  push(event)  ← 任意来源    │
  │  drain()      → 批量取出     │
  │  isEmpty()    → 是否为空     │
  └─────────────────────────────┘

事件类型:
  AgentEvent {
    type: "user_message" | "agent_done" | "agent_error"
    threadId: string       ← 关联指令和结果
    timestamp: number
    content?: string       ← user_message 的用户输入
    result?: SubAgentResult ← agent_done 的结果
    error?: string         ← agent_error 的错误描述
    agentRole?: string     ← 角色标识
    agentId?: string       ← Agent ID
  }
```

### 4.2 子 Agent 跨进程通信

子 Agent 作为 **独立进程** 运行，通过 **文件系统** 通信：

```
主进程                         子 Agent 进程
  │                               │
  ├─ 写 .relay/tasks/<id>.json ───▶ 读取配置
  │                               ├─ 执行 ReAct 循环
  │                               ├─ 实时写 .progress.json (L1/L2)
  │                               ├─ 实时写 .conversation.jsonl (L3)
  │                               └─ 写 .result.json
  │                               exit
  ├─ onExit 回调 ◀─────────────── 进程退出
  └─ 读取 .result.json
```

### 4.3 三层状态追踪（AgentRegistry）

| 层级 | 名称 | 数据来源 | 用途 |
|------|------|---------|------|
| **L1** | getSnapshot() | 内存 + progress.json | 一行状态，供终端/LLM 查看集群概览 |
| **L2** | peek(id) | 内存 + progress.json | 按需查看某个 Agent 的详细进度 |
| **L3** | readConversation(id) | conversation.jsonl 文件 | 完整对话记录，深度排查 |

---

## 五、子 Agent 生命周期管理

```
                    ┌──────────┐
                    │  注册    │  registry.register(id, role, threadId)
                    └────┬─────┘
                         │
                    ┌────▼─────┐
                    │  运行中   │  status = "running"
                    │  (running)│  ├─ 实时更新 progress.json
                    └────┬─────┘  ├─ 实时追加 conversation.jsonl
                         │        └─ 空结果检测（连续2轮空→提前终止）
                    ┌────┴─────┐
                    │          │
              ┌─────▼──┐  ┌───▼─────┐
              │ 完成    │  │ 错误    │
              │ (done)  │  │ (error) │
              └────┬────┘  └────┬────┘
                   │            │
              ┌────▼────────────▼────┐
              │   清理 (cleanup)      │
              │  10轮一次 / 超时10min  │
              └──────────────────────┘
```

**关键行为：**
- 子 Agent 通过 `Bun.spawn` 创建独立进程（`subagent-cli.ts`），主进程不阻塞
- `proc.unref()` 确保子进程不会阻止主进程退出
- 子 Agent 内部有 **最大轮次限制**（默认 30，全局上限 60）
- 子 Agent 内部有 **最大执行时间限制**（可选配置 `max_time_ms`）
- **空结果检测**：连续 2 轮工具调用返回空结果 → 提前终止
- **LLM 超时**：单次 LLM 调用超时 120s → 终止子 Agent

---

## 六、关键设计模式

### 1. 事件驱动（Event-Driven）
- `Inbox` 作为统一事件队列，主循环 `drain → 处理 → 等待`
- 三类事件（user_message / agent_done / agent_error）按优先级处理

### 2. Actor 模型
- 每个子 Agent 是一个独立的 Actor（独立进程）
- 通过消息（文件 + 事件）通信，不共享内存
- 主 Agent 通过收件箱协调

### 3. 外观模式（Facade）
- `Harness` 封装了 PlanManager + ToolExecutor + dispatch 的复杂组合
- 对外暴露 `executeToolCall()` / `getPlanMessages()` 等统一接口

### 4. 状态机（State Machine）
- `PlanState` 解析 plan.md 的阶段标记，跟踪阶段状态变化
- 状态键去重：相同阶段状态不重复注入 LLM 上下文

### 5. 异步火发（Fire-and-Forget）
- `dispatchAsync()` 生成 Agent → 立即返回控制权
- 子 Agent 完成后通过回调自动通知主进程

### 6. 工作树隔离（Worktree Isolation）
- 可选 `isolation: "worktree"` 在独立 git worktree 中执行
- 避免多个子 Agent 并行写同一文件导致冲突

---

## 七、总结

Relay Code 的 Daemon 架构是一个 **事件驱动的多 Agent 集群系统**，核心设计思路是：

1. **主 Agent 编排，子 Agent 执行** — Orchestrator 负责理解用户意图、制定计划、派发任务；子 Agent 专注执行具体分析/编码任务
2. **异步非阻塞** — 派发子 Agent 后立即返回，通过事件回调获得结果
3. **进程级隔离** — 每个子 Agent 运行在独立进程中，互不干扰
4. **文件系统通信** — 跨进程通过 JSON 文件交换数据，简单可靠
5. **三层可观测性** — 从一行概览到完整对话，逐层深入排查

这使系统能够同时处理多个子任务，具备良好的可扩展性和容错能力。
