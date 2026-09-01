# Daemon（守护进程）模式架构分析

## 1. 启动入口 — daemonMode()

```
src/index.ts → daemonMode()
```

**完整流程：**

1. **实例化三大核心对象**：
   - `Inbox`（收件箱）— 事件队列，所有 User 指令和子 Agent 完成/错误事件统一入队
   - `AgentRegistry`（注册表）— 追踪所有子 Agent 的生命周期状态与进度
   - `Orchestrator`（编排器）— 事件驱动的核心引擎，持有 Inbox + Registry 引用

2. **Stdin 监听启动**：
   - 创建 `readline.createInterface({ input: process.stdin })`
   - 注册 `"line"` 事件处理器，解析用户输入：
     - `exit` → 关闭 readline 并 `process.exit(0)`
     - `status` → 调用 `registry.getSnapshot()` 输出一行摘要
     - `peek <id>` → 调用 `registry.peekAsContext(id)` 查看特定 Agent 时间线
     - 其他任意文本 → `inbox.push({ type: "user_message", ... })` 入队

3. **进入事件循环**：`await orchestrator.start()` 阻塞，永不返回

**关键设计**：stdin 监听是非阻塞的，输入行只会推入收件箱，不直接处理。真正的处理在 Orchestrator 的事件循环中异步进行。

---

## 2. 事件驱动循环 — Orchestrator.start()

```
orchestrator.ts → start()
```

**无限 while(true) 循环结构：**

```
while (true) {
    if (inbox.isEmpty()) {
        await sleep(1000)          // 1 秒轮询间隔
        cleanupCounter++
        if (cleanupCounter >= 10) {
            registry.cleanup()     // 每 10 轮清理一次已完成且超时的 Agent
            cleanupCounter = 0
        }
        continue
    }

    const events = inbox.drain()   // 取出当前所有事件
    // 按 type 分类处理...
}
```

**清理逻辑**：`registry.cleanup(maxAgeMs=600000)` 删除所有已完成且超过 10 分钟未更新的 Agent 记录，防止内存泄漏。

**调度特点**：非抢占式轮询，不涉及 epoll/kqueue 等事件通知机制，使用定时 sleep 实现低 CPU 占用。

---

## 3. 事件分类与优先级

从收件箱 drain 出所有事件后，按 type 分为三类：

```typescript
const userMsgs  = events.filter(e => e.type === "user_message")
const agentErrors = events.filter(e => e.type === "agent_error")
const agentDones  = events.filter(e => e.type === "agent_done")
```

**处理顺序 & 为什么 User 指令优先：**

| 优先级 | 事件类型 | 处理方式 |
|--------|----------|----------|
| 1 (最高) | `user_message` | `processUserMessage(msg)` — 立即执行完整 ReAct 循环 |
| 2 | `agent_error` | 即时输出错误到 stderr，不做 LLM 交互 |
| 3 (最低) | `agent_done` | `processAgentBatch(dones)` — 批量合并后注入 LLM |

**User 指令为什么优先**：用户通常需要即时反馈。如果先处理 agent_done 再处理 User，可能导致用户等待无关的子 Agent 结果合并完毕后才得到回复。将 User 放在最前保证了低延迟交互体验。

---

## 4. User 消息处理流程 — processUserMessage

```
processUserMessage(event: AgentEvent) → void
```

**完整流程：**

### 4.1 集群状态注入

```typescript
const snapshot = this.registry.getSnapshot()
```

`getSnapshot()` 返回一个格式化的 Markdown 文本，包含所有子 Agent 的当前状态摘要（L1 数据），例如：

```
## 子 Agent 运行状态
  ⟳ 代码审查者 (a1b2c3d4): 第5轮 grep — 搜索引用...
  ✓ 测试编写者 (e5f6g7h8): 覆盖率 87%
  ✗ 文档生成者 (i9j0k1l2): 文件写入失败
```

### 4.2 System Prompt 构建

- **首轮**：调用 `buildSystemPrompt()` 生成基础系统提示，追加 `snapshot` 作为集群状态上下文
- **非首轮**：追加一条 `role: "system"` 消息 `[集群状态更新]\n${snapshot}`

### 4.3 用户消息入队

```typescript
this.messages.push({ role: "user", content: input })
```

### 4.4 执行 ReAct 循环

调用 `this.reactLoop()`，核心逻辑：

1. **集群 HUD 去重**：每轮检查 `getSnapshot()` 是否变化，有变化才注入 `[集群状态]` 系统消息
2. **Plan 注入**：通过 `harness.getPlanMessages()` 获取 plan.md 上下文
3. **LLM 调用**：`callLLM(this.messages, ALL_TOOLS)` 带工具定义
4. **工具执行**：并行执行所有 `tool_calls`，结果追加到 messages
5. **最多 60 轮迭代**（`MAX_REACT_ITERATIONS`）
6. **返回最终文本** → 输出到控制台 + 打印提示符 `> `

---

## 5. 子 Agent 结果合并 — processAgentBatch

```
processAgentBatch(dones: AgentEvent[]) → void
```

**合并策略：**

将多个 agent_done 结果压缩为一条结构化摘要：

```typescript
const summary = dones.map(d => {
    const role = d.agentRole ?? "未知"
    const output = d.result?.output?.slice(0, 300) ?? "无输出"
    const id = d.agentId?.slice(-8) ?? ""
    const status = d.type === "agent_error" ? "ERROR" : "DONE"
    return `[${status}] ${role} (${id}): ${output}`
}).join("\n")
```

**注入给 LLM 的消息格式：**

```
## 子 Agent 执行结果（3 个完成，2 个仍在运行，共 5 个）
[DONE] 代码审查者 (a1b2c3d4): 发现 3 处潜在问题...
[DONE] 测试编写者 (e5f6g7h8): 生成了 15 个测试用例...
[ERROR] 文档生成者 (i9j0k1l2): 文件写入权限不足...

## 子 Agent 运行状态
  ✓ 代码审查者 (a1b2c3d4): 完成
  ✓ 测试编写者 (e5f6g7h8): 完成
  ✗ 文档生成者 (i9j0k1l2): 错误
  ⟳ 部署执行者 (m3n4o5p6): 第 2 轮...
```

**设计意图**：不立即触发新一轮 LLM 调用，而是将结果注入消息历史，等待下一轮 User 交互或者 LLM 自主决策时自动引用。

---

## 6. AgentRegistry 三层数据视图

```
agent-registry.ts — AgentRegistry 类
```

### L1: 一行摘要 — `getSnapshot()`

- **用途**：终端 `status` 命令 + LLM 上下文注入
- **内容**：每个 Agent 一行，包含状态图标、角色名、短 ID、当前进度摘要
- **数据源**：内存中的 `AgentState` + 磁盘上的 `.progress.json` 文件
- **特点**：紧凑，不进 LLM 上下文（但会在 processUserMessage 中附加到 system prompt）

### L2: 近期时间线 — `peek(id)` / `peekAsContext(id)` / `peekAll()`

- **用途**：`peek` 命令 + LLM 按需深度查看
- **内容**：Agent 的详细状态 + 最近最多 20 条历史记录（`recentHistory` 数组）
- **数据源**：内存中的 `recentHistory`（每轮 append 一条，超过 20 条 shift 旧记录）
- **特点**：提供 Agent 执行过程的细节，适合回答"那个 Agent 在做什么"这类问题

### L3: 完整对话日志 — `readConversation(id)`

- **用途**：深度排查
- **内容**：子 Agent 的完整 `.conversation.jsonl` 文件，每行一条 JSON 记录
- **数据源**：磁盘文件系统 `.relay/tasks/{agentId}.conversation.jsonl`
- **特点**：不会自动注入 LLM，仅在需要时手动读取

---

## 7. 文件系统 IPC 机制

```
dispatcher.ts → dispatchAsync()
subagent-cli.ts → main()
```

**通信流程（无共享内存，完全基于文件系统）：**

```
┌─────────────────────┐         写 task.json          ┌─────────────────────┐
│  主 Agent 进程      │ ─────────────────────────────→ │  子 Agent 进程      │
│  (Orchestrator)     │   .relay/tasks/{id}.json       │  (subagent-cli.ts)  │
│                     │                                │                     │
│  1. registry.register│                              │  1. 读 task.json    │
│  2. 写入 task.json  │                              │  2. 执行 ReAct 循环  │
│  3. Bun.spawn()     │                              │  3. 每轮写 progress   │
│  4. proc.unref()    │     写 progress.json          │  4. 写 result.json   │
│  5. 立即返回         │ ←─────────────────────────   │  5. process.exit()   │
│                     │  .relay/tasks/{id}.progress    │                     │
│  onExit 回调:       │                                │                     │
│  读 result.json    │     写 result.json             │                     │
│  → registry.mark*  │ ←─────────────────────────    │                     │
│  → inbox.push()    │  .relay/tasks/{id}.result      │                     │
└─────────────────────┘                                └─────────────────────┘
```

**关键细节：**

1. **task.json**：主 Agent 写 `DispatchConfig` 到磁盘，包含 prompt、allowed_tools、responseSchema 等
2. **Bun.spawn**：`Bun.spawn(["bun", "run", "src/subagent-cli.ts", taskPath])` 启动子进程
3. **progress.json**：子 Agent 每轮 ReAct 循环更新一次，包含 round、lastAction、lastSummary、elapsedMs
4. **conversation.jsonl**：子 Agent 每轮 append 一条 JSON 记录，构成完整对话日志
5. **result.json**：子 Agent 完成时写入最终的 `SubAgentResult`（status + output + structured）
6. **onExit 回调**：主 Agent 的 `proc.onExit` 读取 result.json，调用 `registry.markDone/markError`，并向 inbox 推入 `agent_done` 或 `agent_error` 事件
7. **proc.unref()**：允许主进程退出时不等待子进程

---

## 8. 同步/异步双模式 dispatch

```
tool-executor.ts → ToolExecutor.executeToolCall()
harness.ts → Harness 构造函数
```

**双模式切换机制：**

### 8.1 构造函数决定模式

```typescript
// Orchestrator 构造函数：
if (inbox && registry) {
    // daemon 模式 → 异步
    this.harness = new Harness(inbox, registry, this.currentThreadId)
} else {
    // 兼容模式 → 同步
    this.harness = new Harness()
}
```

Harness 构造函数将 inbox/registry/threadId 注入 ToolExecutor：

```typescript
// 同步兼容：注入 dispatch 回调
this.executor.dispatchFn = (config) => this.dispatch(config)
// 异步模式仅在显式传入所有参数时启用
if (inbox && registry && threadId) {
    this.executor.inbox = inbox
    this.executor.registry = registry
    this.executor.threadId = threadId
}
```

### 8.2 ToolExecutor 运行时自动选择

```typescript
// tool-executor.ts — dispatch 工具处理
if (this.inbox && this.registry && this.threadId) {
    // 异步火发模式：不等，立即返回 agentId
    const { agentId } = await dispatchAsync(config, this.inbox, this.registry, this.threadId)
    return `[dispatch 已发出] agentId: ${agentId}`
}

// 同步模式：等返回（兼容旧行为）
if (this.dispatchFn) {
    const result = await this.dispatchFn(config)
    return `[dispatch 完成] 状态: ${result.status} ...`
}
```

### 8.3 两种模式对比

| 特性 | 同步模式 | 异步火发模式 |
|------|----------|--------------|
| 使用场景 | `--chat` / 单次执行 | `--daemon` |
| 调用方式 | `dispatch(config, executor)` | `dispatchAsync(config, inbox, registry, threadId)` |
| 子进程 | 等待返回 | `Bun.spawn` + `proc.unref()` 立即返回 |
| 结果通知 | 函数返回值 | 文件系统 IPC → onExit → inbox.push |
| LLM 可见性 | 调用方阻塞等待结果 | 收到 `[dispatch 已发出]`，结果后续自动推送 |
| 并发能力 | 串行 | 可同时运行多个子 Agent |

### 8.4 异步火发完整时序

```
LLM 调用 dispatch → ToolExecutor 检测到 inbox+registry+threadId 存在
  → dispatchAsync() 写入 task.json
  → Bun.spawn 启动子进程
  → proc.unref() 释放引用
  → 返回 "[dispatch 已发出] agentId: xxx"
  ── LLM 继续下一轮 or 回复用户 ──
  ...若干秒后...
  → 子进程完成，写入 result.json
  → onExit 回调触发
  → registry.markDone() + inbox.push({ type: "agent_done" })
  → 下一轮事件循环收到 agent_done → processAgentBatch() 合并结果
  → LLM 在后续交互中看到所有结果
```

---

## 整体架构图

```
┌──────────────────────────────────────────────────────┐
│  daemonMode()                                        │
│  ┌──────────────────────────────────────────────────┐│
│  │  Inbox ←── stdin "line" 事件                    ││
│  │  AgentRegistry                                   ││
│  │  Orchestrator.start()  ←────── 轮询 inbox       ││
│  │  ┌────────────────────────────────────────┐     ││
│  │  │ while(true) {                         │     ││
│  │  │   sleep(1s) / cleanup every 10 rounds │     ││
│  │  │   drain inbox → 分类                  │     ││
│  │  │   user_message → processUserMessage   │     ││
│  │  │     → 注入 snapshot                   │     ││
│  │  │     → buildSystemPrompt               │     ││
│  │  │     → reactLoop (60轮)                │     ││
│  │  │       → harness.executeToolCall       │     ││
│  │  │         → dispatch (异步火发)         │     ││
│  │  │           → write task.json           │     ││
│  │  │           → Bun.spawn subagent-cli    │     ││
│  │  │           → proc.unref() → 立即返回   │     ││
│  │  │   agent_error → stderr 输出           │     ││
│  │  │   agent_done  → processAgentBatch     │     ││
│  │  │     → 合并摘要 → 注入 messages       │     ││
│  │  │ }                                      │     ││
│  │  └────────────────────────────────────────┘     ││
│  └──────────────────────────────────────────────────┘│
│                                                      │
│  子 Agent 进程 (独立)                                │
│  subagent-cli.ts                                     │
│  ┌────────────────────────────────────────────────┐ │
│  │ 读 task.json → assembleMessages               │ │
│  │ → SubAgent.run() (ReAct 循环)                 │ │
│  │ → 每轮写 progress.json                       │ │
│  │ → 完成写 result.json                          │ │
│  │ → process.exit()                               │ │
│  └────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────┘
```
