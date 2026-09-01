# 通用服务框架设计（Framework Design v2）

> 状态：设计 v2.1 · 2026-08-01（v2 随 VISION v2 重写；v2.1 补充呈现层架构、集群 App 加载链路）
> 定位：VISION 的机制层落到具体系统设计，回答"这个系统怎么设计"。
> 关联：VISION.md（为什么）、ROADMAP.md（做什么）、本文件（怎么做）。
> 核心变化（vs v1）：框架承诺收窄为四件事（协议/生命周期/编排/观测）；NotificationPolicy 升级为**控制流层（Flow）**；服务契约增加 execution/skills/工具模型；新增观测与维护（建造者控制台）。

---

## 0. 设计总览

### 0.1 集群分层

```
┌──────────────── 呈现层（多前端 · 核心无头） ──────────────────┐
│  Web 主界面（控制台） · CLI 调试通道 ·（未来）桌面/移动          │
├──────────────── 控制流层（Flow · 用户编程） ──────────────────┤
│  if / loop / switch / pipe / fan-out+merge / timer          │
│  操控节点的输出与行为 · 门控 = 用户规则 + LLM 兜底              │
├──────────────── 节点群（异构） ──────────────────────────────┤
│  每个节点 = 一个挂载进程（services/<id>/entry.ts）             │
│  prompt / model / tools / execution / skills 各不相同        │
├──────────────── 框架机制（我们做的） ─────────────────────────┤
│  协议（唯一共性）· 生命周期（Supervisor）· 编排（Flow 引擎）     │
│  · 观测（StateStore + 控制台 + 审计）                         │
└────────────────────────────────────────────────────────────┘
```

### 0.2 四条铁律

1. **协议是唯一共性，其余全部异构**——框架不假设节点的内部结构（可以是 ReAct 循环、定时批处理、检测循环、外部 MCP 进程），只承诺统一的指令/事件通道；
2. **框架承诺四件事**：协议、生命周期、编排、观测。其余（prompt/model/tools/execution/skills/业务逻辑）全是节点的配置；
3. **调度中枢是纯代码**——LLM 只在需要推理的节点被调用（主 agent 对话、门控兜底、关联精判），不参与每条事件处理；
4. **一切行为可回溯到用户设计**——控制流由用户建立，事件全量审计落盘，框架没有"自发的魔法行为"；
5. **核心无头（headless）**——呈现层是核心的客户端，不是核心的一部分；Web 主界面、CLI 调试通道通过同一组 API/事件消费核心，未来可加桌面/移动端。

---

## 1. 统一事件协议（唯一共性）

现状问题：三个词表（ActorInput/ActorOutput、SinkEvent、AgentEvent）互不相通。统一为一个协议，服务契约里声明的事件类型是唯一事实源。

### 上行（节点 → 主进程）

```ts
type EventLevel = "trace" | "silent" | "info" | "notify" | "critical";

type ServiceEvent =
  | { kind: "ready" }
  | { kind: "heartbeat"; ts: number }
  | { kind: "state"; updates: Record<string, unknown> }        // 结构化状态增量合并
  | { kind: "event"; type: string; level: EventLevel;
      payload: unknown; correlationId?: string; ts: number }
  | { kind: "progress"; taskId?: string; round: number; action: string; summary: string }
  | { kind: "result"; taskId: string; status: "completed" | "error"; output: string }
  | { kind: "reply"; requestId: string; content: string }
  | { kind: "request"; requestId: string; to: string; content: string }; // 节点→节点（经主进程路由）
```

### 下行（主进程 → 节点）

```ts
type ServiceCommand =
  | { kind: "task"; taskId: string; content: string }
  | { kind: "ask"; requestId: string; content: string; context?: unknown }
  | { kind: "configure"; tools?: string[]; systemPrompt?: string }
  | { kind: "event"; type: string; payload: unknown; correlationId?: string }  // 路由进来的事件
  | { kind: "schedule"; spec: ScheduleSpec }
  | { kind: "shutdown"; reason: string };
```

### 事件分级（门控的地基）

| level | 处理（EventBus） |
|---|---|
| `trace` | 落盘审计日志 |
| `silent` | 落盘 + 状态摘要计数（"今天 142 次无发现"） |
| `info` | 落盘 + 更新状态模型 + 进摘要队列 |
| `notify` | 落盘 + 进入门控决策 |
| `critical` | 落盘 + 立即推送 |

**关键决策**：`state` 通道与 `event` 通道分离——状态是"现在是什么"（结构化、可查询、供推理），事件是"发生了什么"（流水、供审计与门控）。这是全局状态模型与事件流的边界。

---

## 2. 服务契约（节点的自我声明）

服务 = 一个目录工件。三种来源（用户定义 / 主 agent 生成 / 生态安装）都产出同一格式。

```
services/
└── teacher-ai-agent/
    ├── service.json      # 契约（唯一事实源，变更 = 升级版本）
    ├── entry.ts          # 入口（bun run services/<id>/entry.ts）
    ├── lib/              # 节点私有代码
    └── data/             # 节点私有状态（框架不碰）
```

```ts
interface ServiceContract {
  id: string;                        // 全局唯一，目录名一致
  version: string;
  name: string;
  description: string;
  archetype: "pusher" | "watcher" | "interactive" | "hybrid";
  execution: "react" | "cron" | "watch" | "external";  // harness 异构声明
  entry: string;                     // 相对入口文件
  prompt?: string;                   // 节点系统提示词（可省略，entry 自带）
  model?: string;                    // API 模型（节点级，异构模型）
  tools: string[];                   // 工具模型：框架工具 + 挂载的 MCP/外部能力
  skills?: string[];                 // 技能包（能力包，如 Claude skills）
  capabilities: string[];            // 能力声明（主 agent 发现节点用）
  emits: string[];                   // 能发出的事件类型（上行校验）
  consumes: string[];                // 能接收的事件类型（路由依据）
  stateSchema: Record<string, unknown>;  // JSON Schema，state 通道校验
  configSchema: Record<string, unknown>; // 配置项（启动时注入）
  schedule?: ScheduleSpec;           // pusher 的默认节奏
  permissions: {                     // 权限声明（ToolExecutor 强制）
    fs?: ("read" | "write" | "exec")[];
    net?: string[];                  // 允许的域名/URL 前缀
    tools?: string[];                // 允许的工具名
  };
  notify: {
    defaultLevel: EventLevel;        // 未显式标级的事件按此处理
    rules?: { event: string; level: EventLevel }[];  // 事件类型 → 级别覆盖
  };
}
```

**关键决策**：
- **工具模型是节点的**：`tools` 不是"从框架工具表里勾选"，而是"这个 agent 的专属工具组合"——可以是框架原子工具（适配层写入）、挂载的 MCP、外部能力。编程节点挂 shell，视频节点挂多模态工具，互不相同（agent 即服务）；
- **`execution` 声明 harness 异构**：react（ReAct 循环）/ cron（定时批处理）/ watch（检测循环）/ external（外部进程对接）。框架按声明驱动节点；
- 契约校验用 JSON Schema（`stateSchema`/`configSchema` 复用），`emits`/`consumes` 静态检查；
- 热加载：主进程监听 `services/` 目录变化 → 重新校验 → 升级受影响节点（版本化）；
- `capabilities` 是主 agent 发现能力的入口——"集群里有哪些服务能用"由契约回答。

---

## 3. 运行时与生命周期（Supervisor）

现状 `actor-handle.ts` 只有 spawn / readLoop / shutdown，进程退出只打日志。

```
Supervisor（主进程）
├─ spawn(contract)      — Bun.spawn("bun run services/<id>/entry.ts")，stdin/stdout pipe
│                         复用 actor-handle 的 pending-promise 通道模式
├─ heartbeat 检测       — 60s 无 heartbeat → 判僵死 → kill → 重启
├─ 崩溃重启             — 非 0 退出 → 指数退避 1s/2s/4s/.../300s；连续 5 次失败 → 状态=error + 通知
├─ 优雅关停             — shutdown → 5s 超时强杀（复用现有逻辑）
├─ 启动恢复             — 主进程启动时按 services/ 契约批量拉起（常驻=配置项，可关）
└─ 健康报告             — 每节点 { status, startedAt, heartbeatAt, exitCount, lastError } 进 StateStore
```

**关键决策**：节点进程是"被管理的"，不是"自管理的"——节点的代码只负责业务逻辑，常驻、重启、健康是 Supervisor 的事。节点自己永远不需要知道自己在被守护。

---

## 4. 控制流层（Flow）——v2 核心升级

取代 v1 的 NotificationPolicy：**门控只是控制流的一个原语**，整套协作模式是用户可编程的控制流。

### 4.1 原语

| 原语 | 编程对应 | 作用 |
|---|---|---|
| `if` | 门控 | 条件满足才执行动作（含对节点输出的过滤/改写） |
| `loop` | 循环 | 定期重试 / 持续执行（监控型的 while true） |
| `switch` | 分派 | 事件类型 → 不同处理（notify / digest / 转验证） |
| `pipe` | 顺序 | 节点接力（监控 → 验证 → 通知） |
| `fan-out` / `merge` | 并行聚合 | 多路结果汇总（多源信息合并） |
| `timer` | 节奏 | 时间轴驱动（每 6h / cron） |

### 4.2 Flow 描述（声明式，用户书写）

```
flow "套利监控":
  on monitor.event(type=opportunity):
    if payload.confidence >= 0.9 and now in 工作时段:
      notify user
      ask verifier            # 二次确认也进同一套控制流
    else:
      digest                  # 进下次摘要
  loop monitor: every 6h
```

Flow 是用户的"编程面"：**控制流操控节点的输出与行为**——agent 是数据流里的处理节点，集群是流经它的管道。

### 4.3 门控决策（默认不打扰）

```
decide(event) → "drop" | "digest" | "notify-now"

规则（优先级从高到低）：
1. 用户反馈规则（.relay/notify-rules.jsonl，用户说"这个别告诉我"→ 沉淀规则）
2. 时段规则（勿扰时段，一律 digest）
3. 契约 notify 规则（事件类型 → 级别覆盖）
4. 事件 level（notify → 进入决策；critical → 直接 notify-now）
5. 阈值规则（如置信度 ≥ 0.9，来自 payload 字段）
6. 兜底：LLM 相关性判定（只在规则无法判定时调用，结果缓存）
```

- **默认不打扰**：宁可漏报（进摘要、可查询、可回补），不可误报（用户开始无视系统，信任崩塌不可回补）；
- 聚合：digest 队列 10 分钟窗口，同类事件合并为一条摘要；
- 出口：WebSocket（现有 server.ts）/ 桌面通知 / 下次会话摘要注入；
- **反馈学习**：用户对通知的每次反馈（忽略 / "以后别" / "这个要立刻说"）都写成规则，策略随使用变好；
- **判断成本显式化**：基线积累（先记录正常值才有"异常"）→ 规则判定 → LLM 兜底 → 用户反馈校准。初期存在校准期，明示之。

### 4.4 可稳定被控制的前提（特化的技术要求）

一个 agent 要被 if/loop 稳定驱动，必须：
- **标准协议**：统一的指令/事件通道（§1）；
- **确定的行为边界**：权限、超时、重试由契约与框架强制执行；
- **可见的状态**：可被条件判断（StateStore）；
- **可处理的错误**：流挂了能修（事件落盘 + 节点可重启）。

**不可预测的 agent 无法被编排，只能被"哄"。** 服务运行时的一切设计（协议、心跳、门控）都在服务于"让 agent 可被稳定控制"。

---

## 5. 全局状态模型（StateStore）

把 agent-registry 的 L1/L2/L3 升级为四层，新增 L0 结构化状态（节点 `state` 通道的数据源）：

| 层 | 内容 | 消费方 |
|---|---|---|
| L0 | 节点 state 增量合并的结构化状态（stateSchema 校验后） | 主 agent `query_state` 工具、GoalManager 进度 |
| L1 | 一行状态摘要（沿用 getSnapshot） | 终端 HUD、推送注入（节流去重） |
| L2 | 近期时间线（沿用 peek / recentHistory） | 按需注入 LLM（peekAsContext） |
| L3 | 完整对话 / 事件日志 | 深度排查 |

**主 agent 的"知晓" = 推送 + 拉取并用**：
- 推送：L1 变化**节流注入**（如 30s 内最多一次），防止上下文爆炸（现在 orchestrator 每次变化都注入）；
- 拉取：`query_state` 工具按节点/维度/标签查询 L0/L2——需要细节时自己查，不占上下文。

落盘：`.relay/state/<id>.json`，主进程重启后恢复（节点重启 ≠ 状态丢失）。

---

## 6. 事件总线与路由（EventBus）

现状 sink.ts 只是广播给 UI。升级为：

```
EventBus
├─ ingest(event)        — 统一入口，全部事件落盘 .relay/events/<date>.jsonl（审计）
├─ level(level)         — 分级处理（见 §1 表格）
├─ route(event)         — 按 consumes 声明投递相关节点（AI-AI 协作通道）
├─ correlate()          — 关联预筛（见 §8）
└─ emitToSinks(e)       — 兼容现有 MultiSink，UI（终端/Web）继续订阅
```

**节点间通信**：节点 `request` 指令（`to: <serviceId>`）或主进程路由 `event`（按 consumes）。防环：同一事件只投递一次，带 hop 计数（上限 3）。

---

## 7. 目标维度与时间（GoalManager + Scheduler）

### GoalManager（目标维度模型）

```ts
interface Goal {
  id: string; label: string;
  dimensions: GoalDimension[];       // 如：基础/项目/八股/LeetCode/简历/情报
}
interface GoalDimension {
  id: string; label: string;
  services: string[];                // 推进该维度的节点
  progress: Record<string, number>;  // 评估指标进度
  schedule: ScheduleSpec;
  lastActivity: number; lastReview: number;
}
```

- 维度进度由**节点 state 通道自报**（节点说"掌握度 0.6"就是 0.6），GoalManager 只聚合不推断；
- 间隔复习：`lastReview` + 默认间隔 → Scheduler 触发"整理该维度"事件；
- 维度由**用户设计**（设计即服务），GoalManager 不自动拆解目标。

### Scheduler（时间感知）

```ts
type ScheduleSpec =
  | { type: "interval"; every: string }   // "6h" / "30m"
  | { type: "cron"; expr: string }        // "0 9 * * *"
  | { type: "at"; ts: number };
```

- 到点 → 向节点发 `schedule` 指令（pusher 自己决定做什么）或发事件给主 agent（"该整理笔记了"）；
- **效率感知**：节点上报 performance 事件（答题数、错误率、耗时）→ GoalManager 维护滑动窗口效率曲线 → 变化超阈值 → 事件给主 agent（"学习效率下降 40%，建议切换维度"）→ 门控规则或主 agent 决策。

---

## 8. 关联层（Correlation）

"你学 X 赛道 + X 赛道今日异动"这类跨节点关联：

1. **落盘统一格式**：事件带 `correlationId`，payload 可含 `entities`（实体标签）；
2. **规则预筛**（纯代码）：同实体 / 同维度 / 时间窗（如 6h 内）匹配 → 候选关联对；
3. **LLM 精判**（只在触发点调用）：主 agent 对话时或 critical 事件时，把候选关联对交 LLM 判断是否值得报告；
4. **产出**：关联事实进 StateStore（可查询），或成为 notify 事件。

**关键决策**：关联不做全时扫描（成本太高），只在两个触发点做。

---

## 9. 信任验证与权限

### 信任（AI-AI 不能盲目互信）
- 事件可标记 `requiresVerification`（契约声明或运行时标记）；
- 收到后主 agent 二次核验：`query_state` / 请求原始数据 / `request` 问另一节点 → 确认才升级 notify；
- 全部事件落盘 = 审计日志，可回溯"节点说了什么、主 agent 采信了什么"；
- **诚实汇报是合法输出**：节点必须能声明"我做不到"（能力边界），主 agent 据此换路，不许硬编。

### 权限（常驻自主服务的刹车片）
- ToolExecutor 加 **enforcement 层**：按节点契约 `permissions` 过滤工具与参数——
  - `fs`：路径白名单（默认仅 `services/<id>/` 与任务指定目录）；
  - `net`：域名白名单（如 `*.binance.com`）；
  - `tools`：工具白名单（bash 默认禁用）；
- 节点独立 cwd = `services/<id>/`，跨目录访问必须显式授权；
- 呼应 ROADMAP：命令注入白名单、Docker 沙箱（后续强化）。

---

## 10. 三种来源、集群 App 与主 agent 工具集

### 10.1 三种来源

| 来源 | 动作 | 校验 |
|---|---|---|
| 用户定义 | 写 service.json + entry.ts → 丢进 services/ | 契约校验通过即启动 |
| 主 agent 生成 | 工具 `create_service(name, spec)` → 生成工件目录 → `test_service` 试运行 → `deploy_service` | 自检：契约校验 + 一次试运行 |
| 生态安装 | 服务包（目录 tar + 签名）→ 校验 → 安装到 services/ | 契约校验 + 签名校验 |

### 10.2 集群 App（mod 模式）——C 端的产品单元

**App = 一个可安装单元**：服务集合 + Flow 定义 + 维度模型 + 节奏计划，打包为一个"集群 app"。
集群像游戏，app 像 mod——多个 mod 共同发挥作用让集群增值；C 端用户零编排，**插入加载**即可。

我们做底层，必须支持完整加载链路：

1. **打包**：manifest（id、版本、依赖、作者）+ 内容（services/、flows/、goals/）；
2. **校验**：签名校验 + 契约校验（服务契约、Flow 引用的事件类型、维度 schema 全部静态检查）；
3. **依赖解析**：声明依赖的服务与版本，冲突检测；
4. **安装**：落盘 services/ + flows/ + goals/ → 注册 → 启动；
5. **更新**：版本化 + 热加载（无感升级、失败回滚）。

低代码编辑器（未来壳）：Flow 是数据（§4.2 声明式描述）→ 可视化编辑器只是换交互，不改变模型（见 §11.3）。

### 10.3 主 agent 工具集

主 agent = **有集群视野的推理节点**，新增工具集（挂在 orchestrator 工具表上）：

```
query_state(serviceId? | dimensionId? | filter)
list_services() / list_goals()
create_service(name, spec) / edit_service(id, patch)
test_service(id) / deploy_service(id)
send_to_service(serviceId, { kind: "ask"|"task"|"event", content })
```

生成一致性：主 agent 生成节点时，应复用用户已定义节点的模式（结构、命名、配置习惯）——用户已定义的服务是生成样本。

---

## 11. 观测、呈现与维护（建造者的控制台 + 多前端）

### 11.1 核心无头（headless）

- harness 核心不持有任何 UI——只暴露 API 与事件流；
- 呈现层是核心的客户端：**Web 主界面**（集群的主脸：节点/流/门控/状态/审计多视图）、**CLI 调试通道**（脚本化、headless 操作）、未来桌面/移动端；
- 集群是 7×24 服务：用户关掉终端，它仍在运转——守护在核心，不在前端。

### 11.2 建造者的控制台（Web 主界面 = 四视图）

用户是建造者与维护者 → 框架的第一类体验是**调试器**：

- **状态查询**：StateStore 查询 API（Web + CLI 双出口）；
- **控制流可视化/验证**：Flow 结构可渲染（谁连谁、什么条件）、可静态检查（引用的事件类型是否存在于契约、循环是否有出口）；
- **事件审计检索**：按节点/类型/级别/时间窗检索 `.relay/events/`；
- **门控命中记录**：每条通知决策留痕（命中了哪条规则 / 为何 digest / 为何 notify）；
- Web dashboard（server.ts）升级为控制台：节点状态 / 流状态 / 门控命中 / 最近事件四个视图。

### 11.3 低代码编辑器（未来壳，不改变模型）

- Flow 是数据（§4.2）→ 可视化编辑器只是换交互：渲染节点/连线/条件，产出同一份 Flow 描述；
- 前提（现在就必须满足）：Flow 可渲染、可静态检查、可验证——§11.2 已保证；
- 时间表：Phase 5+ 可选项，排在集群 App 市场之后——先让"插入加载"跑通，再谈"可视化定制"。

---

## 12. 与现有代码的映射（复用 vs 新建）

| 现有文件 | 处置 | 说明 |
|---|---|---|
| `actor.ts` | 改造 | stdin/stdout JSONL 循环模式复用，协议换成 ServiceEvent/ServiceCommand |
| `actor-handle.ts` | 改造 | pending-promise 通道机制复用，职责并入 ServiceRuntime |
| `agent-registry.ts` | 演进 | L1/L2/L3 分层保留，升级为 StateStore（加 L0 结构化状态） |
| `sink.ts` | 保留 | Sink 接口给 UI 订阅者，EventBus 内部接 MultiSink |
| `inbox.ts` | 保留 | 主进程事件入口（事件类型扩展） |
| `orchestrator.ts` | 演进 | 事件循环保留；加 query_state 等工具；快照注入节流；Flow 挂载 |
| `server.ts` | 演进 | Web 面板升级为控制台（状态/流/门控/事件四视图） |
| `subagent-cli.ts` | 保留 | 一次性子任务进程（dispatch 模式继续用），与常驻节点并存 |

新建模块：

```
src/service-contract.ts     — ServiceContract 类型 + JSON Schema 校验 + emits/consumes 静态检查
src/service-runtime.ts      — 单节点通道（spawn/readLoop/pending-promise）
src/supervisor.ts           — 生命周期：心跳、退避重启、优雅关停、启动恢复
src/flow.ts                 — 控制流引擎：Flow 描述解析、原语执行（if/loop/switch/pipe/fan-out/timer）
src/flow-gate.ts            — 门控决策（规则优先 + LLM 兜底 + 反馈沉淀）——v1 的 NotificationPolicy
src/state-store.ts          — L0-L3 状态模型 + 查询 API + 落盘恢复
src/event-bus.ts            — 分级处理 + 路由 + 审计落盘
src/scheduler.ts            — ScheduleSpec 解析与触发
src/goal-manager.ts         — 目标维度 CRUD + 进度聚合 + 效率曲线
src/notify-rules.ts         — 用户反馈规则的读写
src/console.ts              — 控制台视图（Web API + CLI）
```

---

## 13. 落地阶段

### Phase 1 —— 骨架与手动装配（人装服务跑起来）
- 统一事件协议（ServiceEvent/ServiceCommand 类型）；
- ServiceContract + 校验（含 execution/tools/权限声明）；
- ServiceRuntime + Supervisor（心跳、退避重启、启动恢复）；
- Flow 最小集：`loop` + `trigger`（on 事件）+ `if`（门控）；
- **人装两个示例服务跑通**（一个 pusher + 一个 watcher），手动写 service.json、连关系、定节奏。

**验收剧本**：
1. 写一个 pusher（每 6h 报 `state: {topic, mastered}`）+ 一个 watcher（循环检测，常态 silent、命中 notify）；
2. Flow：`on watcher.event(level=notify) → if 置信度≥0.9 → 推送；else digest`；
3. 观察：silent 不刷屏；notify 触发时用户收到推送；`supervisor` 杀掉 pusher 进程后自动重启。

### Phase 2 —— 知晓与开口
- StateStore（L0-L3）+ `query_state` / `list_services` 工具 + 快照注入节流；
- 门控完整化：反馈沉淀、时段规则、digest 聚合、LLM 兜底；
- 时间感知：Scheduler + 效率曲线。

**验收**：主 agent 对话"各服务在做什么？" → `query_state` 回答；用户反馈"这个别告诉我" → 规则生效。

### Phase 3 —— 创生与装配
- `create_service` / `test_service` / `deploy_service`（复制用户设计模式）；
- 生态安装（服务包 + 校验）+ 契约热加载。

### Phase 4 —— 关联与底线
- 关联层（规则预筛 + LLM 精判）；
- 权限 enforcement（fs/net/tools 白名单强制）；
- 守护强化（资源监控、常驻配置）。

### Phase 5 —— 生态（mod 模式）
- 集群 App 市场：打包、签名校验、依赖解析、安装、热加载、版本、回滚（§10.2 链路）；
- 低代码 Flow 编辑器（可选壳，Flow 已是数据）；
- 共享与社区。

### 明确不做（防止范围膨胀）
- 框架不做自动目标分解（设计即服务）；
- 框架不做领域逻辑（能力在节点里）；
- Phase 1 不做服务间路由、关联推理、创生工具、权限 enforcement。

---

## 14. 待确认决策

1. **节点间通信**：走主进程路由（`request` 指令，统一审计）——推荐；还是允许节点直连（快但无审计）？
2. **LLM 参与门控的边界**：只在规则判定冲突时调用（推荐，省成本），还是重要事件一律 LLM 判断（质量高但贵）？——可做成按服务可配置。
3. **常驻 vs 按需**：所有节点默认常驻（简单），还是支持"按需唤醒 + 空闲休眠"（省资源，但增加状态复杂度）？

---

*本设计随实现推进修订；每个模块落地时应回答"它服务于 VISION 的哪根支柱"。*
