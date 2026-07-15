# ISS-01: .env.example 缺失 + 环境变量文档不完整

> 状态: Plan (未实施)
> 优先级: P2 (新用户体验)
> 估计工作量: 0.5h

---

## 1. 问题描述

### 1.1 核心问题

项目缺少 `.env.example` 模板文件，导致贡献者无法按照 `CONTRIBUTING.md` 的指引完成开发环境搭建。此外，帮助文本中遗漏了 `DEEPSEEK_BASE_URL` 环境变量。

### 1.2 验证证据

| # | 检查项 | 预期 | 实际 | 结论 |
|---|--------|------|------|------|
| 1 | `.env.example` 文件存在 | — | 文件不存在 (`ls` 返回 exit code 2) | **确认缺失** |
| 2 | `CONTRIBUTING.md` 引用 `.env.example` | — | 第10行: `Copy .env.example to .env and add your DEEPSEEK_API_KEY` | 文档指示用户复制一个不存在的文件 |
| 3 | `package.json` 含 dotenv | 无 | 仅含 `openai` | 项目不依赖第三方 env 库 |
| 4 | `src/index.ts` 含 .env 加载 | 无 | 第20-24行仅为 `--help` 文本 | 无手动加载逻辑 |
| 5 | Bun 自动加载 `.env` | 预期输出 `undefined` | 实际输出 `hello`（`TEST_VAR` 被正确读取） | **Bun 1.3.14 自动加载 .env，工作正常** |

### 1.3 发现的额外问题

在审查环境变量使用情况时，发现以下不一致：

- **`src/llm.ts`** 使用 **3 个**环境变量：
  - `DEEPSEEK_API_KEY`（必填）
  - `DEEPSEEK_BASE_URL`（可选，默认 `https://api.deepseek.com`）
  - `DEEPSEEK_MODEL`（可选，默认 `deepseek-v4-flash`）

- **`src/index.ts` 帮助文本**仅列出 **2 个**环境变量：
  - `DEEPSEEK_API_KEY`
  - `DEEPSEEK_MODEL`
  - 遗漏了 `DEEPSEEK_BASE_URL`

- **`README.md`** 中通过 `export DEEPSEEK_API_KEY="sk-..."` 方式展示配置，未提及 `.env` 文件方式。

### 1.4 修正后的 ISSUE 定性

关于 "Bun 不自动加载 .env" 的主张已被证伪。实测 Bun 1.3.14 会自动加载项目根目录的 `.env` 文件。真正的问题是：

1. **缺少 `.env.example` 模板文件** -- 用户无法通过 `cp .env.example .env` 快速创建配置
2. **环境变量文档不一致** -- 帮助文本、README、代码实际使用之间存在缺口

---

## 2. 影响范围

### 2.1 受影响的用户场景

| 场景 | 当前体验 | 影响 |
|------|----------|------|
| 新贡献者按 CONTRIBUTING.md 设置环境 | `cp .env.example .env` 失败 | 阻塞性 -- 无法继续后续步骤 |
| 新用户通过 --help 查看配置 | 不知道 `DEEPSEEK_BASE_URL` 的存在 | 轻度 -- 默认值可工作，但自定义 Base URL 的用户不知道该选项 |
| 有经验的用户 | 手动 `export` 或自行创建 `.env` | 无影响 |

### 2.2 受影响的文件（当前）

| 文件 | 问题 |
|------|------|
| （缺失）`.env.example` | 需新建 |
| `CONTRIBUTING.md` 第10行 | 引用不存在的文件 |
| `src/index.ts` 第20-24行 | 帮助文本不完整 |
| `README.md` / `README.zh-CN.md` | 仅展示 `export` 方式 |

---

## 3. 优化方案

### 3.1 新建 `.env.example`

创建包含所有 3 个环境变量的模板文件，附带中文注释：

```bash
# Relay Code 环境变量配置
# 复制此文件为 .env 并填入实际值: cp .env.example .env

# [必填] DeepSeek API 密钥
DEEPSEEK_API_KEY=sk-your-api-key-here

# [可选] DeepSeek API Base URL（默认: https://api.deepseek.com）
# 如果你使用 DeepSeek 官方 API，不需要修改此项
# DEEPSEEK_BASE_URL=https://api.deepseek.com

# [可选] 模型名称（默认: deepseek-v4-flash）
# DEEPSEEK_MODEL=deepseek-v4-flash
```

### 3.2 补充 `src/index.ts` 帮助文本

在第23行后，增加 `DEEPSEEK_BASE_URL` 的说明：

```typescript
console.log("  DEEPSEEK_BASE_URL   Optional. API Base URL (default: https://api.deepseek.com)");
```

改动位置：`src/index.ts`，放在 `DEEPSEEK_MODEL` 说明之后。

### 3.3 更新 README（可选，建议一并处理）

在 README.md 和 README.zh-CN.md 的环境变量配置部分，增加 `.env` 文件方式的说明，给用户提供两种选择：

```markdown
### 方式一：使用 .env 文件（推荐）

cp .env.example .env
# 编辑 .env 填入你的 DEEPSEEK_API_KEY

### 方式二：使用环境变量

export DEEPSEEK_API_KEY="sk-..."
```

### 3.4 考虑添加 `.gitignore` 规则

确认 `.gitignore` 中已包含 `.env`（防止用户误提交密钥）。如果不存在，新增：

```
# Environment
.env
```

---

## 4. 文件改动清单

| 操作 | 文件 | 说明 |
|------|------|------|
| **新建** | `.env.example` | 包含全部 3 个环境变量的模板 |
| **修改** | `src/index.ts` 第23行附近 | 帮助文本增加 `DEEPSEEK_BASE_URL` |
| **修改** | `README.md` | 增加 .env 文件方式说明 |
| **修改** | `README.zh-CN.md` | 增加 .env 文件方式说明 |
| **验证** | `.gitignore` | 确认 `.env` 已在忽略列表中 |

---

## 5. 验收标准

### 5.1 功能验收

- [ ] `.env.example` 文件存在且包含全部 3 个环境变量
- [ ] `cp .env.example .env` 后填入 `DEEPSEEK_API_KEY`，`bun run src/index.ts "hello"` 能正常调用 LLM
- [ ] `bun run src/index.ts --help` 输出包含 `DEEPSEEK_BASE_URL` 的说明
- [ ] README 中提供了 .env 文件使用方式的说明

### 5.2 非功能验收

- [ ] `.env.example` 注释清晰，中英文用户均能理解
- [ ] 模板中的可选变量默认被注释掉，减少用户困惑
- [ ] `.env` 在 `.gitignore` 中，用户不会误提交密钥

### 5.3 回归验收

- [ ] `bun run type-check` 通过
- [ ] `bun run lint` 通过
- [ ] `bun test` 通过
- [ ] 现有功能不受影响（仅为文档/模板变更）

---

## 6. 工作量估计

| 任务 | 估计时间 |
|------|----------|
| 创建 `.env.example` | 5 min |
| 修改 `src/index.ts` 帮助文本 | 5 min |
| 更新 README.md + README.zh-CN.md | 10 min |
| 验证 `.gitignore` | 2 min |
| 验收测试 | 8 min |
| **合计** | **~30 min** |

---

## 7. 风险与注意事项

1. **无风险**：所有改动均为新增文件 + 文档/注释修改，不涉及运行时逻辑变更。
2. **密钥安全**：`.env.example` 中应使用占位符 `sk-your-api-key-here`，不得包含真实密钥。
3. **Bun 版本依赖**：`.env` 自动加载依赖 Bun >= 1.2.0。项目 `CONTRIBUTING.md` 已要求 Bun 1.3+，满足条件。
4. **潜在冲突**：如果未来打算支持其他运行时（Node.js），需要额外引入 dotenv。当前项目是纯 Bun 项目，无需处理。
