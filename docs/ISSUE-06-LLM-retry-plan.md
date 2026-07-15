# ISSUE-06 优化计划：LLM 调用无重试机制

## 1. 问题描述

### 1.1 核心缺陷

`src/llm.ts` 的 `callLLM` 函数对 **所有 HTTP 错误（429/5xx/连接错误）均直接返回错误文本**，不做任何重试。同时 `src/orchestrator.ts` 的 catch 块写了"重试"日志但从未对 HTTP 错误生效（仅 AbortError 能到达此处），且无任何退避延迟。

### 1.2 callLLM 错误处理流程图

```
callLLM(messages, tools, {signal?})
│
├─ try 块: client.chat.completions.create(...)
│   │
│   └─ 成功 → return { content, reasoning_content, tool_calls }
│
└─ catch (e: unknown) 块
    │
    ├─ AbortError? ────────────────────────────────────── throw e（透传）
    │                                                      │
    │                                                      ▼
    │                                          orchestrator catch 块
    │                                          → "LLM 调用异常，重试"
    │                                          → continue（无延迟）
    │
    ├─ status === 401/403? ─── return "认证失败" 文本 ──────┐
    ├─ status === 429? ─────── return "请求过频" 文本 ──────┤
    ├─ status >= 500? ──────── return "服务端错误" 文本 ────┤
    ├─ ECONNREFUSED/ENOTFOUND? ─ return "无法连接" 文本 ────┤
    └─ 其他 ────────────────── return "调用失败" 文本 ──────┤
                                                            │
                                          所有路径（除 AbortError 外）
                                          均 return 错误文本
                                          tool_calls: undefined
                                                            │
                                                            ▼
                                          回到调用方（orchestrator / dispatcher）
                                          response.tool_calls === undefined
                                                            │
                                                            ▼
                                          调用方认为 "LLM 已完成，无工具调用"
                                          将错误文本作为 **最终回答** 返回给用户
```

### 1.3 实际执行路径（模拟验证）

以 DeepSeek API 返回 429 为例，逐帧推演：

| 步骤 | 位置 | 发生什么 |
|------|------|---------|
| 1 | OpenAI SDK | 抛出 `{ status: 429, message: "Rate limit exceeded" }` |
| 2 | `llm.ts` catch 块 | 匹配 `status === 429`（第80行） |
| 3 | `llm.ts` | **return** `{ content: "错误：LLM API 请求过频，请稍后重试", tool_calls: undefined }` |
| 4 | `orchestrator.ts:53` | `response.tool_calls` 是 `undefined` |
| 5 | `orchestrator.ts:54-56` | 进入 "无工具调用" 分支 |
| 6 | `orchestrator.ts:55-56` | `saveDialogue("assistant", "错误：LLM API 请求过频...")` 然后 `return` |
| 7 | 用户看到 | **"错误：LLM API 请求过频，请稍后重试"**（而非期望的业务结果） |

**整个过程没有任何重试发生。**

同样的逻辑适用于 5xx、ECONNREFUSED、ENOTFOUND 等所有 HTTP/网络错误。

### 1.4 根因分析

| 层 | 问题 | 严重度 |
|----|------|--------|
| `llm.ts` — 错误处理策略 | 所有可恢复错误（429/5xx/连接错误）被立即转为文本返回值，无重试逻辑。文件内不含任何 "retry" 字符串。 | **高** |
| `orchestrator.ts` — catch 块的误导性 | 日志写了"重试"并 `continue`，但 HTTP 错误永远不会到达此处（已被 llm.ts 吞掉为文本返回）。唯一能到达的是 `AbortError`（超时），且 `continue` 前无 `sleep`/退避。 | 中 |
| `dispatcher.ts` — 相同模式 | `SubAgent.run()` 第115-147行有相同的结构：catch 到的 AbortError → 立即返回 error 状态；错误文本返回值 → 被当作"完成"输出。 | 中 |

---

## 2. 影响范围

### 2.1 直接影响

| 组件 | 文件 | 受影响函数/区域 | 影响描述 |
|------|------|----------------|---------|
| LLM 调用层 | `src/llm.ts` | `callLLM()` 第71-104行 | 所有可恢复错误被吞掉，不做重试 |
| 主 Agent 编排 | `src/orchestrator.ts` | `runReAct()` 第42-51行 | 错误文本被当作最终答案返回；catch 块仅对 AbortError 生效且无退避 |
| 子 Agent 编排 | `src/dispatcher.ts` | `SubAgent.run()` 第115-147行 | AbortError → 立即终止子 Agent；错误文本 → 被当作子 Agent "完成"输出 |

### 2.2 影响场景矩阵

| 场景 | 错误类型 | 当前行为 | 用户感知 |
|------|---------|---------|---------|
| API 限频 | 429 | 瞬间返回 "请求过频" 文本，任务失败 | "为什么总是失败？" |
| 服务端临时故障 | 500/502/503 | 瞬间返回 "服务端错误" 文本，任务失败 | "服务挂了？" |
| 网络抖动 | ECONNREFUSED | 瞬间返回 "无法连接" 文本，任务失败 | "网络明明没问题" |
| DNS 临时失败 | ENOTFOUND | 瞬间返回 "无法连接" 文本，任务失败 | 同上 |
| 请求超时 | AbortError | orchestrator catch 块捕获，无延迟 continue → 快速消耗 ReAct 迭代 | "一直在转圈然后说任务没完成" |

### 2.3 级联影响

```
单次 429 错误
    │
    ▼
llm.ts 返回错误文本（无 tool_calls）
    │
    ├── orchestrator 路径: 错误文本 → 最终输出 → 用户任务失败
    │
    └── dispatcher 路径: 错误文本 → 子 Agent "完成" → 脏数据注入父 Agent 上下文
                                                          │
                                                          ▼
                                              父 Agent 基于错误信息
                                              继续推理 → 错误传播
```

---

## 3. 修复方案

### 3.1 方案概述

双重修复，分层处理：

- **Layer 1（llm.ts）**：在 `callLLM` 内部添加指数退避重试，作为第一道防线
- **Layer 2（orchestrator.ts + dispatcher.ts）**：修复 catch 块的误导性日志，添加退避延迟，作为第二道防线

### 3.2 Layer 1：llm.ts — 指数退避重试

**设计原则**：
- 只重试 **可恢复** 错误（429、5xx、ECONNREFUSED、ENOTFOUND、ECONNRESET、ETIMEDOUT）
- **不重试** 不可恢复错误（401/403 认证失败、400 参数错误）
- **不重试** AbortError（超时/主动取消，由调用方处理）
- 使用 **指数退避 + 随机抖动**（jitter）避免惊群效应
- 最大重试 3 次，总等待时间约 14 秒（1+2+4+抖动）

**新增配置常量**（在文件顶部定义）：

```typescript
/** 最大重试次数 */
const MAX_RETRIES = 3;
/** 基础退避延迟（毫秒） */
const BASE_RETRY_DELAY_MS = 1000;
/** 最大抖动（毫秒），避免惊群效应 */
const MAX_JITTER_MS = 1000;
```

**重试判定逻辑**：

```typescript
/** 判断错误是否可重试 */
function isRetryableError(status: number, code: string): boolean {
  // 限频
  if (status === 429) return true;
  // 服务端临时故障
  if (status >= 500 && status < 600) return true;
  // 网络层错误
  if (["ECONNREFUSED", "ENOTFOUND", "ECONNRESET", "ETIMEDOUT"].includes(code)) return true;
  return false;
}
```

**改造后的 callLLM 结构**：

```typescript
export async function callLLM(
  messages: ChatMessage[],
  tools?: ToolDefinition[],
  options?: { signal?: AbortSignal },
): Promise<LLMResponse> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY 环境变量未设置");

  const client = new OpenAI({
    apiKey,
    baseURL: process.env.DEEPSEEK_BASE_URL ?? DEEPSEEK_BASE_URL,
  });

  const model = process.env.DEEPSEEK_MODEL ?? DEFAULT_MODEL;

  // === 重试循环 ===
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      // --- 原有调用逻辑（不变）---
      const apiMessages = messages.map(mapMessage);
      const apiTools = tools?.map(mapTool) as ChatCompletionTool[] | undefined;

      const res = await client.chat.completions.create(
        { model, messages: apiMessages, tools: apiTools, max_tokens: 4096 },
        { signal: options?.signal },
      );

      const choice = res.choices[0]?.message;
      if (!choice) return { content: "", tool_calls: undefined };

      const deepseekMsg = choice as unknown as DeepSeekMessage;
      const reasoningContent = deepseekMsg.reasoning_content ?? null;

      return {
        content: choice.content ?? null,
        reasoning_content: reasoningContent,
        tool_calls: choice.tool_calls?.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: {
            name: (tc as { function: { name: string; arguments: string } }).function.name,
            arguments: (tc as { function: { name: string; arguments: string } }).function.arguments,
          },
        })),
      };
      // --- 原有调用逻辑结束 ---

    } catch (e: unknown) {
      // 1. AbortError（超时/取消）→ 不重试，直接透传
      if (e instanceof DOMException && e.name === "AbortError") throw e;
      if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");

      // 2. 解构错误信息
      const errInfo = unwrapError(e);
      const status = errInfo.status ?? 0;
      const code = errInfo.code ?? "";

      // 3. 不可恢复错误 → 直接返回错误文本
      if (status === 401 || status === 403) {
        return {
          content: `错误：LLM API 认证失败（${status}）`,
          tool_calls: undefined,
        };
      }

      // 4. 可重试错误 → 指数退避后重试
      if (isRetryableError(status, code) && attempt < MAX_RETRIES) {
        const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt)
                    + Math.random() * MAX_JITTER_MS;
        process.stderr.write(
          `[重试 ${attempt + 1}/${MAX_RETRIES}] ` +
          `${status ? `HTTP ${status}` : code} — ` +
          `${Math.round(delay)}ms 后退避重试\n`
        );
        await new Promise((r) => setTimeout(r, delay));
        continue; // 进入下一次重试
      }

      // 5. 重试耗尽 → 返回错误文本
      if (attempt >= MAX_RETRIES) {
        const detail = status
          ? `HTTP ${status}`
          : code || errInfo.message;
        return {
          content: `错误：LLM API 调用失败（${detail}，已重试 ${MAX_RETRIES} 次）`,
          tool_calls: undefined,
        };
      }

      // 6. 非可重试、非认证错误（如 400 参数错误）→ 返回错误文本
      return {
        content: `错误：LLM 调用失败 — ${errInfo.message ?? String(e)}`,
        tool_calls: undefined,
      };
    }
  }

  // 理论上不可达（所有分支均已 return）
  return {
    content: `错误：LLM 调用失败（已达最大重试次数 ${MAX_RETRIES}）`,
    tool_calls: undefined,
  };
}
```

**重试时序图**（以 429 为例）：

```
attempt 0: 发起请求 → 429
           → delay = 1000 + random(0~1000) ≈ 1500ms
attempt 1: 发起请求 → 429
           → delay = 2000 + random(0~1000) ≈ 2500ms
attempt 2: 发起请求 → 429
           → delay = 4000 + random(0~1000) ≈ 4500ms
attempt 3: 发起请求 → 429
           → 重试耗尽 → return 错误文本

总耗时约 8.5 秒（远好于当前的瞬间失败）
```

### 3.3 Layer 2：orchestrator.ts — 修复误导性日志 + 添加退避延迟

**问题**：
- catch 块日志写了"重试"但 HTTP 错误永远不会到达此处
- `continue` 前无任何延迟，AbortError 触发时快速消耗 ReAct 迭代

**修复**：

```typescript
// orchestrator.ts runReAct() 第42-51行替换为：

let response: LLMResponse;
try {
  response = await callLLM(messages, ALL_TOOLS);
} catch (e: unknown) {
  // callLLM 内部已对可恢复错误做指数退避重试
  // 到达此处的异常：
  //   - AbortError（超时/取消）—— callLLM 透传
  //   - 其他非预期异常（SDK bug 等）
  const errInfo = unwrapError(e);
  const isTimeout =
    (e instanceof DOMException && e.name === "AbortError") ||
    errInfo.name === "AbortError";

  const errorMsg = isTimeout
    ? "LLM 调用超时"
    : `LLM 调用异常: ${errInfo.message ?? String(e)}`;
  const retryDelayMs = isTimeout ? 2000 : 1000;

  await saveDialogue("assistant", `[错误] ${errorMsg}`);
  process.stderr.write(
    `\n${stepLabel} ${errorMsg}，${retryDelayMs}ms 后重试\n`
  );
  await new Promise((r) => setTimeout(r, retryDelayMs));
  continue;
}
```

**关键改进**：
1. 日志从"重试"改为明确描述 `LLM 调用超时` / `LLM 调用异常`
2. 添加 `await new Promise(r => setTimeout(r, retryDelayMs))` 退避延迟
3. 超时等待 2s（给 API 恢复时间），非预期异常等待 1s
4. 注释明确说明到达此处的异常类型

### 3.4 Layer 2（补充）：dispatcher.ts — 同步修复

`dispatcher.ts` 的 `SubAgent.run()` 第127-147行有相同模式，需同步修复：

```typescript
// dispatcher.ts SubAgent.run() 第127-147行替换为：

} catch (e: unknown) {
  clearTimeout(timeout);
  // callLLM 内部已重试，到这里只有 AbortError 或非预期异常
  if (e instanceof DOMException && e.name === "AbortError") {
    await saveDialogue(
      "system",
      `[子Agent 超时] LLM 调用超过 ${LLM_CALL_TIMEOUT_MS}ms（已重试）`,
    );
    return {
      status: "error",
      output: `子Agent LLM 调用超时（${LLM_CALL_TIMEOUT_MS}ms）`,
    };
  }
  await saveDialogue(
    "system",
    `[子Agent 错误] ${unwrapError(e).message ?? e}`,
  );
  return {
    status: "error",
    output: `子Agent 执行出错: ${unwrapError(e).message ?? e}`,
  };
}
```

> **注意**：子 Agent 收到 AbortError 后直接返回 error 状态是合理的设计（子 Agent 有独立的时间预算），不需要像主 Agent 那样 continue。此处主要更新注释以反映 callLLM 已内置重试的事实。

---

## 4. 修改清单

| 文件 | 修改内容 | 新增行数（估计） | 删除行数（估计） |
|------|---------|:---:|:---:|
| `src/llm.ts` | 添加 `MAX_RETRIES`/`BASE_RETRY_DELAY_MS`/`MAX_JITTER_MS` 常量；添加 `isRetryableError()` 函数；重构 catch 块为重试循环 | +50 | -15 |
| `src/orchestrator.ts` | 重写第42-51行 catch 块：添加退避延迟、修正日志 | +12 | -6 |
| `src/dispatcher.ts` | 更新第127-147行 catch 块注释，反映 callLLM 已内置重试 | +4 | -2 |

**总计估计**：约 +66 行，-23 行，净增约 43 行。

---

## 5. 验收标准

### 5.1 功能验收

| # | 场景 | 预期行为 |
|---|------|---------|
| 1 | API 返回 429（限频） | 自动等待指数退避（1s→2s→4s+抖动），最多重试 3 次；3 次均失败则返回明确错误文本（含重试次数）；stderr 输出重试日志 |
| 2 | API 返回 500/502/503 | 同上 |
| 3 | 网络连接失败（ECONNREFUSED） | 同上 |
| 4 | DNS 解析失败（ENOTFOUND） | 同上 |
| 5 | API 返回 401/403（认证失败） | **不重试**，立即返回认证错误文本 |
| 6 | API 返回 400（参数错误） | **不重试**，立即返回错误文本 |
| 7 | 请求超时（AbortError） | callLLM **不重试**，透传给调用方；orchestrator 等待 2s 后 continue |
| 8 | 正常响应 | 行为不变，无性能退化 |
| 9 | 重试日志 | stderr 输出 `[重试 N/3] HTTP 429 — Xms 后退避重试` 格式日志 |
| 10 | 子 Agent 429 场景 | callLLM 自动重试，子 Agent 不感知瞬态错误；重试耗尽后子 Agent 正常收到错误文本并返回 error 状态 |

### 5.2 非功能验收

| # | 项目 | 标准 |
|---|------|------|
| 11 | 无回归 | 现有测试全部通过；`bun run build` 无类型错误 |
| 12 | 重试抖动 | 每次重试延迟包含随机分量（避免惊群） |
| 13 | 不可达代码 | 重试循环最后的 fallback return 不会在正常流程中执行，但不产生 unreachable-code warning |
| 14 | 代码审查 | `llm.ts` 不含任何裸 `return` 错误文本（所有错误路径都经过 `isRetryableError` 判定） |

### 5.3 边界场景

| # | 场景 | 预期 |
|---|------|------|
| 15 | 连续 429 跨越多个 ReAct 轮次 | 每轮中的首次 LLM 调用独立重试，不跨轮共享退避状态 |
| 16 | AbortSignal 已在调用前 abort | 立即 throw AbortError（不进入重试循环） |
| 17 | 重试期间 AbortSignal 被 abort | 当前等待被打断（`signal.addEventListener("abort")` 可选优化） |

---

## 6. 工作量估计

| 任务 | 估计工时 | 说明 |
|------|:---:|------|
| 6.1 `llm.ts` 添加指数退避重试 | 1.0h | 核心实现：新增工具函数 `isRetryableError`、重试循环、日志输出 |
| 6.2 `orchestrator.ts` 修复 catch 块 | 0.3h | 添加退避延迟、修正日志文本和注释 |
| 6.3 `dispatcher.ts` 更新 catch 块 | 0.2h | 更新注释以反映 callLLM 已内置重试 |
| 6.4 自测 + 代码审查 | 0.5h | 验证所有验收场景、确保无回归 |
| **合计** | **2.0h** | |

---

## 7. 风险与回滚

### 7.1 风险

| 风险 | 概率 | 缓解措施 |
|------|:---:|---------|
| 重试增加 API 负载，加剧限频 | 低 | 指数退避 + 随机抖动天然分散请求时间；MAX_RETRIES=3 限制总尝试次数 |
| 重试延迟过长导致用户等待 | 低 | 总重试时间约 8.5 秒（最坏情况），远好于当前立即失败后用户手动重试的时间 |
| 与 AbortSignal 的交互 | 低 | `signal.aborted` 检查在重试判断之前；第16项为可选后续优化 |

### 7.2 回滚方案

如重试逻辑引入新问题，可通过以下方式快速回滚：
1. 将 `MAX_RETRIES` 设为 `0`（跳过所有重试，行为退化为当前状态）
2. 或通过环境变量 `LLM_MAX_RETRIES=0` 控制（后续可添加）

---

## 附录 A：与现有 plan.md 的关系

本文件是 [plan.md](../plan.md) 中 **Phase 1 第 1.6 节（添加 LLM 调用重试机制）** 的详细展开版本。plan.md 中的 1.6 节提供了概要方案和示例代码，本文档基于 ISSUE-06 的实际代码验证结果，提供了：

1. 精确的代码行号引用（已验证所有行号与当前 main 分支一致）
2. 逐帧执行路径推演（以 429 为例的 7 步执行路径）
3. 完整的三文件影响分析（llm.ts → orchestrator.ts → dispatcher.ts）
4. 15 项详细验收标准（含边界场景）
5. 错误处理流程图

plan.md 中的 1.6 节可作为**高层概要**，本文档作为**实现规格说明书**。

---

## 附录 B：影响链可视化

```
                        DeepSeek API 返回 429
                              │
                              ▼
                     OpenAI SDK 抛出异常
                              │
                              ▼
              ┌──────────────────────────────┐
              │     llm.ts callLLM catch     │
              │                              │
              │  当前：return 错误文本        │
              │  修复：指数退避重试（3次）    │
              │       失败后 return 错误文本  │
              └──────────────┬───────────────┘
                             │
              ┌──────────────┴──────────────┐
              ▼                             ▼
    ┌──────────────────┐         ┌──────────────────────┐
    │  orchestrator.ts │         │   dispatcher.ts      │
    │  runReAct()      │         │   SubAgent.run()     │
    │                  │         │                      │
    │  当前：错误文本   │         │  当前：错误文本被当作 │
    │  被当作最终答案   │         │  子Agent完成输出     │
    │  返回给用户       │         │  注入父Agent上下文   │
    │                  │         │                      │
    │  修复：catch 块   │         │  修复：callLLM已内置 │
    │  添加退避延迟     │         │  重试，更新注释      │
    │  修正日志文本     │         │                      │
    └──────────────────┘         └──────────────────────┘

              ▼                             ▼
        用户看到正确结果              子Agent不传播错误
        或明确的重试失败信息          返回干净的error状态
```
