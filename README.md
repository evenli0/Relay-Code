# Relay Code

单 Agent + dispatch 工具的编码助手系统。用 ReAct 循环 + 语义编排挑战 Workflow 的死板 JS 脚本。

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

---

## Architecture

```
User Input
    │
    ▼
Orchestrator (ReAct Loop) ──► callLLM (DeepSeek API)
    │                              │
    │                              ▼
    │                        Tool Call Decision
    │                              │
    ├── read/write/grep/bash ──────┘  (file operations)
    │
    └── dispatch ──► Harness ──► SubAgent (isolated ReAct)
                                      │
                                      ▼
                               Structured Result (JSON)
```

Key components:

| Component | File | Role |
|-----------|------|------|
| **Orchestrator** | `src/orchestrator.ts` | Main ReAct loop, plan injection |
| **Harness** | `src/harness.ts` | Dispatch factory, SubAgent management |
| **SubAgent** | `src/harness.ts` | One-shot ReAct executor with isolated context |
| **dispatch** | `src/tools.ts` | Workflow orchestration tool |
| **Worktree** | `src/worktree.ts` | Git worktree isolation for parallel agents |

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) 1.3+
- DeepSeek API key

### Setup

```bash
git clone https://github.com/evenli0/Relay-Code.git
cd relay-code
bun install
```

### Configuration

```bash
export DEEPSEEK_API_KEY="sk-..."
export DEEPSEEK_MODEL="deepseek-v4-flash"   # Optional (default)
```

### Usage

```bash
# Start the agent with a task
bun run src/index.ts "分析当前目录的文件结构"

# Development mode (auto-reload)
bun run dev
```

### Running Tests

```bash
bun test                          # Unit tests
bun test tests/integration/       # Integration tests (git worktrees)
bun run type-check                # TypeScript type checking
```

## Project Structure

```
relay-code/
├── src/
│   ├── index.ts              # Entry point
│   ├── orchestrator.ts       # Main ReAct loop
│   ├── harness.ts            # Dispatch factory + SubAgent
│   ├── tools.ts              # Tool definitions
│   ├── llm.ts                # DeepSeek API client
│   ├── types.ts              # Type definitions
│   ├── memory.ts             # Dialogue persistence
│   ├── prompts.ts            # System prompt builder
│   └── worktree.ts           # Git worktree isolation
├── tests/
│   ├── harness.test.ts       # Harness + dispatch tests
│   ├── react.test.ts         # ReAct loop tests
│   ├── memory.test.ts        # Memory tests
│   └── integration/          # Real git worktree tests
├── .github/workflows/ci.yml  # CI pipeline
├── CHANGELOG.md
└── LICENSE
```

## Features

### Workflow Orchestration

Dispatch sub-agents with isolated contexts:

```typescript
dispatch({
  preload: ["src/main.ts"],
  prompt: { task: "审查安全性", role: "安全审计员" },
  responseSchema: {
    type: "object",
    properties: { score: { type: "number" }, findings: { type: "array" } }
  }
})
```

### Plan-Driven Execution

Write `plan.md` — harness auto-injects into context. Supports blueprints (`plans/<name>/plan.md`) and instances (`plans/<name>/records/`).

### Worktree Isolation

Sub-agents run in isolated git worktrees for safe parallel writes:

```typescript
dispatch({
  isolation: "worktree",
  prompt: { task: "重构多个文件" }
})
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DEEPSEEK_API_KEY` | ✅ | - | DeepSeek API key |
| `DEEPSEEK_MODEL` | ❌ | `deepseek-v4-flash` | Model name |
| `DEEPSEEK_BASE_URL` | ❌ | `https://api.deepseek.com` | API base URL |

## License

[MIT](LICENSE)
