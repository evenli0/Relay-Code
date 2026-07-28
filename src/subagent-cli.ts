/**
 * subagent-cli.ts —— 子 Agent 独立进程入口
 *
 * 用法: bun run src/subagent-cli.ts <task-json-path>
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SubAgent } from "./dispatcher";
import { assembleMessages } from "./message-assembler";
import { ToolExecutor } from "./tool-executor";
import type { DispatchConfig } from "./types";

const taskPath = process.argv[2];
if (!taskPath) {
	process.stderr.write("用法: bun run src/subagent-cli.ts <task-json-path>\n");
	process.exit(1);
}
if (!existsSync(taskPath)) {
	process.stderr.write(`任务文件不存在: ${taskPath}\n`);
	process.exit(1);
}

const config: DispatchConfig = JSON.parse(readFileSync(taskPath, "utf-8"));

const TASKS_DIR = ".relay/tasks";
const agentId = taskPath.split("/").pop()?.replace(/\.json$/, "") ?? "unknown";
const progressPath = `${TASKS_DIR}/${agentId}.progress.json`;
const conversationPath = `${TASKS_DIR}/${agentId}.conversation.jsonl`;

if (!existsSync(TASKS_DIR)) mkdirSync(TASKS_DIR, { recursive: true });

const startTime = Date.now();

function writeProgress(round: number, action: string, summary: string): void {
	try {
		writeFileSync(progressPath, JSON.stringify({
			round, totalRounds: config.max_rounds ?? 30,
			lastAction: action, lastSummary: summary.slice(0, 100),
			elapsedMs: Date.now() - startTime, updatedAt: Date.now(),
		}), "utf-8");
	} catch { /* ignore */ }
}

function appendConversation(entry: Record<string, unknown>): void {
	try { appendFileSync(conversationPath, `${JSON.stringify(entry)}\n`, "utf-8"); } catch { /* ignore */ }
}

const messages = await assembleMessages(config);
writeProgress(0, "启动", "准备执行");

const allowedToolNames = config.allowed_tools ?? ["read", "write", "grep", "bash"];
const executor = new ToolExecutor();

const onProgress = (round: number, _total: number, action: string, summary: string) => {
	writeProgress(round, action, summary);
	appendConversation({ round, timestamp: Date.now(), action, summary: summary.slice(0, 200) });
};

const agent = new SubAgent(messages, allowedToolNames, executor, undefined, config.max_rounds, config.max_time_ms, onProgress);
const result = await agent.run();

const resultPath = taskPath.replace(/\.json$/, ".result.json");
const resultDir = dirname(resultPath);
if (!existsSync(resultDir)) mkdirSync(resultDir, { recursive: true });
writeFileSync(resultPath, JSON.stringify(result, null, 2), "utf-8");

// 清理进度文件
try { if (existsSync(progressPath)) { const { unlinkSync } = await import("node:fs"); unlinkSync(progressPath); } } catch { /* ignore */ }

process.exit(result.status === "completed" ? 0 : 1);
