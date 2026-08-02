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
	const { FlowGate } = await import("./flow-gate");
	const { appendNotifyRule, loadNotifyRules } = await import("./notify-rules");
	const { Correlator } = await import("./correlator");
	const { Scheduler } = await import("./scheduler");
	const { Supervisor } = await import("./supervisor");
	// 门控：文件沉淀规则（用户反馈）+ 默认分级（silent 积攒 / notify 推送 / critical 唤醒）
	const gate = new FlowGate(undefined, loadNotifyRules());
	// 服务集群：Supervisor 管理常驻服务 + 节奏调度
	const scheduler = new Scheduler();
	const supervisor = new Supervisor({ scheduler });
	// 关联层：跨服务上下文关联（规则预筛）
	const correlator = new Correlator();
	const orchestrator = new Orchestrator(
		inbox,
		registry,
		undefined,
		gate,
		stateStore,
		supervisor,
		correlator,
	);
	supervisor.onNodeEvent = (id, msg) => {
		stateStore.ingest(id, msg);
		// 契约 disposition（服务声明层）随事件传入门控；用户规则仍可覆盖
		orchestrator.handleServiceEvent(
			id,
			msg,
			msg.kind === "event"
				? supervisor.getContractDisposition(id, msg.type)
				: undefined,
		);
	};
	const restored = supervisor.restore();
	if (restored.length > 0) {
		console.log(
			`[集群] 已恢复 ${restored.length} 个服务: ${restored.join(", ")}`,
		);
	}

	// 编排收编：FlowManifest 生成 + 静态交叉校验（流断链启动即报）
	const { buildFlowManifest, validateFlowManifest } = await import(
		"./flow-manifest"
	);
	const contracts = supervisor.listContracts();
	const manifest = buildFlowManifest(contracts, loadNotifyRules());
	const flowCheck = validateFlowManifest(manifest, contracts);
	if (flowCheck.errors.length > 0) {
		console.log(
			`[flow] ✗ 编排错误（请修复）:\n  ${flowCheck.errors.join("\n  ")}`,
		);
	}
	if (flowCheck.warnings.length > 0) {
		console.log(`[flow] ⚠ 编排警告:\n  ${flowCheck.warnings.join("\n  ")}`);
	}
	console.log(
		`[flow] 编排图: ${manifest.services.length} 服务 · ${manifest.events.length} 事件边 · ${manifest.routes.length} 路由 · ${manifest.schedules.length} 节奏`,
	);

	// Flow 引擎：fan-out/merge 并行聚合（flows/ 声明文件）
	const { FlowEngine } = await import("./flow-engine");
	const { ToolExecutor } = await import("./tool-executor");
	const flowEngine = new FlowEngine(new ToolExecutor());
	orchestrator.setFlowEngine(flowEngine);

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

	// 启动 Web Dashboard（建造者控制台：服务集群 + 门控命中）
	const { startServer } = await import("./server");
	startServer(3000, registry, inbox, multiSink, {
		stateStore,
		supervisor,
		orchestrator,
	});

	console.log(
		`Relay Code v${VERSION} — daemon mode — Dashboard: http://localhost:3000.\n`,
	);
	console.log("Commands:");
	console.log("  <任意文本>             发送任务给主 Agent");
	console.log("  actor <任务>            启动常驻 Actor 子 Agent");
	console.log("  talk <id>               进入 Actor 专用对话模式");
	console.log("  status                  查看所有 Agent 状态");
	console.log("  peek [id]               查看 Agent 详情");
	console.log(
		"  rule <type> <action>    沉淀通知规则（如: rule scan.done digest）",
	);
	console.log(
		"  reload                  热加载 services/ 目录（启动新增/停止移除）",
	);
	console.log("  approve <svc> <tool>    批准服务的高危操作（批准点，记忆化）");
	console.log("  export/install/rollback 服务包市场（rpk：导出/安装/回滚）");
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
			// 服务集群健康（守护强化：uptime/重启次数）
			const svcs = supervisor.getClusterStatus();
			if (svcs.length > 0) {
				console.log("\n## 服务集群状态");
				for (const s of svcs) {
					const icon =
						s.status === "running" ? "⟳" : s.status === "error" ? "✗" : "⏹";
					console.log(
						`  ${icon} ${s.id}: ${s.status} (uptime ${Math.round(s.uptimeMs / 1000)}s, 重启 ${s.restartCount} 次)`,
					);
				}
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

		if (input.startsWith("rule ")) {
			// rule <eventType> <action> —— 用户反馈沉淀："这个别告诉我"
			// action: immediate（唤醒大脑）/ defer（积攒）/ notify（推送）/ archive（丢弃）
			// 兼容旧值：show→notify / digest→defer / drop→archive
			const parts = input.slice(5).trim().split(/\s+/);
			const [eventType, actionRaw] = parts;
			const { normalizeDisposition } = await import("./flow-gate");
			const action = normalizeDisposition(actionRaw);
			if (!eventType || !action) {
				console.log(
					"用法: rule <eventType> <action>  (action: immediate/defer/notify/archive，兼容 show/digest/drop)",
				);
				process.stdout.write("> ");
				return;
			}
			const rule = {
				match: { eventType },
				action,
			} as import("./flow-gate").GateRule;
			appendNotifyRule(rule);
			orchestrator.addGateRule(rule);
			console.log(
				`规则已生效: ${eventType} → ${action}（已沉淀到 .relay/notify-rules.jsonl）`,
			);
			process.stdout.write("> ");
			return;
		}

		if (input.startsWith("approve ")) {
			// approve <serviceId> <tool> —— 批准点确认流（记忆化）
			const parts = input.slice(8).trim().split(/\s+/);
			const [serviceId, tool] = parts;
			if (!serviceId || !tool) {
				console.log("用法: approve <serviceId> <tool>");
				process.stdout.write("> ");
				return;
			}
			const { grantApproval } = await import("./approvals");
			grantApproval(serviceId, tool);
			console.log(
				`已批准: ${serviceId} 的 ${tool}（记忆化到 .relay/approvals.jsonl，后续自动放行）`,
			);
			process.stdout.write("> ");
			return;
		}

		if (input.startsWith("export ")) {
			// export <serviceId> —— 导出 rpk 包（集群 App 市场，Phase5-B）
			const serviceId = input.slice(7).trim();
			if (!serviceId) {
				console.log("用法: export <serviceId>");
				process.stdout.write("> ");
				return;
			}
			const { exportServicePackage } = await import("./service-package");
			const r = exportServicePackage(serviceId);
			if (!r.ok) {
				console.log(`导出失败: ${r.error}`);
			} else {
				console.log(`已导出: ${r.path}`);
			}
			process.stdout.write("> ");
			return;
		}

		if (input.startsWith("install ")) {
			// install <rpk路径> —— 安装服务包并热加载
			const pkgPath = input.slice(8).trim();
			if (!pkgPath) {
				console.log("用法: install <rpk路径>");
				process.stdout.write("> ");
				return;
			}
			const { readFileSync } = await import("node:fs");
			const { installPackage, validatePackage } = await import(
				"./service-package"
			);
			let raw: unknown;
			try {
				raw = JSON.parse(readFileSync(pkgPath, "utf-8")) as unknown;
			} catch (e) {
				console.log(`安装失败: 包读取失败 ${e}`);
				process.stdout.write("> ");
				return;
			}
			const v = validatePackage(raw);
			if (!v.ok) {
				console.log(`安装失败: ${v.errors.join("; ")}`);
				process.stdout.write("> ");
				return;
			}
			const r = installPackage(v.pkg);
			if (!r.ok) {
				console.log(`安装失败: ${r.error}`);
			} else {
				console.log(
					`已安装: ${r.installed}${r.backedUp ? `（旧版已备份: ${r.backedUp}）` : ""}，reload 生效中...`,
				);
				supervisor.sync();
			}
			process.stdout.write("> ");
			return;
		}

		if (input.startsWith("rollback ")) {
			// rollback <serviceId> —— 回滚到最近备份
			const serviceId = input.slice(9).trim();
			if (!serviceId) {
				console.log("用法: rollback <serviceId>");
				process.stdout.write("> ");
				return;
			}
			const { rollbackService } = await import("./service-package");
			const r = rollbackService(serviceId);
			if (!r.ok) {
				console.log(`回滚失败: ${r.error}`);
			} else {
				console.log(`已回滚到: ${r.from}，reload 生效中...`);
				supervisor.sync();
			}
			process.stdout.write("> ");
			return;
		}

		if (input === "reload") {
			// 热加载：对比 services/ 目录，启动新增/停止移除
			const r = supervisor.sync();
			console.log(
				`[reload] 启动 ${r.started.length} 个: ${r.started.join(", ") || "无"}；停止 ${r.stopped.length} 个: ${r.stopped.join(", ") || "无"}${r.errors.length > 0 ? `；错误: ${r.errors.join("; ")}` : ""}`,
			);
			process.stdout.write("> ");
			return;
		}

		if (input.startsWith("flow ")) {
			// flow list / flow run <id> —— fan-out/merge 并行聚合原语
			const parts = input.slice(5).trim().split(/\s+/);
			const [sub, arg] = parts;
			if (sub === "list") {
				const ids = flowEngine.list();
				console.log(
					ids.length > 0
						? `已声明的 flow: ${ids.join(", ")}`
						: "无 flow（flows/<id>.json 声明）",
				);
			} else if (sub === "run" && arg) {
				const r = await flowEngine.runFanout(arg);
				if (r.ok) {
					console.log(`[flow] ${arg}（merge=${r.merge}）:\n${r.output}`);
				} else {
					console.log(`[flow] 失败: ${r.error}`);
				}
			} else {
				console.log("用法: flow list | flow run <id>");
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
