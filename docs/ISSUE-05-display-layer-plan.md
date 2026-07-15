# ISSUE-05 独立优化 Plan：展示层几乎不存在

> **评分**: 2.3/10 | **优先级**: High | **总工作量**: 11.5h
>
> 基于 2026-07-16 全面验证报告生成，6 个验证步骤全部确认。

---

## 1. 问题描述

Relay-Code 的终端展示层几乎不存在。当前所有用户可见输出仅有 6 处 `process.stderr.write`（4 处在 orchestrator.ts，2 处在 feedback.ts 定义）和 20 处 `console.log`（全在 index.ts 的帮助/聊天模式）。用户运行时看到的是一片无格式的裸文本，无法感知 Agent 当前在做什么、子 Agent 各自在做什么、整体进度如何。

### 1.1 与 Claude Code 的差距对照

| 展示能力 | Claude Code 参考 | Relay-Code 当前状态 |
|----------|------------------|---------------------|
| ANSI 颜色 | `c.green`/`c.red`/`c.cyan`/`c.dim` 等 8 种 SGR 颜色 | **无**，src/ 目录 0 个 ANSI 转义序列 |
| Spinner 动画 | `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` 10 帧，80ms 间隔，原地刷新 | **无**，无任何定时器驱动的动画 |
| 步骤进度 | `[N/60]` + 工具调用结果 `✓/✗` + 操作描述 | **仅 `[N/60]` 裸数字**，无成功/失败标记 |
| 耗时显示 | `(1.2s)` 配合状态行，显示当前操作耗时 | `elapsed()` 函数存在但**从未被调用** |
| 子 Agent 树 | 缩进层级 + 启动/完成标识 + 状态图标 | **仅 `[子Agent]` 纯文本前缀** |
| 计划可视化 | 阶段列表 + 进度渲染到终端 | `PlanState.render()` **仅注入 LLM**，终端从不显示 |
| 非 TTY 降级 | 时间戳里程碑日志 + 静默策略 | **完全静默**（isTTY 检查直接 return） |
| 指标统计 | 执行指标在完成后展示 | `ExecutionMetrics` 仅类型定义，从未实例化或打印 |
| 零外部依赖 | 使用 ANSI escape code，无第三方包 | 无任何颜色/展示依赖（package.json 仅含 `openai`） |

### 1.2 根因分析

当前代码库的展示相关代码仅有：

- **`src/feedback.ts`（18 行）**: 提供 `feedback(msg)` 和 `feedbackLine(msg)`，仅做 `isTTY + process.stderr.write`，外加一个从未被调用的 `elapsed(t0)` 辅助函数。
- **`src/orchestrator.ts` 的 4 处写入**: 思考中状态行（`\r` 行内刷新）、异常重试提示、完成提示、工具调用摘要。
- **`src/dispatcher.ts` 的 4 处写入**: 子 Agent 轮次（含时间）、工具名称。
- **`src/index.ts` 的 console.log**: 帮助信息、聊天模式 prompt、最终结果输出。

这些输出没有统一的管理层，分布在三个文件中，各自使用重复的 `process.stderr.write` 模式，没有任何格式化、没有本地化策略、没有 TTY/非 TTY 双模式输出。

---

## 2. 当前状态 vs 目标状态

### 2.1 当前状态

```
用户运行: bun run start "修复 README 拼写错误"

终端输出（TTY 模式下实际看到的内容）:
─────────────────────────────────────────────
[1/60] 思考中...[1/60] read + write
[2/60] 思考中...[2/60] 完成
  [子Agent] 轮次 1/60 (0.0s)
  [子Agent] ⊜ grep
  [子Agent] ⊜ read
  [子Agent] 轮次 2/60 (0.0s)
  [子Agent] ⊜ edit
  [子Agent] ⊜ write
(最终结果文本)
─────────────────────────────────────────────
```

**问题清单**:
- `[1/60] 思考中...` 在收到 LLM 响应后没有被清除，残留 `\r` 刷新不完整
- 无颜色区分步骤标签、工具名称、成功/失败状态
- 无 spinner 动画表示"正在等待 LLM 响应"
- 无耗时显示，用户不知道这轮 LLM 调用了多久
- 子 Agent 输出平铺，无树形缩进层级
- 计划信息完全不显示给用户
- 非 TTY 模式下完全静默（`feedback()` 在 `!isTTY` 时直接 return）

### 2.2 目标状态

```
用户运行: bun run start "修复 README 拼写错误"

终端输出（TTY 模式，理想效果）:
─────────────────────────────────────────────
📋 计划:
⬜ 阶段1: 探索代码库
⬜ 阶段2: 修复拼写错误
⬜ 阶段3: 验证修改

[1/60] ⠋ 思考中... (1.2s)
[1/60] ✅ read → 读取 README.md (共 42 行)
[1/60] ✅ write → 保存 plan.md

[2/60] ⠙ 思考中... (2.1s)
│
├─ 🔹 子Agent: 修复 README.md 中的拼写错误
│  [1/30] ⠹ 子Agent思考中... (0.8s)
│  [1/30] ✓ grep → 找到 1 个文件
│  [2/30] ⠸ 子Agent思考中... (1.3s)
│  [2/30] ✓ edit → 修改 README.md (L15)
│  ✅ 完成 (2轮, 3.2s)
│
[2/60] ✅ dispatch → 修复 README 拼写错误

[3/60] ⠋ 思考中... (0.9s)
[3/60] ✅ 完成 (总耗时 12.4s)
─────────────────────────────────────────────
```

**非 TTY 模式（管道/重定向）**:
```
[14:23:01] 计划加载 (3 个阶段)
[14:23:01] [1/60] 思考中...
[14:23:05] [1/60] OK read: 读取 README.md
[14:23:05] [1/60] OK write: 保存 plan.md
[14:23:05] [2/60] 思考中...
[14:23:05] [子Agent] 启动: 修复 README.md 中的拼写错误
[14:23:06] [子Agent][1/30] 思考中...
[14:23:06] [子Agent][1/30] OK grep: 找到 1 个文件
[14:23:08] [子Agent][2/30] 思考中...
[14:23:08] [子Agent][2/30] OK edit: 修改 README.md (L15)
[14:23:08] [子Agent] 完成: 成功 (2轮, 3.2s)
[14:23:12] [2/60] OK dispatch: 修复 README 拼写错误
[14:23:13] [3/60] 思考中...
[14:23:14] [3/60] 完成 (总耗时 12.4s)
```

---

## 3. 分层优化方案

### 3.1 Layer 1: ANSI 基础工具包 (`src/display.ts`)

**目标**: 新建统一的终端输出层，封装 ANSI 颜色、spinner 动画、TTY/非 TTY 双模式策略。

**状态**: 新建文件 `src/display.ts`，约 120 行。

**核心职责**:
1. 定义 ANSI SGR 颜色常量（零依赖，纯 escape code）
2. 管理全局 spinner 定时器
3. 提供状态行（原地刷新 / 非 TTY 回退为行日志）
4. 统一所有展示函数的 isTTY 分发逻辑

**实现要点**:

```typescript
// src/display.ts

// ── ANSI 基础 ──────────────────────────────────
const CSI = "\x1b[";
const SGR = (n: number) => `${CSI}${n}m`;

export const c = {
  reset: SGR(0),
  bold: SGR(1),
  dim: SGR(2),
  italic: SGR(3),
  underline: SGR(4),
  red: SGR(31),
  green: SGR(32),
  yellow: SGR(33),
  blue: SGR(34),
  magenta: SGR(35),
  cyan: SGR(36),
  white: SGR(37),
};

// 光标控制
const CLEAR_LINE = `${CSI}2K`;
const CURSOR_UP = (n: number) => `${CSI}${n}A`;
const CURSOR_HIDE = `${CSI}?25l`;
const CURSOR_SHOW = `${CSI}?25h`;

// ── Spinner ────────────────────────────────────
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;
const isTTY = process.stderr.isTTY;

let spinnerIdx = 0;
let spinnerTimer: ReturnType<typeof setInterval> | null = null;

export function startSpinner(): void {
  if (!isTTY) return;
  if (spinnerTimer) return;  // 防止重复启动
  process.stderr.write(CURSOR_HIDE);
  spinnerTimer = setInterval(() => {
    spinnerIdx = (spinnerIdx + 1) % FRAMES.length;
  }, SPINNER_INTERVAL_MS);
}

export function stopSpinner(): void {
  if (spinnerTimer) {
    clearInterval(spinnerTimer);
    spinnerTimer = null;
    process.stderr.write(CURSOR_SHOW);
  }
}

export function getSpinnerFrame(): string {
  return FRAMES[spinnerIdx] ?? " ";
}

// ── 非 TTY 降级: 时间戳日志 ──────────────────
function timestamp(): string {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

/** 仅在非 TTY 时输出带时间戳的行；TTY 模式下不输出（由 statusLine 承担） */
export function milestone(msg: string): void {
  if (!isTTY) {
    process.stderr.write(`[${timestamp()}] ${msg}\n`);
  }
}

// ── 状态行 ─────────────────────────────────────
let lastStatusLine = "";

/**
 * 输出/刷新主状态行。
 * - TTY: \r 回到行首 → 清除到行尾 → 写入新内容（不换行）
 * - 非 TTY: 仅在内容变化时输出一行带时间戳的日志
 */
export function statusLine(
  step: number,
  total: number,
  action: string,
  elapsedSec: number,
  prefix?: string,
): void {
  const frame = getSpinnerFrame();
  const prefixStr = prefix ? `${prefix} ` : "";
  const line =
    `${prefixStr}${c.cyan}[${step}/${total}]${c.reset} ` +
    `${frame} ${action} ${c.dim}(${elapsedSec.toFixed(1)}s)${c.reset}`;

  if (isTTY) {
    process.stderr.write(`\r${CLEAR_LINE}${line}`);
  } else {
    if (line !== lastStatusLine) {
      lastStatusLine = line;
      // 移除 ANSI 码后输出纯文本
      const plain = line.replace(/\x1b\[\d*m/g, "");
      process.stderr.write(`[${timestamp()}] ${plain}\n`);
    }
  }
  lastStatusLine = line;
}

/** 清除当前状态行并换行（状态行结束后的清理） */
export function clearStatusLine(): void {
  if (isTTY) {
    process.stderr.write(`\r${CLEAR_LINE}`);
  }
}
```

**涉及文件**:
- **新建**: `src/display.ts`（约 120 行）

**验收标准**:
- [ ] `import { c, startSpinner, stopSpinner, statusLine, clearStatusLine, milestone } from "./display"` 可在其他模块正常导入
- [ ] `c.green + "OK" + c.reset` 在 TTY 中输出绿色文本
- [ ] `startSpinner()` 后 `getSpinnerFrame()` 每 80ms 返回不同的 spinner 帧
- [ ] `stopSpinner()` 后 spinner 定时器被清除
- [ ] 管道模式下（`echo test | bun ...`），`milestone()` 输出带时间戳，`statusLine()` 输出纯文本无 ANSI
- [ ] `clearStatusLine()` 清除 `\r` 刷新残留

**工作量**: 1.5h

---

### 3.2 Layer 2: 主 Agent 状态行改造

**目标**: 将 `orchestrator.ts` 中 4 处裸 `process.stderr.write` 替换为 `display.ts` 的统一状态行。

**现状分析** (`src/orchestrator.ts`):

| 行号 | 当前代码 | 替换为 |
|------|----------|--------|
| 32 | `process.stderr.write(\`${stepLabel} 思考中...\r\`)` | `statusLine(i+1, MAX, "思考中", elapsedSec)` + `startSpinner()` |
| 49 | `process.stderr.write(\`${stepLabel} LLM 调用异常，重试\n\`)` | `clearStatusLine()` + `toolResult("思考", false, "LLM 异常，重试")` |
| 54 | `process.stderr.write(\`${stepLabel} 完成\n\`)` | `clearStatusLine()` + `toolResult("完成", true, \`总耗时 ${elapsedSec}s\`)` |
| 79 | `process.stderr.write(\`${stepLabel} ${actions.join(" + ")}\n\`)` | `clearStatusLine()` + `toolResult(action, true, summary)` 逐个调用 |

**实现要点**:

```typescript
// src/orchestrator.ts 修改要点

import {
  startSpinner, stopSpinner, clearStatusLine,
  statusLine, milestone, c
} from "./display";

// runReAct 方法开头：记录开始时间
const mainStart = Date.now();

// 循环内（for 循环顶部）:
const iterStart = Date.now();
startSpinner();
statusLine(i + 1, MAX_REACT_ITERATIONS, "思考中", (Date.now() - iterStart) / 1000);

// LLM 调用成功后:
stopSpinner();
clearStatusLine();
// 输出 stepLabel（已完成状态行的作用）
process.stderr.write(
  `${c.cyan}[${i + 1}/${MAX_REACT_ITERATIONS}]${c.reset} ` +
  `${c.green}✓${c.reset} 思考完成 (${((Date.now() - iterStart) / 1000).toFixed(1)}s)\n`
);

// 每个工具调用完成后（替代原来的 actions.join(" + ") 行）:
for (const { tc } of parsed) {
  toolResult(tc.function.name, true, getSummary(results[ti]));
}

// LLM 调用异常（catch 块）:
stopSpinner();
clearStatusLine();
process.stderr.write(
  `${c.red}[${i + 1}/${MAX_REACT_ITERATIONS}]${c.reset} ` +
  `${c.yellow}⚠ LLM 调用异常，重试${c.reset}\n`
);

// 循环结束返回前:
clearStatusLine();
process.stderr.write(
  `${c.green}✓${c.reset} 完成 ` +
  `${c.dim}(总耗时 ${((Date.now() - mainStart) / 1000).toFixed(1)}s)${c.reset}\n`
);
```

**工具调用摘要格式化**: 在 orchestrator 中为每个工具调用输出简洁的一行摘要：

```typescript
function formatToolSummary(name: string, result: string): string {
  const MAX_LEN = 80;
  const truncated = result.length > MAX_LEN
    ? result.substring(0, MAX_LEN).replace(/\n/g, " ") + "..."
    : result.replace(/\n/g, " ");
  let label: string;
  switch (name) {
    case "read": label = "读取文件"; break;
    case "write": label = "写入文件"; break;
    case "edit": label = "编辑文件"; break;
    case "grep": label = "搜索"; break;
    case "glob": label = "查找"; break;
    case "dispatch": label = "派发子Agent"; break;
    case "bash": label = "执行命令"; break;
    default: label = name; break;
  }
  return `${label}: ${truncated}`;
}
```

**涉及文件**:
- **修改**: `src/orchestrator.ts`（约 20 处修改）
- **依赖**: `src/display.ts`（Layer 1）

**验收标准**:
- [ ] 每轮开始前显示 spinner + `[N/60] ⠋ 思考中... (1.2s)` 原地刷新
- [ ] LLM 返回后 spinner 停止，显示 `[N/60] ✓ 思考完成 (1.2s)`
- [ ] 每个工具调用显示 `  ✓ read → 读取文件: path/to/file`
- [ ] 异常情况显示 `[N/60] ⚠ LLM 调用异常，重试`
- [ ] 非 TTY 管道模式下不输出 ANSI 转义码

**工作量**: 2h

---

### 3.3 Layer 3: 计划可视化

**目标**: 将 `PlanState.render()` 的输出同时渲染到终端，让用户看到当前执行计划的阶段列表和进度。

**现状**:
- `PlanState.render()` 仅在 `buildMessage()` 中调用 → 输出注入 LLM 上下文
- 终端从未显示计划内容
- `PlanManager.getPlanMessages()` 有状态键去重机制，可用于决定何时重新渲染

**实现方案**: 在 `PlanManager` 中增加终端渲染能力，当计划首次加载或状态变化时输出计划概览。

```typescript
// src/plan-manager.ts 修改要点

import { milestone, c } from "./display";

export class PlanManager {
  private injectedStatusKey: string | null = null;
  /** 计划是否已经在终端展示过（首次加载时显示一次完整计划） */
  private planShownInTerminal = false;

  async getPlanMessages(): Promise<ChatMessage[]> {
    const plan = await PlanState.load();
    if (!plan || plan.isCompleted()) return [];

    const key = plan.getStatusKey();

    // 首次加载时渲染计划到终端
    if (!this.planShownInTerminal && plan.phases.length > 0) {
      this.renderPlanToTerminal(plan);
      this.planShownInTerminal = true;
    }

    // 状态变化时在终端更新（仅显示变化摘要）
    if (this.injectedStatusKey && this.injectedStatusKey !== key) {
      this.renderPlanChange(plan);
    }

    if (this.injectedStatusKey === key) return [];
    this.injectedStatusKey = key;

    return [plan.buildMessage()];
  }

  private renderPlanToTerminal(plan: PlanState): void {
    const isTTY = process.stderr.isTTY;
    if (isTTY) {
      process.stderr.write(`\n${c.bold}📋 执行计划${c.reset}\n`);
      for (const phase of plan.phases) {
        const icon = phase.status === "completed" ? `${c.green}✅${c.reset}`
          : phase.status === "failed" ? `${c.red}❌${c.reset}`
          : phase.status === "running" ? `${c.cyan}▶${c.reset}`
          : `${c.dim}⬜${c.reset}`;
        process.stderr.write(`  ${icon} ${phase.name}\n`);
      }
      process.stderr.write("\n");
    } else {
      milestone("执行计划:");
      for (const phase of plan.phases) {
        const marker = phase.status === "completed" ? "[✓]"
          : phase.status === "failed" ? "[✗]"
          : phase.status === "running" ? "[>]"
          : "[ ]";
        milestone(`  ${marker} ${phase.name}`);
      }
    }
  }

  private renderPlanChange(plan: PlanState): void {
    // 仅在当前阶段变为 running 或阶段完成任务时显示一行提示
    const current = plan.phases[plan.currentIndex];
    if (current) {
      const isTTY = process.stderr.isTTY;
      if (isTTY) {
        process.stderr.write(
          `${c.cyan}▶${c.reset} ${c.bold}${current.name}${c.reset}\n`
        );
      } else {
        milestone(`阶段开始: ${current.name}`);
      }
    }
  }
}
```

**涉及文件**:
- **修改**: `src/plan-manager.ts`
- **依赖**: `src/display.ts`（Layer 1）

**验收标准**:
- [ ] 首次检测到 plan.md 时终端显示完整计划列表（带阶段完成状态图标）
- [ ] 阶段状态变更时（pending→running→completed）终端有相应变化提示
- [ ] 计划全部完成后不再重复显示
- [ ] 非 TTY 模式只输出纯文本计划概览

**工作量**: 1.5h

---

### 3.4 Layer 4: 子 Agent 树形展示

**目标**: 将 `dispatcher.ts` 中平铺的 `[子Agent]` 输出改为带缩进的树形结构，清晰显示 Agent 层级关系。

**现状分析** (`src/dispatcher.ts`):

| 行号 | 当前代码 | 问题 |
|------|----------|------|
| 104-106 | `feedbackLine(\`  [子Agent] 轮次 ${i+1}/${MAX}\`)` | 使用 feedbackLine 的 isTTY 检查，无颜色 |
| 173 | `feedbackLine(\`  [子Agent] ⊜ ${name}\`)` | 无格式化 |
| 入口 | 无 | 子 Agent 启动无通告 |
| 出口 | 直接 return SubAgentResult | 子 Agent 结束无通告 |

**实现方案**:

```typescript
// src/dispatcher.ts 修改要点

import {
  startSpinner, stopSpinner, statusLine, clearStatusLine,
  milestone, c, getSpinnerFrame
} from "./display";

// dispatch 函数中，SubAgent.run() 调用前后:
function subAgentStartLine(depth: number, task: string): void {
  const indent = "│  ".repeat(depth);
  const isTTY = process.stderr.isTTY;
  const displayTask = task.length > 60 ? task.substring(0, 57) + "..." : task;
  if (isTTY) {
    process.stderr.write(
      `${indent}${c.magenta}├─ 🔹 子Agent${c.reset}: ${displayTask}\n`
    );
  } else {
    milestone(`${"  ".repeat(depth)}[子Agent] 启动: ${displayTask}`);
  }
}

function subAgentEndLine(
  depth: number,
  ok: boolean,
  rounds: number,
  elapsedSec: number,
): void {
  const indent = "│  ".repeat(depth);
  const isTTY = process.stderr.isTTY;
  const mark = ok
    ? `${c.green}✅${c.reset}`
    : `${c.red}❌${c.reset}`;
  if (isTTY) {
    process.stderr.write(
      `${indent}${mark} 完成 ` +
      `${c.dim}(${rounds}轮, ${elapsedSec.toFixed(1)}s)${c.reset}\n`
    );
  } else {
    milestone(
      `[子Agent] 完成: ${ok ? "成功" : "失败"} (${rounds}轮, ${elapsedSec.toFixed(1)}s)`
    );
  }
}

// SubAgent.run() 方法内改造:
async run(): Promise<SubAgentResult> {
  const subStart = Date.now();
  let _llmCalls = 0;
  let _toolsUsed = 0;
  const availableTools = ALL_TOOLS.filter(...);

  const iterLimit = this.maxRounds ?? 30;
  const effectiveLimit = Math.min(iterLimit, MAX_REACT_ITERATIONS);

  for (let i = 0; i < effectiveLimit; i++) {
    const roundStart = Date.now();
    startSpinner();
    statusLine(
      i + 1, effectiveLimit, "子Agent思考中",
      (Date.now() - roundStart) / 1000,
      "│  ",  // 缩进前缀
    );

    // --- LLM 调用（保持现有逻辑）---
    _llmCalls++;
    let response: LLMResponse;
    try {
      response = await callLLM(this.messages, availableTools, ...);
    } catch (e) { ... }

    stopSpinner();
    clearStatusLine();

    // 无工具调用 → 完成
    if (!response.tool_calls || response.tool_calls.length === 0) {
      process.stderr.write(
        `${"│  "}${c.green}✓${c.reset} 子Agent 完成\n`
      );
      return { status: "completed", output: response.content ?? "" };
    }

    // 工具调用结果行
    for (const { tc } of parsed) {
      _toolsUsed++;
      process.stderr.write(
        `${"│  "}  ${c.cyan}⊜${c.reset} ${tc.function.name}\n`
      );
    }

    // --- 工具执行（保持现有逻辑）---
    ...
  }
}
```

**深度参数**: 当前 relay-code 的 dispatch 调用链深度固定为 1（编排 Agent dispatch 给子 Agent），但预留 `depth` 参数以支持未来嵌套 dispatch。默认为 `depth = 1`。

**涉及文件**:
- **修改**: `src/dispatcher.ts`（约 30 处修改）
- **依赖**: `src/display.ts`（Layer 1）

**验收标准**:
- [ ] 子 Agent 启动时显示 `├─ 🔹 子Agent: 任务描述`
- [ ] 子 Agent 每轮显示缩进的 `│  [N/30] ⠋ 子Agent思考中`
- [ ] 子 Agent 工具调用显示 `│    ⊜ read`
- [ ] 子 Agent 完成时显示 `✅ 完成 (3轮, 5.2s)`
- [ ] 非 TTY 模式降级为纯文本带时间戳

**工作量**: 2.5h

---

### 3.5 Layer 5: 非 TTY 降级 + 执行指标统计

**目标**:
1. 完善非 TTY 降级策略，确保管道/重定向模式下输出可读
2. 补全 `ExecutionMetrics` 的采集和终端展示

**5a: 非 TTY 降级完善**

当前 `feedback.ts` 在 `!isTTY` 时完全静默（return 不写任何内容），导致管道模式下用户看不到任何进度。需要改为在所有关键节点输出纯文本带时间戳的日志。

**降级策略**:

| 场景 | TTY 模式 | 非 TTY 模式 |
|------|----------|-------------|
| 状态行 | 原地刷新 + spinner | 内容变化时输出 `[HH:MM:SS] [N/60] 操作 (Xs)` |
| 工具结果 | `✓/✗` + 颜色 | `OK/FAIL` + 时间戳 |
| 计划列表 | ANSI 颜色图标 | `[✓]/[✗]/[ ]` 纯文本 |
| 子 Agent 树 | 缩进 + 颜色 | 缩进 + `[子Agent]` 纯文本 |
| 最终结果 | 正常输出 | 正常输出 |

**实现**: 以上降级逻辑已内建在 Layer 1-4 各层的 `milestone()` 调用和 `isTTY` 条件分支中，Layer 5 不再重复设计，而是**审查和补全**: 确保所有展示路径都有非 TTY 分支，移除 `feedback.ts` 中的静默 return。

**`src/feedback.ts` 废弃计划**: 将 `feedback.ts` 标记为 deprecated，新增导入从 `display.ts`。`elapsed()` 函数移动至 `display.ts`。

```typescript
// src/feedback.ts → 缩减为兼容导出
import { milestone, c } from "./display";

/** @deprecated 使用 display.ts 中的函数替代 */
export const feedback = (msg: string) => milestone(msg);
/** @deprecated 使用 display.ts 中的函数替代 */
export const feedbackLine = (msg: string) => milestone(msg);
export { elapsed } from "./display";
```

**5b: ExecutionMetrics 采集与展示**

```typescript
// src/orchestrator.ts —— runReAct 返回前收集指标

import type { ExecutionMetrics } from "./types";

async runReAct(userInput: string): Promise<string> {
  const mainStart = Date.now();
  let totalLlmCalls = 0;
  let totalToolsUsed = 0;

  // ... 现有逻辑 ...

  for (let i = 0; i < MAX_REACT_ITERATIONS; i++) {
    // LLM 调用成功后:
    totalLlmCalls++;

    // 工具调用完成后:
    totalToolsUsed += parsed.length;
  }

  // 指标输出到终端
  const metrics: ExecutionMetrics = {
    llm_calls: totalLlmCalls,
    tools_used: totalToolsUsed,
    duration_ms: Date.now() - mainStart,
  };

  // 任务完成后输出一行统计摘要
  const isTTY = process.stderr.isTTY;
  const durationSec = (metrics.duration_ms / 1000).toFixed(1);
  if (isTTY) {
    process.stderr.write(
      `\n${c.dim}───${c.reset}\n` +
      `${c.bold}📊 执行统计${c.reset}\n` +
      `  LLM 调用: ${metrics.llm_calls} 次\n` +
      `  工具调用: ${metrics.tools_used} 次\n` +
      `  总耗时: ${durationSec}s\n`
    );
  } else {
    milestone(`执行统计: LLM调用=${metrics.llm_calls}, 工具=${metrics.tools_used}, 耗时=${durationSec}s`);
  }

  return result;
}
```

```typescript
// src/dispatcher.ts —— SubAgent.run() 返回前设置 metrics

async run(): Promise<SubAgentResult> {
  const subStart = Date.now();
  let _llmCalls = 0;    // 改为非下划线前缀，用于返回
  let _toolsUsed = 0;

  // ... 现有逻辑 ...

  return {
    status: "completed",
    output: response.content ?? "",
    metrics: {
      llm_calls: _llmCalls,
      tools_used: _toolsUsed,
      duration_ms: Date.now() - subStart,
    },
  };
}
```

**涉及文件**:
- **修改**: `src/feedback.ts`（替换为兼容导出）
- **修改**: `src/orchestrator.ts`（添加指标采集 + 统计输出）
- **修改**: `src/dispatcher.ts`（SubAgent 返回 metrics）
- **依赖**: `src/display.ts`（Layer 1）

**验收标准**:
- [ ] `echo "test" | bun run start` 输出带时间戳的纯文本进度日志（非空）
- [ ] `bun run start "task" > output.txt` 文件中无 ANSI 转义码
- [ ] 主 Agent 完成后终端显示 "📊 执行统计" 摘要
- [ ] `SubAgentResult.metrics` 包含正确的 `llm_calls`、`tools_used`、`duration_ms`
- [ ] `feedback.ts` 的旧导出仍可用（向后兼容），但功能委托给 display.ts

**工作量**: 2h

---

## 4. 涉及文件汇总

| 文件 | 操作 | Layer | 说明 |
|------|------|-------|------|
| `src/display.ts` | **新建** | L1 | 约 120 行，统一终端输出层 |
| `src/orchestrator.ts` | 修改 | L2, L5b | 替换 4 处裸 write → 状态行 + toolResult + 指标采集 |
| `src/plan-manager.ts` | 修改 | L3 | 添加 `renderPlanToTerminal()`，首次加载 + 状态变化渲染 |
| `src/dispatcher.ts` | 修改 | L4, L5b | 子 Agent 树形展示 + SubAgentResult.metrics |
| `src/feedback.ts` | 修改 | L5a | 废弃，改为兼容委托给 display.ts |

以上 5 个文件覆盖了全部展示相关修改。`src/index.ts` 无需修改（其 console.log 调用为 help/chat/result 输出，性质不同）。

---

## 5. 验收标准

### 5.1 功能验收

#### TTY 模式（标准交互终端）

| 编号 | 验收项 | 预期行为 |
|------|--------|----------|
| A1 | Spinner 动画 | 每轮 LLM 调用期间，状态行末尾显示会动的 braille spinner（⠋⠙⠹...） |
| A2 | 步骤进度 | 显示 `[N/60]` 格式的当前轮次/总轮次，颜色为青色 |
| A3 | 思考中状态 | `[N/60] ⠋ 思考中... (1.2s)` 原地刷新，时间递增 |
| A4 | 工具结果 | LLM 返回后用 `✓/✗` 图标 + 工具名称 + 操作摘要 |
| A5 | 工具摘要可读 | read 显示 `读取文件: path/to/file`，write 显示 `写入文件: path/to/file` |
| A6 | 异常处理 | LLM 调用异常显示 `⚠ LLM 调用异常，重试`（黄色） |
| A7 | 完成提示 | 任务完成显示 `✓ 完成 (总耗时 12.4s)`（绿色） |
| A8 | 计划可视化 | 首次检测到 plan.md 时显示完整的计划阶段列表 |
| A9 | 阶段变化 | 阶段切换到 running 时显示 `▶ 阶段名称` |
| A10 | 子 Agent 树 | 子 Agent 启动显示 `├─ 🔹 子Agent: 任务描述`，缩进清晰 |
| A11 | 子 Agent 进度 | 子 Agent 每轮显示 `│  [N/30] ⠋ 子Agent思考中` 原地刷新 |
| A12 | 执行统计 | 任务完成后显示 `📊 执行统计` 摘要（LLM 调用次数、工具调用次数、总耗时） |

#### 非 TTY 模式（管道/重定向）

| 编号 | 验收项 | 预期行为 |
|------|--------|----------|
| B1 | 有输出 | `echo "任务" \| bun run start` 有可读进度输出（不能为空） |
| B2 | 无 ANSI | `bun run start "任务" > output.txt` 文件中不含 `\x1b[` 转义序列 |
| B3 | 时间戳 | 非 TTY 输出每行带 `[HH:MM:SS]` 时间戳 |
| B4 | 完整覆盖 | 计划加载、每轮开始、工具调用、子 Agent、完成统计均有对应行 |

### 5.2 终端截图描述（预期视觉效果）

**截图 1: 主 Agent 运行时状态行**

```
📋 执行计划
  ⬜ 阶段1: 探索代码库
  ▶ 阶段2: 修复拼写错误
  ⬜ 阶段3: 验证修改

[2/60] ⠹ 思考中... (2.1s)
```
- 计划在首次加载时一次性显示
- 第 2 行状态行原地刷新，spinner 帧动画变化，时间递增
- `[2/60]` 青色，`⠹` 白色，`(2.1s)` 暗色

**截图 2: 工具调用结果行**

```
[1/60] ✓ 思考完成 (1.2s)
  ✓ read → 读取文件: README.md (共 42 行)
  ✓ write → 写入文件: plan.md
```
- 绿色 `✓` 表示成功
- 工具名称和操作摘要一目了然

**截图 3: 子 Agent 树形展示**

```
[2/60] ✓ 思考完成 (2.1s)
│
├─ 🔹 子Agent: 修复 README.md 中的拼写错误
│  [1/30] ⠋ 子Agent思考中... (0.8s)
│  [1/30] ✓ grep → 搜索: 找到 3 处拼写错误
│  [2/30] ⠸ 子Agent思考中... (1.3s)
│  [2/30] ✓ edit → 编辑: README.md (L15, L22, L30)
│  ✅ 完成 (2轮, 3.2s)
│
[3/60] ⠙ 思考中... (0.9s)
```
- 紫色 `🔹 子Agent` 标识子 Agent 启动
- 缩进 `│` 表示层级关系
- 子 Agent 完成显示 `✅ 完成`

**截图 4: 执行统计摘要**

```
(最终输出内容)

───
📊 执行统计
  LLM 调用: 5 次
  工具调用: 8 次
  总耗时: 12.4s
```
- 分隔线后显示统计摘要
- 所有数字为实际执行数据

**截图 5: 异常情况**

```
[3/60] ⚠ LLM 调用异常，重试（等待 2s）
[3/60] ⠋ 思考中... (3.5s)
[3/60] ✓ 思考完成 (4.1s)
```
- 黄色 `⚠` 加简短描述
- 暂停后自动恢复

---

## 6. 工作量估计

| Layer | 内容 | 工作量 | 依赖 |
|-------|------|--------|------|
| L1 | ANSI 基础工具包 (`src/display.ts`) | **1.5h** | 无 |
| L2 | 主 Agent 状态行改造 (`orchestrator.ts`) | **2h** | L1 |
| L3 | 计划可视化 (`plan-manager.ts`) | **1.5h** | L1 |
| L4 | 子 Agent 树形展示 (`dispatcher.ts`) | **2.5h** | L1 |
| L5a | 非 TTY 降级完善 (`feedback.ts` + 审查) | **1h** | L1-L4 |
| L5b | ExecutionMetrics 采集与展示 | **1h** | L2, L4 |
| **合计** | | **9.5h** | |

加上测试验证（1h）和边界情况处理（1h），**总工作量约 11.5h**。

### 执行顺序

```
L1 (1.5h)
 ├── L2 (2h)
 ├── L3 (1.5h)
 ├── L4 (2.5h)
 └── L5a (1h) + L5b (1h)  [L2,L4 完成后]
                          └── 测试验证 (1h)
```

L2/L3/L4 可并行开发（依赖均为 L1），L5 需等 L2 和 L4 完成后进行最终审查补全。

### 风险

| 风险 | 概率 | 缓解措施 |
|------|------|----------|
| ANSI 序列在不同终端兼容性不一致 | 低 | 使用最基本的 SGR 子集（颜色 30-37），不使用 256 色/TrueColor/光标定位（除 CR） |
| 非 TTY 模式下输出过多（管道被日志淹没） | 中 | `milestone()` 仅在内容变化时输出；考虑增加 `--quiet` 选项控制日志级别 |
| `\r` 刷新与子 Agent 输出交错 | 低 | 每次输出工具结果行前先 `clearStatusLine()` 清除状态行残留 |
| 现有测试因 `process.stderr.write` 替换而挂掉 | 低 | display.ts 函数签名与原调用保持兼容；测试中使用 `--no-color` 环境变量抑制 ANSI |

---

## 7. 附录: 不在此 Plan 范围内的事项

以下展示相关改进在 Claude Code 中存在，但超出本 plan 范围，留待后续 ISSUE 跟踪：

1. **彩色 diff 显示**: git diff 的 ANSI 高亮渲染（需要解析 unified diff 格式）
2. **Markdown 渲染**: 助手回复中的 Markdown 语法高亮（需要终端 Markdown 渲染库）
3. **自适应列宽**: 根据终端宽度截断长输出
4. **交互式进度条**: 类似 Claude Code 的 `[████░░░░] 60%` 进度条
5. **多级嵌套子 Agent 树**: 当前 dispatch 仅 1 层深度，L4 预留 depth 参数但不实现多级嵌套
6. **国际化 (i18n)**: 中文状态文本 → 英文状态文本的双语支持
