# ISSUE-07 优化计划：dispatch 对 plan.md 的硬依赖问题

> **状态**: 计划阶段 | **版本**: v1.0 | **日期**: 2026-07-16
> **验证结论**: 已确认 —— dispatch 工具对 plan.md 存在硬依赖，且用户和 LLM 均无提前知晓此限制的途径。

---

## 1. 问题描述

### 1.1 核心问题

`dispatch` 工具在非 exploratory 模式下强制执行 `plan.md` 存在性检查（`src/tool-executor.ts:27-31`）。当 `plan.md` 不存在且调用方未传入 `exploratory: true` 时，dispatch 被**直接拒绝**，返回中文错误提示，不会执行任何子 Agent。

```typescript
// src/tool-executor.ts:27-31
const planFile = Bun.file("plan.md");
if (!(await planFile.exists())) {
    if (!args.exploratory)
        return "dispatch 需要 plan.md 才能执行。请先用 write 写下计划，再 dispatch。";
}
```

问题不在于功能设计本身（要求有计划是合理的），而在于**可见性严重不足**——LLM 在不知情的情况下发起非 exploratory 的 dispatch 调用，在 plan.md 不存在时被拒绝，导致用户体验中断。

### 1.2 四个知情缺口

| 缺口位置 | 当前状态 | 问题 |
|---|---|---|
| **tools.ts（dispatch schema）** | `exploratory` 参数未录入 schema | LLM 完全不知道此参数存在，无法主动传入 |
| **prompts.ts（系统 prompt）** | 建议性策略描述，未说明强制约束 | LLM 不知道调用会**被拒绝** |
| **tool-executor.ts（错误消息）** | 仅中文提示，未引导解决方案 | 用户/LLM 不知道可通过 `exploratory: true` 绕过 |
| **README.md** | 将 plan.md 描述为功能特性/运行时产物 | 未说明 dispatch 对 plan.md 的硬依赖 |

### 1.3 详细证据

#### 缺口 1：dispatch 工具 schema 缺少 `exploratory` 参数

```typescript
// src/tools.ts:116-141 —— 当前的 dispatch 工具定义
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
                task: { type: "string", description: "（必填）子Agent要完成的具体任务" },
                role: { type: "string", description: "（可选）子Agent的角色身份" },
                format: { type: "string", description: "（可选）返回数据格式说明" },
            },
        },
    },
};
```

**缺失**: `exploratory` 参数未出现在 schema 中，LLM 无法通过函数签名推断其存在。虽然 `DispatchConfig` 类型（`src/types.ts:64-65`）定义了该字段，但此类型仅用于内部实现，不暴露给 LLM。

#### 缺口 2：系统 prompt 未告知硬约束

```typescript
// src/prompts.ts —— 仅第20行提到探索模式，但措辞为建议性
`- 探索性任务（查询/分析）：直接用 dispatch，无需先写 plan.md`
```

完整 prompt 中所有与 dispatch/plan 相关的表述均为**策略级建议**，如"先 dispatch 探索分析，根据结果 write plan"、"大规模任务：按目录/模块分批"。没有任何一处说明：
- 非 exploratory 的 dispatch 调用在 plan.md 不存在时会**直接返回错误**
- `exploratory` 参数的存在、作用及用法

#### 缺口 3：错误消息无恢复引导

```typescript
// src/tool-executor.ts:30
return "dispatch 需要 plan.md 才能执行。请先用 write 写下计划，再 dispatch。";
```

该消息只告知一种恢复路径（先写 plan.md），未提及可传入 `exploratory: true` 立即重试。同时消息仅为中文，不利于国际化场景。

#### 缺口 4：README 误导性描述

README.md 中 plan.md 出现 4 次（L19、L41、L65、L120），均以正面功能特性形式呈现：
- "Relay Code writes a plan.md at runtime..." —— 描述为运行时产物，而非前置条件
- "Write a lightweight plan.md — the harness auto-injects it..." —— 强调便利性，非强制性

---

## 2. 影响范围

### 2.1 受影响文件

| 文件 | 角色 | 变更类型 |
|---|---|---|
| `src/tools.ts` (L116-141) | dispatch 工具 schema 定义 | 新增 `exploratory` 参数 |
| `src/tool-executor.ts` (L27-31) | plan.md 检查 + 错误处理 | 修改错误消息 + 降级逻辑 |
| `src/prompts.ts` (L16, L20) | 系统 prompt 编排策略 | 补充约束说明 |
| `README.md` (L19, L41, L65, L120) | 用户文档 | 新增约束说明段落 |

### 2.2 受影响流程

```
用户请求 → Orchestrator ReAct 循环 → LLM 生成 dispatch 调用
                                           │
                                           ▼
                                   tool-executor.ts
                                   plan.md 检查 (L27-31)
                                           │
                          ┌────────────────┼────────────────┐
                          │ plan.md 存在   │ plan.md 不存在  │
                          ▼                ▼                │
                     正常派发        exploratory?          │
                                     │         │           │
                              true   │   false/undefined   │
                                     ▼         ▼           │
                                正常派发   返回错误,中断工作流
```

**影响**: 当前目录首次启动时（plan.md 尚未生成），任何非探索性的 dispatch 调用均会失败。由于 LLM 不知道此限制，会反复尝试 dispatch，陷入"调 dispatch→被拒→调 dispatch→被拒"的循环。

### 2.3 严重程度

| 维度 | 评级 |
|---|---|
| 功能完整性 | 中等 —— 功能可用但可见性不足 |
| 用户体验 | 中等 —— 首次使用容易触发中断 |
| LLM 行为可预测性 | 中等 —— LLM 缺乏所需信息 |
| 文档完整性 | 低 —— 关键约束未记载 |

---

## 3. 修复方案

### 方案 a：tool-executor.ts 自动降级 + 增强错误消息

**目标**: 当 plan.md 不存在时不让 dispatch 直接失败，而是自动将调用降级为 exploratory 模式，并通过 warning 消息告知 LLM。

**修改位置**: `src/tool-executor.ts`，dispatch 分支（L20-53）

**具体改动**:

1. **自动降级**：当 plan.md 不存在且未传入 `exploratory: true` 时，不再返回错误字符串，而是自动将调用视为 exploratory 模式并继续执行。同时在前缀添加 warning 提示。

```typescript
// 伪代码（精确实现见正式 PR）
if (!(await planFile.exists())) {
    if (!args.exploratory) {
        // 自动降级为 exploratory 模式
        args = { ...args, exploratory: true };
        warningPrefix = "⚠ plan.md 不存在，已自动切换为探索模式。如需使用 plan-driven 工作流，请先用 write 创建 plan.md。\n\n";
    }
}
const config: DispatchConfig = {
    // ... existing config ...
    exploratory: args.exploratory,  // 传递到 DispatchConfig
};
const result = await this.dispatchFn(config);
return warningPrefix + (result.structured ? ... : ...);
```

2. **传递 exploratory 到 DispatchConfig**：目前 `tool-executor.ts` 构建的 `DispatchConfig` 对象（L32-48）未包含 `exploratory` 字段，需要补充。

```typescript
// 当前 L32-48 —— 缺少 exploratory 传递
const config: DispatchConfig = {
    prompt: { task, role: ..., instructions: ... },
    responseSchema: ...,
    max_rounds: 30,
    // 缺失: exploratory: args.exploratory,
};
```

**注意**: `DispatchConfig` 类型（`src/types.ts:65`）已有 `exploratory?: boolean` 定义，仅需在拼装 config 对象时填入即可。

**优点**:
- 用户体验零中断 —— dispatch 永远不会因为 plan.md 缺失而直接拒绝
- LLM 也能从 warning 消息中学习到 plan.md 的存在价值
- 向后兼容 —— 对已有 plan.md 的正常工作流无任何影响

**风险**:
- 自动降级可能导致 LLM 在不需要 plan.md 的场景下也频繁收到 warning（可通过消息精简缓解）
- 需确保 `dispatcher.ts` 中 exploratory 模式的行为差异符合预期

---

### 方案 b：prompts.ts 补充说明

**目标**: 让 LLM 从一开始就知道 dispatch 的完整语义和约束。

**修改位置**: `src/prompts.ts`，`buildSystemPrompt()` 函数

**具体改动**:

在现有编排策略段落后新增"dispatch 说明"段落：

```typescript
export function buildSystemPrompt(): string {
  return `你是 Relay Code Agent。你有以下工具可用：

  read(path)        —— 读取本地文件
  write(path, cont) —— 写入本地文件
  grep(pattern)     —— 搜索文本
  bash(command)     —— 执行 shell 命令
  dispatch(task, role?, format?, exploratory?)    —— 工作流编排：派生子Agent并行执行

dispatch 参数说明：
  - task（必填）：子Agent 要完成的具体任务
  - role（可选）：子Agent 的角色身份
  - format（可选）：返回数据格式说明
  - exploratory（可选，默认 false）：设为 true 可跳过 plan.md 检查，适合探索性任务

dispatch 与 plan.md 的关系：
  - plan.md 存在时：dispatch 正常执行，plan.md 会注入子Agent 上下文
  - plan.md 不存在时：dispatch 需要 exploratory: true，否则返回提示；但系统也会自动降级并给出 warning
  - 复杂任务建议先 dispatch(exploratory: true) 探索，再 write plan.md，最后 dispatch 执行

编排策略：
- 复杂任务（多维度分析/重构）：先 dispatch 探索分析，根据结果 write plan，再 dispatch 执行各阶段
- 对比任务：并行 dispatch 两个子Agent 带不同角色，对比它们的返回再决策
- 大规模任务：按目录/模块分批，每批完成后验证再进下一批
- 遇到子Agent 返回 error：修改 plan 调整路线，不要重复失败的 dispatch
- 探索性任务（查询/分析）：dispatch(exploratory: true)，无需先写 plan.md`;
}
```

**关键补充点**:
- `dispatch` 工具签名中增加 `exploratory?` 参数
- 新增"dispatch 参数说明"段落，逐参数解释
- 新增"dispatch 与 plan.md 的关系"段落，明确三种状态的语义
- 修改探索性任务策略，从"直接用 dispatch"改为"dispatch(exploratory: true)"

---

### 方案 c：README 文档化

**目标**: 让用户在首次使用前就能了解 dispatch 的工作机制。

**修改位置**: `README.md`

**具体改动**:

在现有"Plan-Driven Workflow"段落（约 L118）后新增子段落：

```markdown
### 🧩 Plan-Driven Workflow

Write a lightweight `plan.md` — the harness auto-injects it into context.
The agent follows the plan's phases and uses `dispatch` to parallelize work.

**dispatch 执行模式**:

| 模式 | plan.md 状态 | 行为 |
|---|---|---|
| 计划模式（默认） | 存在 | 正常派发，plan.md 注入子Agent 上下文 |
| 计划模式（默认） | 不存在 | 自动降级为探索模式（带 warning） |
| 探索模式（`exploratory: true`） | 任意 | 跳过检查，不注入 plan.md |

**最佳实践**：
1. 首次启动：使用 `dispatch(exploratory: true)` 探索项目结构
2. 用 `write` 创建 `plan.md` 描述各阶段
3. 用 `dispatch`（不带 exploratory）按阶段并行执行子任务
```

同时修改 README 中首次提及 plan.md 的地方（L19），在描述后补充一句"dispatch 工具在不含 exploratory 模式时依赖此文件执行"。

---

### 方案 d：tools.ts schema 补充 `exploratory` 参数（关键修复）

**目标**: 让 LLM 通过工具定义（function calling schema）直接知晓 `exploratory` 参数的存在。

**修改位置**: `src/tools.ts`，`dispatchTool` 对象（L116-141）

**具体改动**:

```typescript
const dispatchTool: ToolDefinition = {
    type: "function",
    function: {
        name: "dispatch",
        description:
            "工作流编排：派生子Agent并行执行子任务。" +
            "exploratory: true 可跳过 plan.md 检查（用于探索任务）。" +
            "不带 exploratory 时需确保 plan.md 存在（缺失时系统会自动降级并 warning）。",
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
                    description:
                        "（可选，默认 false）设为 true 跳过 plan.md 检查，适用于探索性/查询任务。" +
                        "设为 false 或不传时，plan.md 缺失会触发自动降级。",
                },
            },
        },
    },
};
```

**注意**: 这是**最关键的修复**。LLM 通过 function calling schema 发现可用参数，如果 schema 中不包含 `exploratory`，LLM 就永远不知道它的存在。即使 prompt 中有说明，LLM 在生成 function call JSON 时也可能忽略。

---

## 4. 实施计划

### 4.1 修复顺序

| 步骤 | 方案 | 文件 | 优先级 | 预估耗时 |
|---|---|---|---|---|
| 1 | d | `src/tools.ts` | P0 关键 | 10 min |
| 2 | a | `src/tool-executor.ts` | P0 关键 | 20 min |
| 3 | b | `src/prompts.ts` | P1 重要 | 15 min |
| 4 | c | `README.md` | P2 文档 | 15 min |

**理由**: 按依赖关系排序。
- 步骤 1（schema）确保 LLM 能生成包含 `exploratory` 的 function call。
- 步骤 2（降级逻辑）确保即使 LLM 不传 `exploratory`，dispatch 也不会硬拒绝。
- 步骤 3（prompt）让 LLM 在决策时考虑 `exploratory` 参数。
- 步骤 4（README）让人类用户理解设计意图。

### 4.2 风险矩阵

| 风险 | 缓解措施 |
|---|---|
| 自动降级后 LLM 不写 plan.md，失去 plan-driven 优势 | warning 消息明确提示 plan.md 的价值，prompt 也强化此观念 |
| 向后兼容：已依赖旧错误消息的现有脚本 | 错误消息改为 warning 前缀而非完整替换，语义不变 |
| `exploratory` 参数传递链路断裂 | 同时在 types.ts（已有）、tool-executor.ts（新增传递）、dispatcher.ts 三处对齐 |

### 4.3 不修改的文件

以下文件**不需要修改**（已验证）：

| 文件 | 原因 |
|---|---|
| `src/dispatcher.ts` | 已接收完整的 `DispatchConfig`，含 `exploratory` 字段。无需改动。 |
| `src/message-assembler.ts` | 不参与 dispatch 前置校验，仅负责拼装消息。无需改动。 |
| `src/types.ts` | `DispatchConfig.exploratory?: boolean` 已定义（L64-65）。无需改动。 |

---

## 5. 验收标准

### 5.1 功能验收

1. **plan.md 不存在，LLM 不传 exploratory 时**：
   - dispatch 返回 warning 前缀的消息（如 "⚠ plan.md 不存在，已自动切换为探索模式"）
   - 子 Agent **仍然被派发执行**，不被拒绝
   - 返回正常结果（含 structured output）

2. **plan.md 不存在，LLM 传 exploratory: true 时**：
   - dispatch 直接执行，无 warning 前缀
   - 子 Agent 正常返回结果

3. **plan.md 存在，无论是否传 exploratory**：
   - dispatch 正常执行
   - plan.md 内容注入子 Agent 上下文（通过现有 PlanManager 流程）
   - 无任何 warning

4. **dispatch 工具 schema**：
   - LLM 通过 function calling 可发现 `exploratory` 参数（boolean, 可选）
   - schema description 中包含 plan.md 检查逻辑的概要

### 5.2 文档验收

5. **系统 prompt** 包含：
   - `exploratory` 参数用法说明：`dispatch(task, role?, format?, exploratory?)`
   - plan.md 存在/不存在时 dispatch 的行为差异表

6. **README.md** 包含：
   - dispatch 执行模式对照表（3 种场景）
   - 最佳实践流程（探索 → plan → 派发）

### 5.3 回归验收

7. 已有 plan.md 的正常工作流不受影响（无新增 warning，无行为变更）
8. TypeScript 编译通过（`bun run typecheck`）
9. 所有现有测试通过（`bun test`）

---

## 6. 工作量估计

| 阶段 | 内容 | 预估耗时 |
|---|---|---|
| 代码实现 | 方案 d + a + b（4 个文件，约 60 行变更） | 45 min |
| 文档更新 | 方案 c（README 新增段落） | 15 min |
| 测试 | 手写 3 个场景的单元测试 | 30 min |
| 回归 | 运行现有测试套件 + 手动验证 | 15 min |
| Code Review | 同行审查 + CI | 15 min |

| | |
|---|---|
| **总预估** | **2 小时** |
| **实际上线风险** | 低（变更集中在 3 个源文件 + 1 个文档文件，无架构变更） |

---

## 附录：关键文件清单

| 文件路径 | 用途 |
|---|---|
| `C:\Users\evena\学习\relay-code\src\tool-executor.ts` | plan.md 检查逻辑（L27-31），需降级处理 |
| `C:\Users\evena\学习\relay-code\src\tools.ts` | dispatch 工具 schema（L116-141），需补充 exploratory |
| `C:\Users\evena\学习\relay-code\src\prompts.ts` | 系统 prompt（L16, L20），需补充约束说明 |
| `C:\Users\evena\学习\relay-code\src\types.ts` | DispatchConfig 类型（L64-65），已有 exploratory，需在 config 拼装处传递 |
| `C:\Users\evena\学习\relay-code\README.md` | 用户文档 |
