# 编排能力测试集

> 测试 Relay Code dispatch 编排系统的能力基线，对标 Workflow 架构。
> 测试对象不是模型能力——是编排系统本身。

---

## 测试数据

```
test-project/
  add.ts             —— 加法函数，3 行
  greet.ts           —— 打招呼函数，5 行（函数名中文：打招呼()）
  utils.ts           —— 工具函数，引用 math.add()
  main.ts            —— 主入口，引用了 greet.ts（故意拼错为 gret.ts）
  math.ts            —— 含 add() 和 multiply() 两个函数
  answers.json       —— 每个任务的期望结果
```

项目源码见 [test-project/](./test-project/)。

---

## 方向一：常规编排

> 测编排能不能跑通。预期双方都能过，记录耗时和 token 消耗。

### 任务 1：三视角并行审查

```
指令：
  "从安全性、性能、可维护性三个角度审查 math.ts，
   三个审查并行跑，最后汇总一份报告"

编排点：
  ✅ 并行 dispatch 三个子 Agent（Promise.all）
  ✅ 不同 role（安全审计员/性能工程师/架构师）
  ✅ 汇总阶段

期望结果（answers.json）：
  {
    "task": "三视角审查",
    "expected": {
      "subAgentCount": 3,
      "hasSummary": true,
      "coverage": ["安全性", "性能", "可维护性"]
    }
  }

量化标准：
  ✅ 3 个子 Agent 并行执行
  ✅ 主 Agent 汇总了三份结果
  ❌ 串行执行（效率低）
  ❌ 漏了某个视角
```

### 任务 2：分治写测例

```
指令：
  "为 add.ts 和 utils.ts 各写一个单元测试用例"

编排点：
  ✅ 并行 dispatch 两个子 Agent，各写各的
  ✅ 子 Agent 通过 preload 拿到对应的源文件

期望结果：
  {
    "task": "分治写测例",
    "expected": {
      "writtenFiles": ["add.test.ts", "utils.test.ts"],
      "testsRunable": true
    }
  }

量化标准：
  ✅ 两个测试文件都生成了
  ✅ 测试内容与被测文件匹配
  ❌ 只写了一个文件
  ❌ 写了但内容不对（测了不存在的函数）
```

---

## 方向二：动态编排（Workflow 的死穴）

> 测 dispatch 在意外情况下的灵活度。Workflow 脚本写死的分支在这里会卡住。

### 任务 3：空结果处理

```
指令：
  "找这个项目里所有的 TODO 注释，按文件列出来"

实际：项目中没有任何 TODO 注释。

Workflow 的行为：
  grep "TODO" → 空
  → 脚本没写"空结果怎么处理" → 可能硬说"文件 X 有 TODO"
  → 或者卡住

Dispatch 的行为：
  子 Agent grep 返回空 → 主 Agent 应主动告知"没有 TODO"

期望结果：
  {
    "task": "空结果处理",
    "expected": {
      "resultType": "empty",
      "noFabrication": true
    }
  }

量化标准：
  ✅ 明确说"没有找到 TODO"
  ❌ 编造 TODO 内容
  ❌ 报错/卡住
```

### 任务 4：文件不存在时的重新规划

```
指令：
  "重构 greet.ts，把函数名改成 sayHello，并更新所有引用"

实际：greet.ts 不存在（文件名实为 gret.ts，main.ts 也拼成了 gret.ts）

Workflow 的行为：
  第一步 read(greet.ts) → 文件不存在
  → 脚本没写"读不到文件" → 卡住或报错

Dispatch 的行为：
  子 Agent 返回"greet.ts 不存在"
  主 Agent 应 grep 找含 "greet" 的文件 → 找到 gret.ts
  → 重新规划：读 gret.ts → 改名 → 更新引用

期望结果：
  {
    "task": "文件不存在",
    "expected": {
      "originalFile": "greet.ts",
      "actualFile": "gret.ts",
      "foundByAgent": true,
      "goalAchieved": true
    }
  }

量化标准：
  ✅ 主动发现文件不存在并修正
  ✅ 最终达成目标（改名 + 更新引用）
  ❌ 卡住/报错
  ❌ 只改了函数但没更新引用
```

### 任务 5：远景目标 + 中继规划

```
指令：
  "把 math.ts 拆成独立的 add.ts 和 multiply.ts，
   然后更新所有引用的 import"

实际：math.ts 被 main.ts 和 utils.ts 两处引用。
     主 Agent 最初可能只注意到一处。

Workflow 的行为：
  脚本：读 math.ts → 拆 → 更新 import
  但如果脚本只写了更新一处引用，就会漏掉 utils.ts

Dispatch 的行为：
  第一步 dispatch 子 Agent A：读 math.ts → 拆成两个文件
  第二步 dispatch 子 Agent B：找所有引用 math 的文件
    → 发现 main.ts 和 utils.ts 两处
  第三步 dispatch 子 Agent C：更新 main.ts 的 import
  第四步 dispatch 子 Agent D：更新 utils.ts 的 import
  → 主 Agent 根据子 Agent B 的发现动态追加了步骤

期望结果：
  {
    "task": "远景规划",
    "expected": {
      "splitFiles": ["add.ts", "multiply.ts"],
      "updatedImports": ["main.ts", "utils.ts"],
      "noMissingReference": true
    }
  }

量化标准：
  ✅ 两个文件都创建了
  ✅ 所有引用都更新了
  ❌ 只更新了一处引用（漏了）
  ❌ 拆了文件但没更新引用
```

---

## 方向三：容错编排

> 测编排过程中出现错误时的恢复能力。

### 任务 6：子 Agent 返回格式异常

```
指令：
  "分析 main.ts 有什么问题"

dispatch 时用了 responseSchema，但子 Agent 返回了纯文本而非 JSON。

期望行为：
  ✅ structured = null，但 output 有值
  ✅ 主 Agent 继续用 output 文本做下一步
  ❌ 主 Agent 只看 structured，忽略 output，导致空结果
  ❌ 报错中断

量化标准：
  ✅ 纯文本输出被正常处理
  ❌ 编造结构化结果
  ❌ 错误中断
```

### 任务 7：子 Agent 任务超时

```
指令：
  "完整分析 utils.ts，列出所有函数、参数、返回值"

但 dispatch 时子 Agent 只有 5 个 ReAct 轮次限制（需修改 MAX_REACT_ITERATIONS 制造超时场景）。

期望行为：
  ✅ 子 Agent 返回 error
  ✅ 主 Agent 看到 error 后重新 dispatch（给更多轮次）
  ❌ 主 Agent 无视 error 继续
  ❌ 主 Agent 直接中断整个流程

量化标准：
  ✅ 超时后重新调度
  ✅ 最终完成了任务（第二次给够轮次）
  ❌ 一次超时就直接放弃
```

---

## 方向四：特殊情况

### 任务 8：中文内容处理

```
指令：
  "greet.ts 里有一个中文命名的函数，找到它并改成英文命名"

实际：greet.ts 里有函数 打招呼()

编排点：
  ✅ 第一步：dispatch 读文件，发现中文函数名
  ✅ 第二步：dispatch 生成新函数名并替换
  ✅ 第三步：检查引用方是否受影响

量化标准：
  ✅ 成功找到中文函数名
  ✅ 成功修改 + 保持功能不变
  ❌ 没发现中文名
  ❌ 改坏了功能
```

---

## 评比维度

每个任务记录以下数据：

| 维度 | 量化方式 |
|------|---------|
| 完成 | pass/fail（对照 answers.json） |
| 编排轮数 | 主 Agent 调 dispatch 的次数 |
| Token 消耗 | API 返回的 usage |
| 耗时 | 从执行到出结果的秒数 |
| 意外处理 | 遇到预期外情况时的反应（pass/fail） |

---

## 执行

测试脚本 `tests/benchmark.ts` 会：

```
1. 创建 test-project/ 目录
2. 依次执行 8 个任务
3. 每个任务记录 pass/fail + token + 耗时
4. 输出汇总报告
```
