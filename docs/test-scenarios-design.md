# Relay Code 动态编排能力测试场景设计

> 文档目的：设计 3 个可执行测试场景，验证 Relay Code 相比 Workflow 在动态编排方面的核心优势。
>
> 每个场景有明确的输入、预期行为链、成功标准，以及 Relay Code vs Workflow 的行为对比。

---

## 场景 1：文件不存在自适应

### 概述

验证 Relay Code 在子 Agent 发现文件不存在后，主 Agent 能修正 plan、搜索替代路径、继续执行的能力。

### 详细设计

#### 测试输入

用户指令：

```
分析并修复项目中引用了不存在文件的问题
```

#### 准备工作

在 test-project 下创建一个含"脏引用"的项目：

```
test-project/
├── index.js          # import { foo } from './utils'  → utils.js 不存在
├── config.json       # { "extends": "./base.json" }  → base.json 不存在
├── components/
│   └── header.js     # import { bar } from './footer'  → footer.js 不存在
└── package.json      # 虚构项目元信息
```

#### Relay Code 预期行为链

```
Step 1: 主 Agent 读取当前目录结构
  → 工具调用: bash("ls -R"), read("plan.md"不存在→忽略)
  → 发现：plan.md 为空，需要自主规划
  → 写入 plan.md，规划 Phase 1 扫描脏引用

Step 2: 主 Agent 写 plan 并 dispatch 子 Agent
  → write("plan.md", "# 分析脏引用... Phase 1 扫描")
  → dispatch({
       prompt: { task: "扫描 test-project 下所有引用了不存在文件的 import/require/extends" },
       responseSchema: { type: "object", properties: { 
         brokenRefs: { type: "array" } 
       }}
     })

Step 3: 子 Agent 尝试读文件
  → read("test-project/index.js") → 成功
  → read("test-project/utils.js") → 返回 "错误：文件 test-project/utils.js 不存在"
  → 子 Agent 标记为脏引用

Step 4: 子 Agent 返回结构化结果
  → { brokenRefs: [
       { file: "index.js", ref: "./utils", line: 1, type: "import" },
       { file: "config.json", ref: "./base.json", type: "extends" },
       { file: "components/header.js", ref: "./footer", type: "import" }
     ]}

Step 5: 主 Agent 检查结果 → 发现 3 个脏引用
  → 思考：要修复这些引用，需要找到替代文件或创建缺失文件
  → 检查 keyFindings 判断合理性

Step 6: 主 Agent 修正 plan，增加 Phase 2
  → 读取 plan.md
  → write("plan.md", "Plan: # 分析脏引用\n## Phase 1 ✅ 已完成\n## Phase 2 修复脏引用\n  - 搜索替代文件\n  - 或创建缺失文件")

Step 7: 主 Agent dispatch 修复子 Agent
  → dispatch({
       prompt: {
         task: "修复脏引用。对每个缺失的引用文件，先在项目中搜索是否存在，不存在则创建"
       },
       responseSchema: { type: "object", properties: { fixes: { type: "array" } }}
     })

Step 8: 验证修复结果
  → 再次运行 grep 或 import 检查确认无脏引用
  → 输出总结报告
```

#### Workflow 行为对比

```
Step 1: 用户准备 workflow.js 脚本
  → const workflow = {
       phases: [
         { name: "scan", script: "扫描脏引用并修复" },
         { name: "fix", script: "修复所有脏引用" }
       ]
     }
  → 脚本硬编码了文件路径列表和修复策略

Step 2: 运行 workflow
  → utils.js 不存在 → 脚本直接报错
  → 无法根据实际发现的脏引用数量动态调整修复策略
  → 脚本中预先定义的 "修复所有" 逻辑可能覆盖不需要修复的文件

故障模式：
  - 如果脚本硬编码了 ["utils.js", "base.json", "footer.js"] 作为待修复文件
  - 但实际发现 footer.js 其实存在（在另一个目录下）
  - 脚本无法利用这个发现，仍然按原计划执行
```

#### 成功标准

| 标准 | Relay Code | Workflow |
|------|-----------|----------|
| 发现文件不存在 | 子 Agent 返回错误信息 | 脚本中断报错 |
| 搜索替代路径 | 主 Agent 更新 plan，子 Agent 执行搜索 | 需要预先在脚本中编写搜索逻辑 |
| 动态调整修复策略 | 基于实际发现（3 个引用）精确匹配 | 按预定义列表机械执行 |
| 流程完成 | 所有脏引用被识别并修复 | 遇到第一个错误即中断 |
| 闭环 | 主 Agent 验证最终结果 | 无回环验证机制 |

---

## 场景 2：多方案对比后选择最优

### 概述

验证 Relay Code 能先并行产出 2 个方案，主 Agent 对比分析后选择最优方案执行——Workflow 无法做到"先出方案再决策"。

### 详细设计

#### 测试输入

用户指令：

```
重构 auth 模块，要求先出 2 个技术方案，对比后选最优的执行
```

#### 准备工作

```
test-project/
├── src/
│   └── auth/
│       ├── index.ts         # 现有认证入口，使用 JWT + 密码哈希
│       ├── middleware.ts     # 认证中间件
│       ├── routes.ts        # 登录/注册路由
│       └── utils.ts         # 辅助函数（token 生成、密码验证）
├── package.json             # 含依赖列表（jsonwebtoken, bcrypt 等）
```

#### Relay Code 预期行为链

```
Step 1: 主 Agent 读取 auth 模块
  → read("src/auth/index.ts"), read("src/auth/middleware.ts")
  → 理解现有架构

Step 2: 主 Agent 写 plan，规划两阶段
  → write("plan.md", [
       "## Phase 1 方案设计（并行）",
       "  - 子Agent A：设计基于 JWT + Refresh Token 的方案",
       "  - 子Agent B：设计基于 Session + Redis 的方案",
       "## Phase 2 分析对比并执行",
       "  - 主 Agent 对比两个方案",
       "  - 选择最优方案并执行重构",
     ].join("\n"))

Step 3: Phase 1 — 并行 dispatch 2 个子 Agent
  → dispatch({
       prompt: { 
         role: "架构师 A",
         task: "设计 JWT + Refresh Token 重构方案，输出详细的实现步骤和文件修改清单",
         instructions: "你是一名资深后端架构师。考虑安全性、性能、可维护性。"  
       },
       responseSchema: {
         type: "object",
         properties: {
           plan: { type: "string" },
           filesToModify: { type: "array" },
           pros: { type: "array" },
           cons: { type: "array" },
           effort: { type: "string" }
         }
       }
     })
  → dispatch({
       prompt: {
         role: "架构师 B",
         task: "设计 Session + Redis 重构方案，输出详细的实现步骤和文件修改清单",
         instructions: "你是一名资深后端架构师。考虑可扩展性、团队维护成本。"  
       },
       responseSchema: {
         type: "object",
         properties: {
           plan: { type: "string" },
           filesToModify: { type: "array" },
           pros: { type: "array" },
           cons: { type: "array" },
           effort: { type: "string" }
         }
       }
     })

  → 两个子 Agent 并行执行（可能使用 worktree 隔离）
  → 同时返回结构化结果

Step 4: 主 Agent 分析两个方案
  → 比较 pros/cons/effort
  → 决策：选择方案 A（JWT + Refresh Token）
  → 理由：无需额外 Redis 基础设施，团队更熟悉 JWT

Step 5: 主 Agent 更新 plan，进入 Phase 2
  → write("plan.md", "Phase 1 ✅ 方案对比完成 → 选定方案 A\nPhase 2 执行重构")

Step 6: dispatch 执行子 Agent
  → dispatch({
       prompt: { task: "基于选定的 JWT + Refresh Token 方案执行重构" },
       responseSchema: { type: "object", properties: { changes: { type: "array" } }}
     })

Step 7: 验证重构结果
  → 检查文件是否按计划修改
  → 输出决策理由和变更摘要
```

#### Workflow 行为对比

```
Workflow 的局限：
  - Workflow 脚本是确定的 DAG，无法在 Phase 1 后插入"分析决策"步骤
  - 需要预定义分支逻辑，但分支条件必须提前编码
  - 无法让 LLM 对比两个方案的"语境理解"差异

可悲的 Workflow 实现尝试：
  const workflow = {
    phases: [
      { name: "design-A", script: "设计方案 A" },
      { name: "design-B", script: "设计方案 B" },
      // 问题：这里无法插入 LLM 决策节点
      // 只能硬编码选择逻辑（比如始终选 A）
      { name: "compare", script: "对比方案" },
      // 脚本里写对比逻辑？但脚本的 LLM Agent 不知道方案的完整语境
    ]
  }

本质差异：
  - Workflow：设计阶段和执行阶段在脚本创建时就锁死了
  - Relay Code：主 Agent 按顺序发出 dispatch，看到结果后当场决定下一步
  - Relay Code 的 plan 是"活"的，Workflow 的脚本是"死"的
```

#### 成功标准

| 标准 | Relay Code | Workflow |
|------|-----------|----------|
| 并行产出方案 | dispatch 2 个子 Agent 同时运行 | 需要手动写并行逻辑 |
| LLM 分析对比 | 主 Agent 直接读取两个 JSON 方案对比 | 脚本无法调用 LLM 做"判断" |
| 基于语境选最优 | 主 Agent 理解项目上下文后决策 | 只能基于预定义条件分支 |
| 动态执行选定方案 | dispatch 第三个子 Agent 按选中方案执行 | 需要预先写两套执行脚本 |
| 方案切换 | 主 Agent 改 plan 即可切换 | 改写整个 workflow.js |

---

## 场景 3：任务范围中途扩大

### 概述

验证 Relay Code 在发现任务规模远超预期时，能自动分批次处理、更新 plan、逐步推进——Workflow 遇到大规模任务会因固定超时或资源限制而整体失败。

### 详细设计

#### 测试输入

用户指令：

```
修复这个项目的 lint 错误
```

#### 准备工作

创建一个有大量 lint 错误但分布在完全不相关的目录中的项目：

```
test-project/
├── src/
│   ├── core/          # 3 个 lint 错误
│   ├── api/           # 4 个 lint 错误
│   └── utils/         # 2 个 lint 错误
├── tests/
│   ├── unit/          # 2 个 lint 错误
│   └── integration/   # 3 个 lint 错误
├── scripts/           # 2 个 lint 错误
└── docs/              # 1 个 lint 错误（MD 文件格式问题）
    总计：17 个 lint 错误分布在 7 个目录
```

#### Relay Code 预期行为链

```
Step 1: 主 Agent 执行 lint 检查
  → bash("npx eslint . --format json") 
  → 发现 17 个 lint 错误，分布在 7 个目录

Step 2: 主 Agent 评估任务规模
  → 判断：17 个错误，子 Agent 一轮处理不完
  → 决定分批处理

Step 3: 写入分批 plan
  → write("plan.md", [
       "# Plan: 分批修复 Lint 错误",
       "一共发现 17 个 Lint 错误，分 3 批修复：",
       "## Phase 1 — Batch A: src/ (9 个错误)",
       "## Phase 2 — Batch B: tests/ (5 个错误)",
       "## Phase 3 — Batch C: scripts/ + docs/ (3 个错误)",
       "",
       "执行规则：每批完成后验证，验证通过才进入下一批",
     ].join("\n"))

Step 4: Phase 1 — 处理 src/ 目录
  → dispatch({
       prompt: { task: "修复 src/core, src/api, src/utils 目录中的 9 个 lint 错误" },
       responseSchema: { type: "object", properties: { 
         fixes: { type: "array" }, 
         remainingAfterFix: { type: "number" } 
       }}
     })
  → 子 Agent 修复 9 个错误
  → 返回结果

Step 5: 验证 Phase 1 结果
  → bash("npx eslint src/ --format json")
  → 确认 src/ 下无残留 lint 错误
  → write("plan.md") 标记 Phase 1 ✅

Step 6: Phase 2 — 处理 tests/ 目录
  → 同 Phase 1 流程
  → 子 Agent 修复 5 个错误
  → 验证通过

Step 7: Phase 3 — 处理 scripts/ + docs/
  → 但发现 docs/ 的 lint 错误是 MD 文件格式问题
  → 子 Agent 不具备 MD 修复能力 → 返回 escalation

Step 8: 主 Agent 处理异常
  → 收到 escalation 信号
  → 更新 plan 拆分 Phase 3：
    → Phase 3a: 修复 scripts/（子 Agent 通用模式）
    → Phase 3b: 手动修复 docs/（提示用户手动操作）
  → 继续执行 Phase 3a

Step 9: 完成并报告
  → 输出：成功修复 16/17，1 个需要手动处理
```

#### Workflow 行为对比

```
Workflow 脚本设计困境：

选项 A：一次处理所有（最可能的做法）
  const workflow = {
    phases: [
      { name: "lint", script: "跑 eslint 获取错误列表" },
      { name: "fix", script: "修复所有 lint 错误" },
      { name: "verify", script: "验证修复结果" }
    ]
  }
  问题：17 个错误在单个子 Agent 中处理，可能超时或上下文溢出

选项 B：预分片
  const workflow = {
    phases: [
      { name: "lint", script: "跑 eslint 获取错误列表" },
      { name: "fix-src", script: "修复 src/ 的 lint 错误" },
      { name: "fix-tests", script: "修复 tests/ 的 lint 错误" },
      { name: "fix-others", script: "修复 scripts/ docs/ 的 lint 错误" },
      { name: "verify", script: "验证修复结果" }
    ]
  }
  问题：
  - 分片数量必须提前确定
  - 如果 lint 实际只发现 3 个错误，fix-src + fix-tests + fix-others 仍然逐一运行
  - 如果 lint 发现 50 个错误（10 个目录），预定义的 3 个 fix 阶段不够用
  - 无法动态调整分批策略

选项 C：用脚本动态分片（理论上可行但极为复杂）
  需要写 JS 逻辑动态生成 phase，但仍受限于：
  - 脚本中的 LLM Agent 调用缺少结构化返回
  - 无法处理 "子 Agent 能力不足" 的异常
  - 无法让用户介入（docs/ 的 MD 问题）
```

#### 成功标准

| 标准 | Relay Code | Workflow |
|------|-----------|----------|
| 评估任务规模 | 主 Agent 看到 17 个错误后自主决定分批 | 脚本无法感知规模，硬编码所有阶段 |
| 动态分片策略 | 按目录分 3 批，每批合理大小 | 要么全量（超时），要么预分片（僵化） |
| 分批验证 | 每批完成后自动验证，通过才进下一批 | 需手动编写验证步骤 |
| 异常处理 | 子 Agent 能力不足 → escalation → 主 Agent 拆解任务 | 子 Agent 失败 → 整个 workflow 中断 |
| 部分完成 | 16/17 成功，1 个提示用户 | 要么全成功，要么全失败 |
| 跨阶段依赖性 | 天然支持（Phase 1 → 验证 → Phase 2） | 需要提前设计 DAG |

---

## 三场景汇总对比

| 维度 | 场景 1：文件不存在 | 场景 2：方案对比 | 场景 3：范围扩大 |
|------|------------------|----------------|----------------|
| **核心能力** | 障碍自适应 | 多路并行 + LLM 决策 | 动态分片 + 异常拆解 |
| **主 Agent 决策点** | 收到脏引用列表后决定修复策略 | 收到两个方案后决定选哪个 | 收到 17 个错误后决定分 3 批 |
| **子 Agent 数量** | 2（扫描 + 修复） | 3（方案A + 方案B + 执行） | 3-4（每批一个） |
| **plan 更新次数** | 2 次（初始 + 修正） | 2 次（初始 + 选定方案） | 3+ 次（初始 + 每批标记 + 异常拆解） |
| **Workflow 能否做到** | 不能（硬编码路径） | 不能（无法 LLM 决策） | 勉强（预分片但僵化） |
| **Relay Code 优势本质** | 子 Agent 返回结构化发现，主 Agent 据此调整路线 | 多子 Agent 并行输出方案，主 Agent 做 LLM 判断 | 主 Agent 持续检查进度，动态调整粒度 |
