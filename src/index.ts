import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AgentRegistry } from "./agent-registry";
import { milestone } from "./display";
import { Inbox } from "./inbox";
import { saveDialogue } from "./memory";
import { Orchestrator } from "./orchestrator";
import type { SinkEvent } from "./sink";

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
	console.log("  bun run src/index.ts <task>        Run the agent with a task");
	console.log("  bun run src/index.ts --help         Show this help");
	console.log("  bun run src/index.ts --version      Show version");
	console.log("  bun run src/index.ts --chat         Interactive chat mode");
	console.log(
		"  bun run src/index.ts --daemon       Event-driven agent cluster (async dispatch)",
	);
	console.log("");
	console.log("Examples:");
	console.log('  bun run src/index.ts "analyze the file structure"');
	console.log("  bun run src/index.ts --chat");
	console.log("  bun run src/index.ts --daemon");
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
	const inbox = new Inbox();
	const registry = new AgentRegistry();
	const orchestrator = new Orchestrator(inbox, registry);

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

/** daemon 模式：事件驱动循环 */
async function daemonMode(): Promise<void> {
	const inbox = new Inbox();
	const registry = new AgentRegistry();
	const { StateStore } = await import("./state-store");
	const stateStore = new StateStore();
	stateStore.restore(); // 节点重启 ≠ 状态丢失
	const orchestrator = new Orchestrator(
		inbox,
		registry,
		undefined,
		undefined,
		stateStore,
	);

	// Sink 事件总线
	const { MultiSink } = await import("./sink");
	const { createWsSink } = await import("./server");
	const multiSink = new MultiSink();

	// Terminal Sink: CLI 输出
	multiSink.add({
		emit(e: SinkEvent) {
			switch (e.kind) {
				case "llm_response":
					console.log(`
${e.text}
`);
					process.stdout.write("> ");
					break;
				case "agent_done":
					console.log(`✅ [${e.role}] 完成: ${(e.output || "").slice(0, 100)}`);
					break;
				case "agent_error":
					console.log(`❌ [${e.role}] 错误: ${(e.error || "").slice(0, 100)}`);
					break;
				case "agent_dispatched":
					console.log(`🚀 [${e.role}] 已派出: ${(e.task || "").slice(0, 80)}`);
					break;
				case "notice":
					console.log(`[${e.level}] ${e.text}`);
					break;
			}
		},
	});
	multiSink.add(createWsSink());
	orchestrator.setSink(multiSink);

	// 启动 Web Dashboard
	const { startServer } = await import("./server");
	startServer(3000, registry, inbox, multiSink);

	console.log(
		`Relay Code v${VERSION} — daemon mode — Dashboard: http://localhost:3000.\n`,
	);
	console.log("Commands:");
	console.log("  <任意文本>             发送任务给主 Agent");
	console.log("  actor <任务>            启动常驻 Actor 子 Agent");
	console.log("  talk <id>               进入 Actor 专用对话模式");
	console.log("  status                  查看所有 Agent 状态");
	console.log("  peek [id]               查看 Agent 详情");
	console.log("  exit                    退出");
	console.log("");

	// stdin 监听：把每行输入推入收件箱
	const readline = (await import("node:readline")).createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	// talk 模式状态
	let talkTarget: string | null = null;
	let talkHandle: import("./actor-handle").ActorHandle | null = null;

	// 监听输入行
	readline.on("line", async (line: string) => {
		const input = line.trim();
		if (!input) {
			process.stdout.write("> ");
			return;
		}
		if (input === "exit") {
			readline.close();
			process.exit(0);
		}

		if (input === "status") {
			const agents = registry.getAll();
			if (agents.length === 0) {
				console.log("当前没有运行中的子 Agent。");
			} else {
				console.log(registry.getSnapshot());
			}
			process.stdout.write("> ");
			return;
		}

		if (input.startsWith("peek")) {
			const targetId = input.slice(4).trim();
			if (!targetId) {
				// peek all: 列出所有 agent
				const agents = registry.peekAll();
				if (agents.length === 0) {
					console.log("当前没有子 Agent。");
				} else {
					for (const a of agents) {
						const shortId = a.id.slice(-8);
						const p = a.progress;
						const detail = p
							? `第${p.round}轮 ${p.lastAction} — ${p.lastSummary}`
							: "无进度数据";
						console.log(`  [${a.status}] ${a.role} (${shortId}): ${detail}`);
					}
				}
			} else {
				// peek 特定 agent: 看时间线
				const ctx = registry.peekAsContext(
					targetId.length < 8
						? ([...registry.getAll()].find((a) => a.id.endsWith(targetId))
								?.id ?? targetId)
						: targetId,
				);
				console.log(ctx);
			}
			process.stdout.write("> ");
			return;
		}

		if (input.startsWith("actor ")) {
			const task = input.slice(5).trim();
			if (!task) {
				console.log("用法: actor <任务描述>  — 启动一个常驻 Actor 子 Agent");
				process.stdout.write("> ");
				return;
			}
			const { dispatchAsync } = await import("./dispatcher");
			const { agentId } = await dispatchAsync(
				{
					prompt: { task, role: "Actor" },
					responseSchema: {
						type: "object",
						properties: { result: { type: "string" } },
					},
					max_rounds: 30,
				},
				inbox,
				registry,
				"main",
				multiSink,
				"actor",
			);
			console.log(
				`[Actor 已启动] ${agentId.slice(-8)} — 可用 talk <id> 进入对话`,
			);
			process.stdout.write("> ");
			return;
		}

		if (input.startsWith("talk ")) {
			const targetId = input.slice(5).trim();
			if (!targetId) {
				console.log("用法: talk <agentId>");
				process.stdout.write("> ");
				return;
			}
			const handle = registry.getHandle(targetId);
			if (!handle) {
				console.log(`Actor ${targetId} 不存在或不是 Actor 模式`);
				process.stdout.write("> ");
				return;
			}
			// 设置 talk 模式标记 — 后续输入直接发给 Actor
			talkTarget = targetId;
			talkHandle = handle;
			console.log(
				`
进入 Actor ${targetId.slice(-8)} 对话模式 — 输入 /exit 退出
`,
			);
			process.stdout.write(`[${targetId.slice(-8)}] > `);
			return;
		}

		// talk 模式中：输入发给 Actor，不推 inbox
		if (talkTarget && talkHandle) {
			if (input === "/exit") {
				console.log("已退出对话模式\n");
				talkTarget = null;
				talkHandle = null;
				process.stdout.write("> ");
				return;
			}
			const reply = await talkHandle.ask(input, "human");
			console.log(`[${talkTarget.slice(-8)}] ${reply}`);
			process.stdout.write(`[${talkTarget.slice(-8)}] > `);
			return;
		}

		// 推入收件箱，orchestrator 的事件循环会处理
		inbox.push({
			type: "user_message",
			threadId: "main",
			timestamp: Date.now(),
			content: input,
		});
		console.log(`[已入队] ${input.slice(0, 60)}...`);
	});

	// 事件循环（阻塞）
	await orchestrator.start();
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

	if (arg === "--daemon") {
		await daemonMode();
		return;
	}

	// 3. 最终检查：无任务则显示帮助
	if (!arg) {
		showHelp();
		process.exit(0);
	}

	// 4. 正常模式：单次异步执行
	const inbox = new Inbox();
	const registry = new AgentRegistry();
	const orchestrator = new Orchestrator(inbox, registry);
	await saveDialogue("user", arg);
	const result = await orchestrator.runReAct(arg);
	console.log(result);
}

main().catch(console.error);
