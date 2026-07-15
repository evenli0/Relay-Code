# ISSUE-03 优化计划：grep/bash 工具 Windows 兼容

## 1. 问题描述

### 1.1 现状

`src/tools.ts` 中的 `grepTool` 和 `bashTool` 在 Windows 上完全不可用，原因是在调用 `Bun.spawnSync` 时直接使用了裸可执行文件名，而没有进行平台检测和路径解析。

### 1.2 平台检测结果

| 检测项 | 结果 |
|--------|------|
| `process.platform` | `win32` |
| `grep` 在 PATH 中 | 不可用 |
| `bash` 在 PATH 中 | 不可用 |
| Git Bash 已安装 | 是，位于 `C:\Program Files\Git\` |
| `bash.exe` 绝对路径 | `C:\Program Files\Git\bin\bash.exe` |
| `grep.exe` 绝对路径 | `C:\Program Files\Git\usr\bin\grep.exe` |
| `Bun.spawnSync(["grep", ...])` | 抛出 `Executable not found in $PATH` |
| `Bun.spawnSync(["bash", ...])` | 抛出 `Executable not found in $PATH` |
| `Bun.spawnSync(["C:\\Program Files\\Git\\bin\\bash.exe", ...])` | 成功执行 |

### 1.3 根因

三处代码硬编码了裸可执行文件名，无任何平台检测或路径探测逻辑：

#### 位置 1：`src/tools.ts` grepTool.execute（第 77 行）

```typescript
const proc = Bun.spawnSync(["grep", "-rn", pattern, searchPath]);
```

#### 位置 2：`src/tools.ts` bashTool.execute（第 104 行）

```typescript
const proc = Bun.spawnSync(["bash", "-c", command]);
```

#### 位置 3：`src/tool-executor.ts` executeToolCall（第 67 行）

```typescript
const proc = Bun.spawnSync(["bash", "-c", command], { cwd });
```

三处均：
- 无 `process.platform` 检查
- 无 Git Bash 安装路径探测
- 无 PowerShell fallback
- catch 块仅返回通用错误消息，不尝试替代路径

---

## 2. 影响范围

### 2.1 直接影响

| 工具 | 影响 |
|------|------|
| `grep` | Windows 上在文件中搜索文本的功能完全不可用 |
| `bash` | Windows 上执行 shell 命令的功能完全不可用 |

### 2.2 级联影响

- **Harness / Orchestrator**：任何依赖 `grep` 搜索代码内容、或依赖 `bash` 执行构建/测试/脚本命令的编排流程，在 Windows 上全部失败。
- **CI/CD**：如果 CI 运行在 Windows runner 上，所有涉及这两个工具的测试和流程都会失败。
- **已有测试**：`tests/tools.test.ts` 第 66-96 行的 5 个 grep/bash 测试在 Windows 上全部失败。

### 2.3 受影响文件

| 文件 | 行号 | 改动类型 |
|------|------|----------|
| `src/tools.ts` | 59-113 | 核心修复：grepTool + bashTool |
| `src/tool-executor.ts` | 65-72 | 同步修复：worktree bash 调用 |
| `tests/tools.test.ts` | 63-96 | 测试适配：Windows 兼容断言 |
| `src/tools.ts` | (新增) | 平台检测 + 路径解析工具函数 |

---

## 3. Windows 兼容方案

### 3.1 总体策略

在 `src/tools.ts` 中增加一组纯函数作为平台适配层，然后重构 `grepTool` 和 `bashTool` 使用该适配层。`tool-executor.ts` 中的重复 bash 调用也复用同一适配函数。

**设计原则：**
1. 优先探测 Git Bash（Windows 上最可靠的 Unix 工具链来源）
2. 路径探测仅探测标准安装位置，不做全盘扫描
3. 提供 PowerShell fallback 用于 `grep`（`Select-String`）
4. 提供 PowerShell fallback 用于 `bash`（`powershell.exe -Command`，用于简单命令）
5. macOS/Linux 行为不变，保持向后兼容
6. 所有改动在 `catch` 块中完成，不改变正常执行路径

### 3.2 新增平台适配函数

在 `src/tools.ts` 顶部（`const path = ...` 之后、工具定义之前）新增：

```typescript
import { platform } from "node:os";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

// ---- 平台适配 ----

/** Git Bash 标准安装路径列表（Windows） */
const GIT_BASH_CANDIDATES = [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    `${process.env.LOCALAPPDATA ?? ""}\\Programs\\Git\\bin\\bash.exe`,
    `${process.env.ProgramFiles ?? "C:\\Program Files"}\\Git\\bin\\bash.exe`,
];

/** Git 自带的 grep 路径列表（Windows） */
const GIT_GREP_CANDIDATES = [
    "C:\\Program Files\\Git\\usr\\bin\\grep.exe",
    "C:\\Program Files (x86)\\Git\\usr\\bin\\grep.exe",
    `${process.env.LOCALAPPDATA ?? ""}\\Programs\\Git\\usr\\bin\\grep.exe`,
];

/** 在 Windows 上解析 bash 可执行文件路径 */
function resolveBash(): string | null {
    if (platform() !== "win32") return "bash"; // Unix: 直接用 PATH 中的 bash
    // Windows: 探测 Git Bash
    const fromEnv = process.env.BASH_PATH;
    if (fromEnv && existsSync(fromEnv)) return fromEnv;
    for (const p of GIT_BASH_CANDIDATES) {
        if (existsSync(p)) return p;
    }
    return null; // 找不到，调用方负责 fallback
}

/** 在 Windows 上解析 grep 可执行文件路径 */
function resolveGrep(): string | null {
    if (platform() !== "win32") return "grep"; // Unix: 直接用 PATH 中的 grep
    // Windows: 探测 Git 自带的 grep
    const fromEnv = process.env.GREP_PATH;
    if (fromEnv && existsSync(fromEnv)) return fromEnv;
    for (const p of GIT_GREP_CANDIDATES) {
        if (existsSync(p)) return p;
    }
    return null; // 找不到，调用方负责 fallback
}
```

### 3.3 重构 grepTool（第 59-85 行）

```typescript
async execute(args) {
    const pattern = String(args.pattern ?? "");
    const searchPath = args.path ? String(args.path) : ".";
    try {
        const grepExe = resolveGrep();
        if (grepExe) {
            const proc = Bun.spawnSync([grepExe, "-rn", pattern, searchPath]);
            if (proc.exitCode === 0) return proc.stdout.toString();
            if (proc.exitCode === 1) return "未找到匹配";
            return `grep 错误：${proc.stderr.toString()}`;
        }
        // Windows fallback: 使用 PowerShell Select-String
        if (platform() === "win32") {
            const psCmd =
                `Select-String -Path "${searchPath}\\*" -Pattern "${pattern.replace(/"/g, '`"')}" -Recurse | ForEach-Object { $_.Filename + ":" + $_.LineNumber + ":" + $_.Line }`;
            const proc = Bun.spawnSync([
                "powershell.exe", "-NoProfile", "-Command", psCmd,
            ]);
            if (proc.exitCode === 0) {
                const out = proc.stdout.toString().trim();
                return out || "未找到匹配";
            }
            return `grep (PowerShell) 错误：${proc.stderr.toString()}`;
        }
        return `grep 执行失败（当前环境不支持 grep 命令）`;
    } catch {
        return `grep 执行失败（当前环境可能不支持 grep 命令）`;
    }
},
```

### 3.4 重构 bashTool（第 87-113 行）

```typescript
async execute(args) {
    const command = String(args.command ?? "");
    try {
        const bashExe = resolveBash();
        if (bashExe) {
            const proc = Bun.spawnSync([bashExe, "-c", command]);
            return (
                proc.stdout.toString() +
                (proc.stderr.toString() ? `\nstderr:\n${proc.stderr.toString()}` : "")
            );
        }
        // Windows fallback: 使用 PowerShell 执行简单命令
        // 注意：PowerShell 不是 bash，语法不同，仅对 echo/简单命令有效
        if (platform() === "win32") {
            const proc = Bun.spawnSync([
                "powershell.exe", "-NoProfile", "-Command", command,
            ]);
            return (
                proc.stdout.toString() +
                (proc.stderr.toString() ? `\nstderr:\n${proc.stderr.toString()}` : "")
            );
        }
        return `bash 执行失败（当前环境不支持 bash）`;
    } catch {
        return `bash 执行失败（当前环境可能不支持 bash）`;
    }
},
```

### 3.5 修复 tool-executor.ts 重复代码（第 65-72 行）

当前代码有两处 bash spawn，存在代码重复。修改 `tool-executor.ts` 第 65-72 行：

```typescript
// bash 需要特殊处理：在 worktree 目录执行
if (toolName === "bash" && cwd) {
    const command = String(resolvedArgs.command ?? "");
    const bashExe = resolveBash(); // 从 tools.ts 导出
    if (bashExe) {
        const proc = Bun.spawnSync([bashExe, "-c", command], { cwd });
        return (
            proc.stdout.toString() +
            (proc.stderr.toString() ? `\nstderr:\n${proc.stderr.toString()}` : "")
        );
    }
    // Windows: 注入 cwd 作为 PowerShell 工作目录
    if (platform() === "win32") {
        const proc = Bun.spawnSync(
            ["powershell.exe", "-NoProfile", "-Command", command],
            { cwd },
        );
        return (
            proc.stdout.toString() +
            (proc.stderr.toString() ? `\nstderr:\n${proc.stderr.toString()}` : "")
        );
    }
    return "bash 执行失败（当前环境不支持 bash）";
}
```

这要求从 `tools.ts` 导出 `resolveBash` 和 `resolveGrep`：

```typescript
export { resolveBash, resolveGrep };
```

### 3.6 测试文件适配（`tests/tools.test.ts`）

现有测试中的 `executeTool("bash", { command: "echo hello world" })` 在 Windows 上将通过 PowerShell fallback 执行，`echo` 在 PowerShell 中也是有效命令（`echo` 是 `Write-Output` 的别名），所以输出略有不同但应能通过。

需要增加 Windows 专项测试：

```typescript
import { platform } from "node:os";

// grepTool Windows 专项
test.skipIf(platform() !== "win32")(
    "grepTool: Windows Git Bash grep 正常执行",
    async () => {
        await Bun.write("win-search.txt", "hello\nworld\nhello world\n");
        const result = await executeTool("grep", { pattern: "hello" });
        expect(result).toContain("hello");
    },
);

test.skipIf(platform() !== "win32")(
    "grepTool: Windows PowerShell Select-String fallback",
    async () => {
        await Bun.write("win-ps-search.txt", "apple\nbanana\ncherry\n");
        const result = await executeTool("grep", { pattern: "banana" });
        expect(result).toContain("banana");
    },
);

// bashTool Windows 专项
test.skipIf(platform() !== "win32")(
    "bashTool: Windows Git Bash 执行命令",
    async () => {
        const result = await executeTool("bash", { command: "echo hello-win" });
        expect(result).toContain("hello-win");
    },
);

test.skipIf(platform() !== "win32")(
    "bashTool: Windows PowerShell fallback 执行简单命令",
    async () => {
        const result = await executeTool("bash", {
            command: "Write-Output hello-ps",
        });
        expect(result).toContain("hello-ps");
    },
);
```

### 3.7 方案决策树

```
Bun.spawnSync(["grep", ...]) / Bun.spawnSync(["bash", ...])
    │
    ├─ platform !== "win32" ──→ 直接使用裸命令名（macOS/Linux，行为不变）
    │
    └─ platform === "win32"
         │
         ├─ resolveGrep() / resolveBash() 找到 Git Bash ──→ 使用绝对路径调用
         │
         └─ 未找到 Git Bash
              ├─ grepTool ──→ powershell.exe Select-String fallback
              └─ bashTool ──→ powershell.exe -Command fallback
```

---

## 4. 验收标准

### 4.1 功能验收

| 编号 | 验收项 | 预期结果 |
|------|--------|----------|
| AC-01 | Windows 上有 Git Bash 时 `grep` 正常执行 | 返回匹配行，exitCode 0 |
| AC-02 | Windows 上有 Git Bash 时 `bash` 正常执行 | 返回命令输出，exitCode 0 |
| AC-03 | Windows 上无 Git Bash 时 `grep` 走 PowerShell fallback | 通过 `Select-String` 返回匹配结果 |
| AC-04 | Windows 上无 Git Bash 时 `bash` 走 PowerShell fallback | 通过 `powershell.exe -Command` 执行并返回结果 |
| AC-05 | macOS/Linux 行为不变 | `grep` 和 `bash` 直接使用 PATH 中的命令 |
| AC-06 | worktree cwd 模式下的 bash 在 Windows 上正常 | `tool-executor.ts` 中指定 cwd 的 bash 调用也可用 |
| AC-07 | `BASH_PATH` / `GREP_PATH` 环境变量覆盖 | 手动设置的环境变量路径优先于自动探测 |

### 4.2 测试验收

| 编号 | 验收项 | 预期结果 |
|------|--------|----------|
| AC-08 | 现有 5 个 grep/bash 测试在 Windows 上通过 | `bun test` 全部绿色 |
| AC-09 | 新增 Windows 专项测试通过 | `test.skipIf(platform() !== "win32")` 全部通过 |
| AC-10 | macOS/Linux CI 测试不受影响 | 无回归 |
| AC-11 | `resolveBash()` / `resolveGrep()` 单元测试 | 覆盖：找到、找不到、环境变量优先 |

### 4.3 验证步骤

```powershell
# 步骤 1：确认环境
bun -e "console.log(process.platform)"  # 应输出 win32

# 步骤 2：运行所有测试
bun test tests/tools.test.ts

# 步骤 3：手动验证 grep
bun -e "
const { resolveGrep } = require('./src/tools');
console.log('grep path:', resolveGrep());
"

# 步骤 4：手动验证 bash
bun -e "
const { resolveBash } = require('./src/tools');
console.log('bash path:', resolveBash());
"

# 步骤 5：端到端验证 grep
bun -e "
const { executeTool } = require('./src/tools');
(async () => {
  const result = await executeTool('grep', { pattern: 'function', path: 'src' });
  console.log('grep result (first 200 chars):', result.slice(0, 200));
})();
"

# 步骤 6：端到端验证 bash
bun -e "
const { executeTool } = require('./src/tools');
(async () => {
  const result = await executeTool('bash', { command: 'echo ISSUE-03 verified' });
  console.log('bash result:', result);
})();
"
```

---

## 5. 工作量估计

| 任务 | 预计工时 | 说明 |
|------|----------|------|
| 新增平台适配函数 | 0.5h | `resolveBash`、`resolveGrep` + 导出 |
| 重构 grepTool | 0.5h | 注入 resolveGrep + PowerShell fallback |
| 重构 bashTool | 0.3h | 注入 resolveBash + PowerShell fallback |
| 修复 tool-executor.ts | 0.3h | worktree cwd 模式的 bash 调用同步修复 |
| 测试适配 | 0.5h | 现有测试验证 + Windows 专项测试 |
| 验证与调试 | 0.4h | Windows 实机验证、边界情况 |
| **合计** | **2.5h** | 约半天工作量 |

风险低，改动集中在 3 个文件，改动量约 80-100 行代码（含注释和测试），不涉及架构变更。

---

## 附录 A：可执行文件探测路径说明

| 可执行文件 | 候选路径 | 来源 |
|-----------|----------|------|
| `bash.exe` | `C:\Program Files\Git\bin\bash.exe` | Git for Windows 默认安装 |
| `bash.exe` | `C:\Program Files (x86)\Git\bin\bash.exe` | Git for Windows 32-bit |
| `bash.exe` | `%LOCALAPPDATA%\Programs\Git\bin\bash.exe` | Git for Windows 用户级安装 |
| `bash.exe` | `%ProgramFiles%\Git\bin\bash.exe` | 通用 Program Files 路径 |
| `grep.exe` | `C:\Program Files\Git\usr\bin\grep.exe` | Git for Windows 自带 MSYS2 grep |
| `grep.exe` | `C:\Program Files (x86)\Git\usr\bin\grep.exe` | Git for Windows 32-bit |
| `grep.exe` | `%LOCALAPPDATA%\Programs\Git\usr\bin\grep.exe` | Git for Windows 用户级安装 |

环境变量覆盖：`BASH_PATH` 和 `GREP_PATH` 允许用户手动指定非标准安装路径。

## 附录 B：PowerShell fallback 限制说明

PowerShell fallback 不是完全替代品，有以下限制：

1. **`grep` → `Select-String`**：
   - `Select-String` 支持 `-Pattern`（正则）、`-Recurse`（递归）、`-Path`，基本覆盖 grep 核心用法
   - 不支持的 grep 选项：`-A/-B/-C` 上下文行、`-o` only-matching、`-v` 反转匹配
   - 当前工具调用只用了 `-rn`，`Select-String` 完全覆盖

2. **`bash` → `powershell.exe -Command`**：
   - 支持简单命令（`echo`、`dir`、`type` 等）
   - **不支持** bash 特有语法（pipe `|` 语义不同、`&&`/`||` 不存在于 PowerShell 5.1、变量 `$VAR` 语法不同）
   - 复杂 shell 脚本需要 Git Bash 或 WSL

如果两者都不可用（既无 Git Bash，也无 PowerShell），工具返回原始错误消息。这种情况仅出现在 Windows Nano Server 或极度精简的 Windows 容器中。
