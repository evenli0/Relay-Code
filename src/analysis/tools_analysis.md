# src/tools.ts 全面分析报告

## 1. 概述：文件功能与定位

`src/tools.ts` 是 relay-code 系统中的**工具注册与执行核心模块**。它定义了 Agent（包括编排 Agent 和子 Agent）可以调用的所有内置工具（read / write / grep / bash / dispatch），并提供了统一的工具查找与执行入口 `executeTool()`。

文件的核心定位如下：

- **工具工厂**：将每个工具的定义（JSON Schema，供 LLM 识别）与实现（`execute` 函数）封装在一起，形成 `ToolDefinition` 对象。
- **跨平台适配层**：通过 `resolveShell()` 和 `resolveGrep()` 处理 Windows 与 Unix 系系统的差异，保证工具在两种环境下都能工作。
- **执行调度器**：`executeTool()` 根据工具名称查找并调用对应的 `execute` 函数，是 Agent 调用工具的唯一入口。

---

## 2. 工具清单与用途

| 工具名 | 类型 | 用途 | 参数 |
|--------|------|------|------|
| **read** | function | 读取本地文件内容 | `path`（必填）：文件路径 |
| **write** | function | 写入内容到本地文件，自动创建目录 | `path`（必填）：文件路径；`content`（必填）：写入内容 |
| **grep** | function | 在文件或目录中递归搜索文本 | `pattern`（必填）：搜索模式；`path`（可选）：搜索路径，默认 `.` |
| **bash** | function | 执行 shell 命令（带 30 秒超时） | `command`（必填）：要执行的命令 |
| **dispatch** | function | 工作流编排：派生子 Agent 并行执行子任务 | `task`（必填）：子任务描述；`role`（可选）：角色；`format`（可选）：格式说明；`exploratory`（可选）：探索模式标志 |

> 注：dispatch 工具只有 schema 定义，没有 `execute` 函数，由编排 Agent 在逻辑层面处理。

---

## 3. 关键设计分析：resolveShell / resolveGrep 的跨平台处理

### 3.1 resolveShell()

```ts
export function resolveShell(): { bin: string; flag: string }
```

**设计策略**：

1. **非 Windows** → 直接返回 `{ bin: "bash", flag: "-c" }`，使用系统默认 bash。
2. **Windows** → 优先检测 Git Bash 路径（64 位和 32 位），若存在则使用 Git Bash；否则回退到 `cmd /c`。

**设计亮点**：

- 采用"优先使用 POSIX 兼容 shell"的策略。Git Bash 支持 `-c` 标志和 Unix 风格的命令语法，比 `cmd` 更接近 Linux 环境，减少了命令兼容性问题。
- 使用 `existsSync()` 做存在性检查，性能开销小且同步返回，适合初始化阶段使用。

**潜在问题**：

- 未检测 Git Bash 的 `bash.exe` 是否真的可执行（权限问题、损坏等），`existsSync` 只检查文件存在。
- 未提供环境变量覆盖机制：用户无法通过 `GIT_BASH_PATH` 等环境变量指定自定义路径。
- 缺少 WSL（Windows Subsystem for Linux）的支持路径，例如 `wsl bash -c`。

### 3.2 resolveGrep()

```ts
function resolveGrep(): { bin: string; args: string[] } | null
```

**设计策略**：

1. **非 Windows** → 返回 `null`，即无需特殊处理，直接使用系统自带的 `grep`。
2. **Windows** → 检测 `C:\Program Files\Git\usr\bin\grep.exe`，若存在则返回该路径；否则返回 `null`（此时 grep 工具会降级到 PowerShell 方案）。

**设计亮点**：

- 优美的"降级"设计：Windows 上如果 Git Bash 的 grep 不可用，工具会回退到 `powershell Select-String`，尽量保证功能可用。
- 返回 `null` 表示"无需特殊处理"，与"需要特殊处理"的路径方案分离，逻辑清晰。

**潜在问题**：

- 只检查一个固定的 64 位路径，忽略了 32 位 Git 安装情况（`Program Files (x86)`）。
- 同上，没有环境变量覆盖机制。
- PowerShell 降级方案中的正则语法与 grep 不完全兼容，可能导致搜索结果差异。

---

## 4. executeTool 执行机制分析

```ts
export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<string>
```

**执行流程**：

1. **名称查找**：在 `ALL_TOOLS` 数组中通过 `t.function.name === toolName` 匹配工具。
2. **存在性检查**：若未找到工具 → 返回错误字符串 `"错误：未知工具"`；若找到但无 `execute` 方法 → 返回 `"错误：工具无法执行"`。
3. **执行调用**：调用 `tool.execute(args)` 并返回结果字符串。

**设计特点**：

- **统一返回类型**：所有 execute 函数都返回 `Promise<string>`，保证 Agent 处理结果时接口一致。
- **容错性**：每个工具的 execute 内部都有 `try/catch`，将异常转化为友好的错误提示字符串，不会抛出未捕获异常。
- **字符串化结果**：无论是成功还是失败，都以字符串形式返回，简化了 Agent 对结果的解析。

**潜在问题**：

- `executeTool` 本身的参数没有做类型校验（比如 `args` 中的字段类型检查），完全依赖工具内部自行处理。
- 没有工具调用日志/埋点，不利于调试和监控。
- 没有并发控制或调用频率限制。

---

## 5. 代码亮点与潜在问题

### 亮点

1. **清晰的工具定义结构**：使用 `ToolDefinition` 接口将 JSON Schema（给 LLM 看）与执行函数（给代码执行）绑定在同一对象中，结构清晰、易于扩展。

2. **跨平台兼容性设计**：`resolveShell` / `resolveGrep` 的"检测-降级"策略，让同一个工具代码在 Windows 和 Unix 下都能工作。

3. **Bun 原生 API 的合理使用**：
   - `Bun.file(path)` + async `file.exists()` / `file.text()` 用于文件读取，比 `fs.promises` 更简洁。
   - `Bun.write()` 用于文件写入。
   - `Bun.spawnSync()` 用于执行外部命令。

4. **write 工具的自动创建目录**：在写入文件前自动创建目录，提升了可用性。

5. **grep 的三级降级策略**：原生 grep → Git Bash grep → PowerShell Select-String，覆盖了 Windows 上的各种环境。

6. **错误处理统一**：使用 `unwrapError()` 统一处理各种异常类型，避免 `catch (e: any)` 的脆弱写法。

7. **bash 工具的超时保护**：30 秒超时防止命令永久阻塞。

### 潜在问题

1. **dispatch 工具缺乏 execute 实现**：dispatch 只有 schema 定义但没有 execute 函数。如果 `executeTool` 被调用时传入 "dispatch" 名称，会返回 `"错误：工具 dispatch 无法执行"`，这对调用方不透明。

2. **grep 工具的 PowerShell 降级命令脆弱**：PowerShell 命令中直接拼接 `pattern` 和 `searchPath`，如果 pattern 包含单引号或特殊字符会导致命令注入或语法错误。应该使用参数化查询或转义。

3. **缺少文件路径大小写敏感性的考虑**：Windows 文件路径大小写不敏感，但代码中未做任何处理，可能导致用户传入大小写不一致的路径时找不到文件。

4. **bash 工具命令注入风险**：command 参数直接拼接进 shell 命令，存在命令注入风险。虽然这是"给 Agent 用的工具"场景下有意为之，但如果未来暴露给外部用户输入则需警惕。

5. **硬编码路径**：Git Bash 和 grep 的路径都是硬编码的，缺乏灵活性和可配置性。

6. **无并发控制**：多个 Agent 同时使用 write 工具写同一文件可能产生竞争条件，目前没有加锁机制。

7. **grep 工具的 `isWindows` 分支与 Unix 分支代码重复**：两段逻辑几乎相同，可以通过提取公共函数减少重复。

---

## 6. 改进建议

### 短期（易于实施）

1. **提取 grep 公共逻辑**：将 Unix 和 Windows 分支中共用的 exitCode 处理逻辑提取为辅助函数，减少代码重复。

2. **PowerShell 命令参数转义**：对 grep PowerShell 降级方案中的 `pattern` 和 `searchPath` 进行转义处理，防止特殊字符导致命令失败。

3. **添加 env 变量覆盖**：
   ```ts
   const gitBashEnv = process.env.GIT_BASH_PATH;
   const gitBashPaths = gitBashEnv 
     ? [gitBashEnv]
     : ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files (x86)\\Git\\bin\\bash.exe"];
   ```

4. **grep 的 Git Bash 路径增加 32 位支持**：在 `resolveGrep` 中添加 `Program Files (x86)` 路径。

### 中期（需要更多设计）

5. **为 dispatch 工具添加 stub execute 函数**：即使 dispatch 由编排 Agent 处理，也可以在 execute 中返回清晰的提示信息，而不是冰冷的"无法执行"。

6. **添加工具调用日志/埋点**：在 `executeTool` 中添加 `console.debug` 或集成日志框架，便于调试和监控 Agent 行为。

7. **增加路径规范化处理**：在 read/write 工具中添加 `path.normalize()` 调用，处理路径分隔符不一致的问题。

8. **实现文件锁机制**：为 write 工具添加基于文件路径的互斥锁（如 `async-mutex`），避免并发写冲突。

### 长期（架构层面）

9. **WSL 支持**：在 `resolveShell` 中增加对 WSL 的探测，允许使用 `wsl bash -c`。

10. **工具执行超时参数化**：将 bash 工具的 30 秒超时提取为可配置常量，甚至允许每个工具定义自己的超时。

11. **工具权限/沙箱**：如果未来需要隔离 Agent 权限，可以为每个工具添加 allow/deny 列表（如允许读哪些目录、禁止写哪些文件）。

12. **异步 spawn 替代 sync**：对于长时间运行的命令，考虑使用 `Bun.spawn`（异步）替代 `Bun.spawnSync`，并支持流式输出。

---

## 总结

`src/tools.ts` 是一个设计精巧、跨平台兼容性优秀的工具注册与执行模块。它通过统一的 `ToolDefinition` 接口将工具 schema 与实现绑定，利用 `resolveShell` / `resolveGrep` 优雅地处理了 Windows 与 Unix 的差异，并通过 `executeTool` 提供了简洁的执行入口。代码中使用了 Bun 的原生 API，错误处理统一。主要改进空间在于：减少代码重复、增强 PowerShell 降级的安全性、增加可配置性和日志能力。
