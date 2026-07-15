# ISSUE-04: SubAgent 连续空结果检测失效 Bug 修复计划

## 1. 问题描述

### 1.1 现象

子 Agent（SubAgent）在收到连续空工具调用结果时，应提前终止执行。但实际运行时，连续空结果检测逻辑完全失效，子 Agent 会跑满 `MAX_REACT_ITERATIONS`（60 轮），造成不必要的 LLM 调用开销和延迟。

### 1.2 根因：变量作用域错误

**文件**: `src/dispatcher.ts`

计数器 `emptyResultRounds` 声明在 for 循环体内部（第 175 行），每次迭代都会重新初始化为 0。

```typescript
// 第 102 行：for 循环开始
for (let i = 0; i < Math.min(iterLimit, MAX_REACT_ITERATIONS); i++) {
    // ... 中间逻辑 ...

    // 第 175 行：变量声明在循环体内 — 每次迭代重置为 0
    let emptyResultRounds = 0;  // <-- BUG: 应移到循环外部

    // ...

    // 第 183-189 行：检测逻辑永远无法触发
    const allEmpty = results.every((r) => !r || r.trim().length === 0);
    if (allEmpty && (!response.content || response.content.trim().length === 0)) {
        emptyResultRounds++;           // 自增到 1
        if (emptyResultRounds >= 2) {  // 永远为 false：从未超过 1
            return { status: "error", output: "..." };
        }
    } else {
        emptyResultRounds = 0;
    }
    // 下一次循环回到第 175 行：emptyResultRounds 重新赋值为 0
}
```

### 1.3 作用域分析

| 变量 | 当前作用域 | 应有作用域 | 后果 |
|------|-----------|-----------|------|
| `emptyResultRounds` | 循环体内（每次迭代重新声明） | 循环体外（跨迭代保持） | 第 182-197 行检测逻辑形同虚设 |

单个变量的声明位置错误导致约 15 行检测代码完全失效。

### 1.4 实测验证

```
场景1: 连续空结果（全空）
  Buggy 版本: [BUGGY] 跑满 10 轮（bug 行为 — 检测失效）
  Fixed 版本: [FIXED] 第 2 轮提前终止（正常行为）

场景2: 混合结果（空-空-非空-空-空）
  Buggy 版本: [BUGGY-MIXED] 跑满 10 轮（bug 行为）
  Fixed 版本: [FIXED-MIXED] 第 2 轮提前终止（正常行为）
```

---

## 2. 影响范围

### 2.1 直接影响

- **功能**: 子 Agent 连续空结果提前终止功能完全不可用
- **性能**: 每次触发本应提前终止的场景，多浪费约 58 轮 LLM 调用（60 - 2）
- **成本**: 每轮 LLM 调用约消耗数千 tokens，在多子 Agent 并行场景下浪费显著
- **延迟**: 跑满 60 轮相比提前终止（2-3 轮），延迟增加约 20 倍

### 2.2 影响文件

| 文件 | 影响类型 |
|------|---------|
| `src/dispatcher.ts` (第 175 行) | 需要修改（1 行移动） |

### 2.3 风险评估

- **风险等级**: 低
- 修复仅涉及 1 行代码位置移动，不改变任何逻辑
- 其他计数器（`_llmCalls`、`_toolsUsed`）作用域正确，不受影响
- 不存在破坏其他功能的可能

---

## 3. 修复方案

### 3.1 修改内容

将 `let emptyResultRounds = 0;` 从第 175 行（for 循环体内）移动到第 101 行之前（for 循环体外），使其跨迭代保留计数值。

### 3.2 Before / After

**Before** (src/dispatcher.ts):

```typescript
 95  let _llmCalls = 0;
 96  let _toolsUsed = 0;
 97  const availableTools = ALL_TOOLS.filter((t) =>
 98      this.allowedTools.includes(t.function.name),
 99  );
100
101  const iterLimit = this.maxRounds ?? 30;
102  for (let i = 0; i < Math.min(iterLimit, MAX_REACT_ITERATIONS); i++) {
...
174
175      let emptyResultRounds = 0;       // BUG: 每次迭代重置
176      const results = await Promise.all(
177          parsed.map(({ tc, args }) =>
178              this.executor.executeToolCall(tc.function.name, args, this.cwd),
179          ),
180      );
181
182      // 空结果检测：全部为空时计数
183      const allEmpty = results.every((r) => !r || r.trim().length === 0);
184      if (
185          allEmpty &&
186          (!response.content || response.content.trim().length === 0)
187      ) {
188          emptyResultRounds++;
189          if (emptyResultRounds >= 2) {  // 永远为 false
190              return {
191                  status: "error",
192                  output: "子Agent 连续 2 轮返回空结果，提前终止",
193              };
194          }
195      } else {
196          emptyResultRounds = 0;
197      }
```

**After** (src/dispatcher.ts):

```typescript
 95  let _llmCalls = 0;
 96  let _toolsUsed = 0;
 97  const availableTools = ALL_TOOLS.filter((t) =>
 98      this.allowedTools.includes(t.function.name),
 99  );
100
101  const iterLimit = this.maxRounds ?? 30;
     let emptyResultRounds = 0;          // FIX: 移到循环外部，跨迭代保留
102  for (let i = 0; i < Math.min(iterLimit, MAX_REACT_ITERATIONS); i++) {
...
174
175                                        // 原 let emptyResultRounds = 0; 已移除
176      const results = await Promise.all(
177          parsed.map(({ tc, args }) =>
178              this.executor.executeToolCall(tc.function.name, args, this.cwd),
179          ),
180      );
181
182      // 空结果检测：全部为空时计数
183      const allEmpty = results.every((r) => !r || r.trim().length === 0);
184      if (
185          allEmpty &&
186          (!response.content || response.content.trim().length === 0)
187      ) {
188          emptyResultRounds++;
189          if (emptyResultRounds >= 2) {  // 正常工作
190              return {
191                  status: "error",
192                  output: "子Agent 连续 2 轮返回空结果，提前终止",
193              };
194          }
195      } else {
196          emptyResultRounds = 0;
197      }
```

### 3.3 修改总结

| 操作 | 位置 | 内容 |
|------|------|------|
| 新增 | 第 101-102 行之间 | `let emptyResultRounds = 0;` |
| 删除 | 第 175 行 | `let emptyResultRounds = 0;` |

净变动：1 行移动，0 行新增逻辑。

---

## 4. 验收标准

### 4.1 功能验证

| 验收项 | 验证方法 | 期望结果 |
|--------|---------|---------|
| AC-1: 连续 2 轮全空终止 | 构造子 Agent 连续返回空工具调用结果 | 第 2 轮空结果后以 error 状态提前终止 |
| AC-2: 非空结果后重置计数 | 空-空-非空-空-空 序列 | 检测在非空轮正确重置，后续连续 2 空再次触发终止 |
| AC-3: 单次空不误终止 | 仅 1 轮空结果后返回正常结果 | 不提前终止，正常继续执行 |
| AC-4: 无空结果正常执行 | 全部轮次均有非空工具调用结果 | 正常执行完毕，不触发空结果检测 |
| AC-5: 仅 content 非空 | 工具结果为空但 LLM 返回了 content | 不触发空结果检测（content 非空视为有产出） |

### 4.2 回归验证

- 现有测试套件全部通过
- 非空结果正常流程不受影响
- 其他提前终止条件（超时、LLM 报错）仍正常工作

---

## 5. 工作量估计

| 阶段 | 内容 | 预估时间 |
|------|------|---------|
| 代码修改 | 移动 1 行代码 | 1 分钟 |
| 单元测试 | 编写/补充空结果场景测试用例 | 15 分钟 |
| 回归测试 | 运行全量测试 | 5 分钟 |
| 代码审查 | 自查 + diff 确认 | 2 分钟 |
| **合计** | | **~25 分钟** |

## 6. 关联信息

- **关联 Issue**: ISSUE-04
- **严重程度**: 中（功能完全失效但非安全/数据损坏类 bug）
- **引入版本**: 未知（推测自空结果检测功能最初实现时即存在）
- **发现方式**: 代码审查 + 实测验证
