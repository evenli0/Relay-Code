import { feedbackLine } from "./feedback";
import { Orchestrator } from "./orchestrator";

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

		feedbackLine(`\n[运行] ${input}`);
		const result = await orchestrator.runReAct(input);
		console.log(`\n${result}\n`);
		readline.prompt();
	}

	readline.close();
}

async function main() {
	const arg = process.argv[2];

	if (!arg || arg === "--help") {
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

	// Pipe mode: read from stdin if available
	if (!process.stdin.isTTY && !arg) {
		const stdin = await Bun.stdin.text();
		if (stdin.trim()) {
			const orchestrator = new Orchestrator();
			const result = await orchestrator.runReAct(stdin.trim());
			console.log(result);
			return;
		}
	}

	// Normal mode
	const orchestrator = new Orchestrator();
	const result = await orchestrator.runReAct(arg);
	console.log(result);
}

main().catch(console.error);
