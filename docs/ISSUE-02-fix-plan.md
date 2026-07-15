# ISSUE-02 修复计划: 管道模式检测逻辑 Bug

## 1. 问题描述

### 1.1 现象

当用户通过管道向 relay-code 传入任务时（例如 `echo "分析 src/ 目录" | bun run src/index.ts`），程序显示帮助信息并退出，而非进入管道模式读取 stdin 并执行任务。

### 1.2 根因: 控制流错误导致管道模式代码不可达

`src/index.ts` 第 54-88 行 `main()` 函数存在控制流顺序错误:

```typescript
// 当前控制流 (src/index.ts 第 54-88 行)
async function main() {
  const arg = process.argv[2];                     // L54

  if (!arg || arg === "--help") {                   // L56
    showHelp();                                     // L57
    process.exit(0);                                // L58  ← 进程在此终止
  }                                                 // L59

  if (arg === "--version") { process.exit(0); }     // L61-64
  if (arg === "--chat")    { await chatMode(); return; } // L66-69

  // 管道模式: 从 stdin 读取
  if (!process.stdin.isTTY && !arg) {               // L72  ← 不可达!
    const stdin = await Bun.stdin.text();
    if (stdin.trim()) {
      const orchestrator = new Orchestrator();
      await saveDialogue("user", stdin.trim());
      const result = await orchestrator.runReAct(stdin.trim());
      console.log(result);
      return;
    }
  }

  // 正常模式
  const orchestrator = new Orchestrator();
  await saveDialogue("user", arg);
  const result = await orchestrator.runReAct(arg);
  console.log(result);
}
```

**关键问题**: 当管道输入时 (`echo "test" | bun run src/index.ts`):
- `process.argv[2]` 为 `undefined`（没有 CLI 参数）
- `!arg` 为 `true` → 进入第 56 行分支
- 第 57 行 `showHelp()` 输出帮助信息
- 第 58 行 `process.exit(0)` **立即终止进程**
- 第 72 行的管道模式检查 `if (!process.stdin.isTTY && !arg)` **永远不会执行**

第 72-81 行是**死代码**。

### 1.3 三步验证结果

| 步骤 | 方法 | 结果 |
|------|------|------|
| 步骤 1: 控制流分析 | 静态分析 `src/index.ts` | 确认 L72 在 L56-58 之后不可达 |
| 步骤 2: 模拟测试 | 运行 `test-project/test_pipe_bug.ts` | 四种 Case 全部与预期一致: 管道模式被 help 分支拦截 |
| 步骤 3: 实际管道测试 | `echo "test task" \| bun run src/index.ts` | 实际输出 help 文本，验证死代码确认 |

**结论: ISSUE-02 CONFIRMED**

---

## 2. 影响范围

### 2.1 功能影响

| 影响项 | 描述 |
|--------|------|
| 管道模式 | **完全不可用**。所有 `echo "task" \| bun run start` 形式的调用均显示 help 并退出 |
| 正常传参模式 | 不受影响。`bun run start "task"` 走 L83-87 正常模式 |
| `--help` | 不受影响。行为正确 |
| `--version` | 不受影响。行为正确 |
| `--chat` | 不受影响。行为正确 |
| CI/CD 集成 | 受影响。管道模式是脚本化/CI 集成的核心入口 |

### 2.2 代码影响

| 文件 | 修改类型 | 行数 |
|------|----------|------|
| `src/index.ts` | 重构 `main()` 控制流 | ~15 行变更 |

仅涉及单一文件。

---

## 3. 修复方案

### 3.1 策略: 管道模式检查前置

将管道模式检测移到所有 CLI 参数解析之前。核心思想:

1. **先检测管道输入** — 如果 stdin 不是 TTY（即管道/重定向），先读取 stdin 内容
2. **再解析 CLI 标志** — 管道内容作为 task 或与 CLI 参数合并
3. **最后判断无任务** — 没有任何输入时才显示 help

### 3.2 代码改动 (Before / After)

**Before (当前代码):**

```typescript
async function main() {
  const arg = process.argv[2];

  if (!arg || arg === "--help") {
    showHelp();
    process.exit(0);
  }

  if (arg === "--version") {
    console.log(`Relay Code v${VERSION}`);
    process.exit(0);
  }

  if (arg === "--chat") {
    await chatMode();
    return;
  }

  // Pipe mode: read from stdin if available
  if (!process.stdin.isTTY && !arg) {
    const stdin = await Bun.stdin.text();
    if (stdin.trim()) {
      const orchestrator = new Orchestrator();
      await saveDialogue("user", stdin.trim());
      const result = await orchestrator.runReAct(stdin.trim());
      console.log(result);
      return;
    }
  }

  // Normal mode
  const orchestrator = new Orchestrator();
  await saveDialogue("user", arg);
  const result = await orchestrator.runReAct(arg);
  console.log(result);
}
```

**After (修复后代码):**

```typescript
async function main() {
  let arg: string | undefined = process.argv[2];

  // 1. 先检测管道/重定向模式 —— 在任何参数解析之前
  //    修复 ISSUE-02: 原来的顺序导致管道模式永远不可达
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    const piped = Buffer.concat(chunks).toString("utf-8").trim();
    if (piped) {
      // 管道有内容时，作为 task 参数（如果没有 CLI 参数）
      // 如果有 CLI 参数（如 --chat），CLI 参数优先
      arg = arg ?? piped;
    }
  }

  // 2. CLI 标志处理
  if (!arg || arg === "--help") {
    showHelp();
    process.exit(0);
  }

  if (arg === "--version") {
    console.log(`Relay Code v${VERSION}`);
    process.exit(0);
  }

  if (arg === "--chat") {
    await chatMode();
    return;
  }

  // 3. 正常模式（arg 来自 CLI 参数或管道输入）
  const orchestrator = new Orchestrator();
  await saveDialogue("user", arg);
  const result = await orchestrator.runReAct(arg);
  console.log(result);
}
```

### 3.3 关键设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| stdin 读取方式 | `for await` 流式读取 + `Buffer.concat` | `Bun.stdin.text()` 在某些管道场景下行为不稳定；流式读取更可靠 |
| 管道与 CLI 参数优先级 | CLI 参数优先 (`arg = arg ?? piped`) | `echo "x" \| bun run start --help` 应显示帮助而非执行管道内容 |
| 管道为空时的行为 | 走到 `!arg` → `showHelp()` | 与无参启动行为一致，符合直觉 |
| 是否保留 `Bun.stdin.text()` | 替换为 Node.js 原生流式读取 | 跨平台兼容性更好，且避免 Bun 特定 API 的边缘问题 |

---

## 4. 验收标准

### 4.1 功能验收

| # | 测试场景 | 命令 | 预期结果 |
|---|----------|------|----------|
| AC-1 | 管道模式: 有内容 | `echo "分析 src/ 目录" \| bun run src/index.ts` | 进入管道模式，将 "分析 src/ 目录" 作为 task 执行，输出执行结果 |
| AC-2 | 管道模式: 空内容 | `echo "" \| bun run src/index.ts` | 显示 help 信息并退出（无有效输入） |
| AC-3 | 正常传参 | `bun run src/index.ts "分析 src/"` | 行为不变，正常执行 task |
| AC-4 | --help | `bun run src/index.ts --help` | 显示 help 信息并退出 |
| AC-5 | --version | `bun run src/index.ts --version` | 显示版本号并退出 |
| AC-6 | --chat | `bun run src/index.ts --chat` | 进入交互聊天模式 |
| AC-7 | 管道 + CLI 标志 | `echo "test" \| bun run src/index.ts --help` | CLI 标志优先，显示 help（不执行管道内容） |
| AC-8 | 管道 + 无 CLI 参数 | `cat task.txt \| bun run src/index.ts` | 读取文件内容作为 task 执行 |
| AC-9 | 多行管道输入 | `printf "line1\nline2" \| bun run src/index.ts` | 正确读取多行内容作为 task |

### 4.2 回归验收

| # | 检查项 | 预期结果 |
|---|--------|----------|
| R-1 | 现有测试全部通过 | `bun test` 无回归失败 |
| R-2 | 类型检查通过 | `bun run typecheck` 无新增错误 |
| R-3 | 无控制流警告 | Linter 不报告 unreachable code |

---

## 5. 工作量估计

| 项目 | 估计人时 | 说明 |
|------|----------|------|
| 代码修改 | 0.2h | 重构 `main()` 函数控制流，约 15 行变更 |
| 编写/更新测试 | 0.2h | 添加 2 个管道模式测试用例 |
| 验收测试 | 0.1h | 执行 AC-1 ~ AC-9 全部验收场景 |
| **合计** | **0.5h** | 单一文件、单一函数重构 |

### 风险等级

**低风险**。变更范围仅限于 `src/index.ts` 的 `main()` 函数控制流重排，不涉及业务逻辑变更，不影响 LLM 调用、工具执行、orchestrator 等核心模块。

---

## 6. 附加说明

### 6.1 与其他 Issue 的关系

- **ISSUE-01 (缺少 .env.example)**: 无关，独立修复
- **ISSUE-03 (Windows grep/bash 兼容)**: 无关，独立修复
- **ISSUE-04 (dispatcher 空结果检测)**: 无关，独立修复

本 ISSUE 可独立修复，无前置依赖。

### 6.2 测试用例建议

```typescript
// test-project/pipe_mode.test.ts（建议添加的测试）
import { describe, test, expect } from "bun:test";

describe("管道模式", () => {
  test("管道输入应执行 task 而非显示 help", async () => {
    const proc = Bun.spawnSync(
      ["bun", "run", "src/index.ts"],
      { stdin: Buffer.from("分析 src/"), stdout: "pipe", stderr: "pipe" }
    );
    // 不应输出 help 信息
    expect(proc.stdout.toString()).not.toContain("Usage:");
  });

  test("空管道输入应显示 help", async () => {
    const proc = Bun.spawnSync(
      ["bun", "run", "src/index.ts"],
      { stdin: Buffer.from(""), stdout: "pipe", stderr: "pipe" }
    );
    expect(proc.stdout.toString()).toContain("Usage:");
  });
});
```

---

**文档版本**: v1.0
**生成日期**: 2026-07-16
**关联 Issue**: ISSUE-02
**目标分支**: main
