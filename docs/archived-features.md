# 已归档功能 / 延后设计

> 记录曾实现或详细设计过、但为保持最小框架而延后的功能。
> 代码在 git 历史中可回溯，此处仅作索引和设计说明。

---

## 权限系统（Harness）

**文件：** `src/harness.ts` — `registerAgent()` / `permissions` Map / `executeToolCall` 权限拦截

**设计意图：** 子 Agent 只能跑指定的工具白名单，主 Agent 有全部权限。

**延后原因：** 最小框架不需要。所有工具对主 Agent 开放，子 Agent 的权限通过在 dispatch 时传 `allowed_tools` 控制即可（LLM 可能不听话，但实验阶段可以接受）。

**恢复条件：** 需要多用户隔离或沙箱执行时恢复。

---

## 过程记录（ProcessStep）

**文件：** `src/harness.ts` — SubAgent 的 `processSteps[]` 收集 + 返回到 `SubAgentResult.process`

**设计意图：** 记录子 Agent 每一步的 tool_call / tool_result / final，让主 Agent 能看到执行过程。

**延后原因：** 最小框架不需要。子 Agent 只返回 `output` + 可选的 `structured`。过程记录约占 50% 的代码量但核心价值不大（实验 H4 已验证）。

**恢复条件：** 需要审计/调试模式时恢复，作为可选功能。

---

## 对话落盘（memory.ts）

**文件：** `src/memory.ts`

**设计意图：** 每轮对话自动写入 `memory/对话_{date}.jsonl`，用于观察 Agent 行为和回溯。

**当前状态：** ⚠️ **保留基础调用**（`saveDialogue` 在 index.ts 中保留），但 `listMemoryFiles` / `readMemoryFile` / 资源清单组装已移入归档。

**说明：** 保留落盘是因为可以在没调试工具的情况下，通过原始对话数据观察 Agent 发生了什么。这是调试手段，不是产品功能。

---

## 资源清单 + 缓存定价

**文件：** `src/index.ts` — `listMemoryFiles()` → `Resource[]` 组装
`src/prompts.ts` — 缓存状态、定价表

**设计意图：** 让主 Agent 知道"我的上下文多大、哪些文件已缓存、dispatch 多少钱"，基于成本做决策。

**延后原因：** 北极星改为能力而非省钱。缓存工程优化不创新，不投入。

**恢复条件：** 如果未来需要成本感知，从 git 历史恢复。

---

## 实验结论（prompts）

**文件：** `src/prompts.ts` — 三段实验结论

**设计意图：** 让主 Agent 知道"三份文件筛更好、过程审查比结论更准确、精准上下文比全量好"。

**延后原因：** 实验是在 Workflow 架构下做的，与当前的单 Agent + dispatch 架构不完全一致。结论可作为人工参考，不应写死到 prompt 里。

**恢复条件：** 在最小框架上重跑验证，确认结论仍然成立时恢复。

---

## relay / compact 工具

**文件：** 从未实现，仅在 prompt 中有描述

**设计意图：** relay 跨轮存经验，compact 放弃缓存换轻上下文。

**延后原因：** 北极星是能力不是自进化。大厂没做明白的研究课题。

**恢复条件：** 等能力基线跑通了再说。

---

## 经济定价模型

**文件：** `src/types.ts` — `Resource.pricePer1K` / `cached`
`src/prompts.ts` — 定价描述

**设计意图：** 让主 Agent 做 dispatch vs 自读的成本对比。

**延后原因：** 同资源清单。当前上下文小，定价信息没有决策价值。

**恢复条件：** 上下文真正大到需要决策时恢复。

---

## 旧类型

**文件：** `src/types.ts`

| 类型 | 用途 | 状态 |
|------|------|------|
| `DispatchOpts` | 最初设计的 dispatch 参数 | 已删除，被 `DispatchConfig` 替代 |
| `AgentResult` | 旧的执行结果格式 | 已删除，被 `SubAgentResult` 替代 |
| `AgentRecord` | Agent 注册记录 | 已删除，不再追踪 |
| `Resource` | 资源清单条目 | 已删除，定价信息延后 |
| `ORCHESTRATOR_PERMISSIONS` | 权限配置 | 已删除，权限系统延后 |
