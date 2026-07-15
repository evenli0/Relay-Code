import { milestone } from "./display";
import { saveDialogue } from "./memory";
import { Orchestrator } from "./orchestrator";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// === .env 自动加载 ===
try {
  const envPath = resolve(import.meta.dir, "..", ".env");
  const content = readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (key && !process.env[key]) {
      process.env[key] = val;
    }
  }
} catch {
  // .env 不存在是允许的
}

const VERSION = "0.1.0";

function showHelp(): void {
	console.log(`Relay Code v${VERSION}`);
	console.log("");
	console.log("Usage:");
	console.log("  bun run src/index.ts <task>     Run the agent with a task");
	console.log("  bun run src/index.ts --help      Show this help");
	console.log("  bun run src/index.ts --version   Show version");
	console.log("  bun run src/index.ts --chat      Interactive chat mode");
	console.log("");
	console.log("Examples:");
	console.log('  bun run src/index.ts "analyze the file structure"');
	console.log("  bun run src/index.ts --chat");
	console.log("");
	console.log("Environment:");
	console.log("  DEEPSEEK_API_KEY    Required. Your DeepSeek API key");
	console.log(
		"  DEEPSEEK_MODEL      Optional. Model name (default: deepseek-v4-flash)",
	);
	console.log(
		"  DEEPSEEK_BASE_URL   Optional. API base URL (default: https://api.deepseek.com)",
	);
}

async function chatMode(): Promise<void> {
	const orchestrator = new Orchestrator();
	const readline = (await import("node:readline")).createInterface({
		input: process.stdin,
		output: process.stdout,
		prompt: "> ",
	});

	console.log(
		`Relay Code v${VERSION} — interactive mode. Type "exit" to quit.\n`,
	);
	readline.prompt();

	for await (const line of readline) {
		const input = line.trim();
		if (!input || input === "exit") break;

		milestone(`运行: ${input}`);
		const result = await orchestrator.runReAct(input);
		console.log(`\n${result}\n`);
		readline.prompt();
	}

	readline.close();
}

async function main() {
	let arg = process.argv[2];

	// 1. 先检测管道模式（在任何参数解析之前）
	if (!process.stdin.isTTY) {
		const chunks: Buffer[] = [];
		for await (const chunk of process.stdin) {
			chunks.push(chunk as Buffer);
		}
		const pipedTask = Buffer.concat(chunks).toString("utf-8").trim();
		if (pipedTask) {
			arg = pipedTask;
		}
	}

	// 2. 然后处理 CLI 参数
	if (arg === "--help") {
		showHelp();
		process.exit(0);
	}

	if (arg === "--version") {
		console.log(`Relay Code v${VERSION}`);
		process.exit(0);
	}

	if (arg === "--chat") {
		await chatMode();
		return;
	}

	// 3. 最终检查：无任务则显示帮助
	if (!arg) {
		showHelp();
		process.exit(0);
	}

	// 4. 正常模式
	const orchestrator = new Orchestrator();
	await saveDialogue("user", arg);
	const result = await orchestrator.runReAct(arg);
	console.log(result);
}

main().catch(console.error);
