# Relay-Code Chat 多轮对话记忆方案设计

## 现状分析

### 关键架构事实

1. **`src/orchestrator.ts:31-35`** — `runReAct()` 每次调用重建 `messages` 数组，LLM 无跨轮记忆
2. **`src/index.ts:52`** — `chatMode()` 全程使用同一个 `Orchestrator` 实例
3. **`src/index.ts:115`** — 单次模式每次创建新 `Orchestrator`，实例状态天然隔离
4. **`src/plan-manager.ts:19-29`** — `getPlanMessages()` 已有状态键去重，plan 未变时返回 `[]`
5. **`src/llm.ts:17-18`** — 默认模型 `deepseek-v4-flash`，context window 约 128K tokens
6. **`src/memory.ts`** — `saveDialogue()` 写 JSONL 日志（原始文本，非结构化 ChatMessage）

### 消息生命周期（当前）

```
runReAct 被调用:
  messages = [system, user_input]      ← 每次全量重建
  → getPlanMessages() → push plan      ← 状态键去重，不变时为空
  → ReAct 循环 → push assistant/tool   ← 追加到 messages
  → 返回最终结果
  → messages 随函数返回被 GC
```

---

## 方案对比

| 维度 | 方案 A（最小改动） | 方案 B（token 管理） | 方案 C（复用 JSONL） |
|------|---------------------|----------------------|------------------------|
| 改动量 | ~15 行，1 个文件 | ~50 行，2 个文件 | ~80 行，3 个文件 |
| 新增依赖 | 无 | token 估算函数 | 无（已有 `readMemoryFile`） |
| 对单次模式影响 | 无 | 无 | 无 |
| 对话持久化 | 仅内存（进程内） | 仅内存（进程内） | 跨进程（JSONL 文件） |
| token 超限风险 | 存在（理论上） | 已处理 | 存在（需另加压缩） |
| 复杂度 | 低 | 中 | 高 |

---

## 推荐方案：A（最小改动）

### 推荐理由

1. **DeepSeek v4-flash 128K context window** — 实际编码场景下，一个聊天会话很难在合理时间内填满。方案 B 是过早优化。
2. **方案 C 存在根本性不匹配** — `saveDialogue` 存的是原始文本字符串（如 `[工具调用] dispatch: {...}`），不是结构化的 `ChatMessage`（含 `tool_call_id`、`tool_calls` 数组）。要复现为可用的 messages，需要重写整个持久化层。
3. **单次模式零影响** — 单次模式每次 `new Orchestrator()` 自然获得空 messages，无需任何条件判断。
4. **Plan 注入天然兼容** — `getPlanMessages()` 的状态键去重机制保证 plan 不会在多轮中重复注入。

### 核心思路

将 `messages` 从 `runReAct` 的局部变量提升为 `Orchestrator` 的实例属性。chat 模式下，同一实例跨多轮累积消息；单次模式下，新实例自然获得空历史。

---

## 具体改动

### 文件：`src/orchestrator.ts`

#### 改动 1：添加实例属性（第 25 行后）

```diff
 export class Orchestrator {
        private harness: Harness;
+       /** 跨轮对话历史（chat 模式累积，单次模式每次新实例自然为空） */
+       private messages: ChatMessage[] = [];

        constructor(harness?: Harness) {
```

#### 改动 2：修改 `runReAct` 的消息初始化（第 32-35 行替换）

```diff
        async runReAct(userInput: string): Promise<string> {
-               const messages: ChatMessage[] = [
-                       { role: "system", content: buildSystemPrompt() },
-                       { role: "user", content: userInput },
-               ];
+               // 首轮：初始化 system prompt + user input
+               // 后续轮：只追加 user input（system prompt 已在历史中）
+               if (this.messages.length === 0) {
+                       this.messages.push({ role: "system", content: buildSystemPrompt() });
+               }
+               this.messages.push({ role: "user", content: userInput });
+
                await saveDialogue("system", buildSystemPrompt());
                await saveDialogue("user", userInput);
```

**说明**：`saveDialogue` 对 system prompt 的调用保留不变（日志完整性），但 system prompt 只在首轮 push 到 messages。

#### 改动 3：引用处替换（全文将 `messages` 替换为 `this.messages`）

全文共 5 处 `messages` 引用（第 56、60、162、163、168 行），全部改为 `this.messages`。

第 56 行：
```diff
-               messages.push(...planMessages);
+               this.messages.push(...planMessages);
```

第 60 行：
```diff
-               response = await callLLM(messages, ALL_TOOLS);
+               response = await callLLM(this.messages, ALL_TOOLS);
```

第 162-168 行工具结果回写：
```diff
-               messages.push({ role: "assistant", ... });
+               this.messages.push({ role: "assistant", ... });
-               messages.push({ role: "tool", ... });
+               this.messages.push({ role: "tool", ... });
```

#### 改动 4（可选）：添加重置方法

```typescript
/** 重置对话历史（开始全新会话） */
resetConversation(): void {
    this.messages = [];
}
```

### 文件：`src/index.ts` — 无需改动

单次模式（第 115 行 `new Orchestrator()`）天然获得空 messages。chat 模式（第 52 行）天然累积 messages。

### 文件：`src/memory.ts` — 无需改动

---

## 兼容性分析

### 单次模式（`bun run start "task"`）

```
new Orchestrator() → this.messages = []
runReAct("task")   → length === 0 → push system + user
                   → ReAct 循环
                   → 返回结果
                   → Orchestrator 被 GC
```

**完全不影响。** 每次新实例，messages 自然为空。

### Chat 模式（`bun run start --chat`）

```
new Orchestrator() → this.messages = []
┌─ runReAct("分析文件") → push system + user1 → ReAct → messages 累积
├─ runReAct("检查依赖") → push user2          → ReAct → messages 累积
└─ runReAct("修复bug")  → push user3          → ReAct → messages 累积
```

**首次具有跨轮记忆。** LLM 在第二、三轮能看到完整历史。

### Plan 注入

`getPlanMessages()` 已有状态键去重（`src/plan-manager.ts:24-26`），返回 `[]` 时不做任何 push。历史中的旧 plan 消息会保留在 `this.messages` 中作为上下文，但不重复注入。

### 管道模式（`echo "task" | bun run start`）

走 index.ts 第 80-89 行的管道分支，最终调用 `new Orchestrator()` + `runReAct`，与单次模式等同，不受影响。

---

## 边界情况

| 场景 | 行为 |
|------|------|
| chat 模式下用户输入 `exit` | 不调用 `runReAct`，直接退出，历史随进程消亡 |
| chat 模式跑很久，消息超 128K tokens | LLM 调用会返回 context length error。届时可升级到方案 B |
| 用户想在 chat 中开始全新对话 | 可添加 `/reset` 命令调用 `resetConversation()`（后续优化） |
| MAX_REACT_ITERATIONS=60 的循环中累积 | 每轮最多 60 次迭代，每次迭代 push 2 条消息。60 × 2 = 120 条/轮。10 轮约 1200 条消息，仍在 128K 范围内 |

---

## 方案 B 预留接口（未来升级路径）

当需要 token 管理时，在 `callLLM` 调用前插入压缩逻辑：

```typescript
// 未来可在 orchestrator.ts 中添加：
private estimateTokens(messages: ChatMessage[]): number {
    // 粗略估算：中文 ~1.5 char/token, 英文 ~4 char/token
    let total = 0;
    for (const msg of this.messages) {
        const text = msg.content ?? JSON.stringify(msg.tool_calls ?? "");
        total += Math.ceil(text.length / 3); // 混合中英文平均
    }
    return total;
}

private compressHistory(maxTokens: number): void {
    // 保留 system prompt + 最近 N 轮，其余用摘要替代
    // 具体实现待定
}
```

方案 B 只需在方案 A 基础上增加上述方法 + 在 `runReAct` 第 60 行前调用即可，**无需回滚方案 A 的任何改动**。

---

## 总结

**方案 A 只需修改 `src/orchestrator.ts` 一个文件，约 10 行实质改动**（将 `messages` 从局部变量改为 `this.messages`），对单次模式零影响，与现有 plan 注入机制天然兼容。方案 B/C 可作为未来迭代方向。
