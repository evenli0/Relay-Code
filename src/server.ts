/**
 * server.ts — Web Dashboard + HTTP API + WebSocket
 *
 * 在 daemon 进程内嵌一个 HTTP 服务，提供：
 *   GET  /             → dashboard.html
 *   GET  /api/state    → registry.peekAll() JSON
 *   GET  /api/events   → 最近事件列表 JSON
 *   POST /api/cmd      → 推入 inbox 派发新 Agent
 *   WS   /ws           → 实时推送 agent 状态变化
 */
import type { AgentRegistry } from "./agent-registry";
import type { FlowEngine } from "./flow-engine";
import { buildFlowManifest, validateFlowManifest } from "./flow-manifest";
import type { Inbox } from "./inbox";
import { loadNotifyRules } from "./notify-rules";
import type { Orchestrator } from "./orchestrator";
import type { Sink, SinkEvent } from "./sink";
import type { StateStore } from "./state-store";
import type { Supervisor } from "./supervisor";

const _events: string[] = [];
const _wsClientsAny = new Set<{ send(data: string): void }>();

// 对话消息缓存（服务端内存，刷新不丢）
interface ConvMsg {
	text: string;
	cls: "user" | "agent";
	ts: string;
}
const _conversation: ConvMsg[] = [];
const MAX_CONV_MSGS = 200;

function pushConversation(text: string, cls: "user" | "agent"): void {
	const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
	_conversation.push({ text, cls, ts: `[${time}]` });
	if (_conversation.length > MAX_CONV_MSGS) _conversation.shift();
}

export function createWsSink(): Sink {
	return {
		emit(e: SinkEvent) {
			const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
			const label = eventLabel(e);
			_events.push(`[${time}] ${label}`);
			if (_events.length > 100) _events.shift();

			// 同步写入对话缓存（刷新不丢）
			if (e.kind === "llm_response") {
				pushConversation(e.text, "agent");
			} else if (e.kind === "notice" && e.text.startsWith("💡")) {
				pushConversation(e.text.replace("💡 Web: ", ""), "user");
			} else if (e.kind === "notice" && e.level === "notify") {
				pushConversation(`🔔 ${e.text.slice(0, 200)}`, "agent");
			} else if (e.kind === "agent_done") {
				pushConversation(
					`✅ [${e.role}] 完成: ${(e.output || "").slice(0, 300)}`,
					"agent",
				);
			} else if (e.kind === "agent_error") {
				pushConversation(
					`❌ [${e.role}] 错误: ${(e.error || "").slice(0, 200)}`,
					"agent",
				);
			} else if (e.kind === "agent_dispatched") {
				pushConversation(
					`🚀 派出 [${e.role}]: ${(e.task || "").slice(0, 100)}`,
					"agent",
				);
			}

			// 广播 Sink 事件到 WebSocket 客户端
			const payload = JSON.stringify({ type: "sink", event: e });
			for (const ws of _wsClientsAny) {
				try {
					ws.send(payload);
				} catch {
					/* ignore */
				}
			}
		},
	};
}

function eventLabel(e: SinkEvent): string {
	switch (e.kind) {
		case "agent_dispatched":
			return `🚀 ${e.agentId} [${e.role}] 已派出`;
		case "agent_done":
			return `✅ ${e.agentId} [${e.role}] 完成`;
		case "agent_error":
			return `❌ ${e.agentId} [${e.role}] 错误`;
		case "llm_response":
			return `💬 ${e.text.slice(0, 80)}`;
		case "notice":
			return `[${e.level}] ${e.text}`;
		default:
			return e.kind;
	}
}

export function pushEvent(msg: string): void {
	const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
	_events.push(`[${time}] ${msg}`);
	if (_events.length > 100) _events.shift();

	const payload = JSON.stringify({ type: "event", msg: `[${time}] ${msg}` });
	for (const ws of _wsClientsAny) {
		try {
			ws.send(payload);
		} catch {
			/* ignore */
		}
	}
}

export function broadcastState(registry: AgentRegistry): void {
	const agents = registry.peekAll();
	const payload = JSON.stringify({
		type: "state",
		agents: agents.map((a) => ({
			id: a.id.slice(-8),
			role: a.role,
			status: a.status,
			progress: a.progress,
			summary: a.summary,
		})),
		running: agents.filter((a) => a.status === "running").length,
		done: agents.filter((a) => a.status === "done").length,
		errors: agents.filter((a) => a.status === "error").length,
	});

	for (const ws of _wsClientsAny) {
		try {
			ws.send(payload);
		} catch {
			/* ignore */
		}
	}
}

/** 建造者控制台扩展数据源（Phase5-C：服务集群 + 门控命中 + 编排图） */
export interface ConsoleExtras {
	stateStore?: StateStore;
	supervisor?: Supervisor;
	orchestrator?: Orchestrator;
	flowEngine?: FlowEngine;
}

export function startServer(
	port: number,
	registry: AgentRegistry,
	inbox: Inbox,
	sink: import("./sink").Sink,
	extras: ConsoleExtras = {},
): void {
	let prevSnapshot = "";
	setInterval(() => {
		broadcastState(registry);
		const agents = registry.peekAll();
		const snapshot = JSON.stringify(
			agents.map((a) => ({
				id: a.id.slice(-8),
				status: a.status,
				round: a.progress?.round,
			})),
		);
		if (snapshot !== prevSnapshot) {
			if (prevSnapshot !== "") {
				const prev = JSON.parse(prevSnapshot) as Array<{
					id: string;
					status: string;
					round: number;
				}>;
				const curr = JSON.parse(snapshot) as Array<{
					id: string;
					status: string;
					round: number;
				}>;
				for (const c of curr) {
					const p = prev.find((x) => x.id === c.id);
					if (!p) {
						pushEvent(`🚀 ${c.id} 已派出`);
					} else if (p.status !== c.status) {
						if (c.status === "done") {
							pushEvent(`✅ ${c.id} 已完成`);
						} else if (c.status === "error") {
							pushEvent(`❌ ${c.id} 出错`);
						}
					}
				}
			}
			prevSnapshot = snapshot;
		}
	}, 500);

	Bun.serve({
		port,
		async fetch(req, server) {
			const url = new URL(req.url);

			if (url.pathname === "/ws") {
				if (server.upgrade(req)) return;
				return new Response("WebSocket upgrade failed", { status: 426 });
			}

			if (url.pathname === "/api/state") {
				const agents = registry.peekAll();
				return new Response(
					JSON.stringify({
						agents: agents.map((a) => ({
							id: a.id.slice(-8),
							role: a.role,
							status: a.status,
							progress: a.progress,
							summary: a.summary,
						})),
						running: agents.filter((a) => a.status === "running").length,
						done: agents.filter((a) => a.status === "done").length,
						errors: agents.filter((a) => a.status === "error").length,
					}),
					{ headers: { "Content-Type": "application/json" } },
				);
			}

			if (url.pathname === "/api/services") {
				// 建造者控制台：服务集群健康 + 状态模型 + 门控命中
				return new Response(
					JSON.stringify({
						services: extras.supervisor?.getClusterStatus() ?? [],
						state: extras.stateStore?.getL1Summary() ?? "",
						gateHits: extras.orchestrator?.getGateHits() ?? [],
					}),
					{ headers: { "Content-Type": "application/json" } },
				);
			}

			if (url.pathname === "/api/flows") {
				// 建造者控制台：编排图（收编层动态生成，热加载后数据新鲜）
				const contracts = extras.supervisor?.listContracts() ?? [];
				const manifest = buildFlowManifest(contracts, loadNotifyRules());
				const validation = validateFlowManifest(manifest, contracts);
				return new Response(
					JSON.stringify({
						manifest,
						validation,
						flows: extras.flowEngine?.list() ?? [],
					}),
					{ headers: { "Content-Type": "application/json" } },
				);
			}

			if (url.pathname === "/api/events") {
				return new Response(JSON.stringify(_events.slice(-20)), {
					headers: { "Content-Type": "application/json" },
				});
			}

			if (url.pathname === "/api/conversation") {
				return new Response(JSON.stringify(_conversation), {
					headers: { "Content-Type": "application/json" },
				});
			}

			if (url.pathname === "/api/cmd" && req.method === "POST") {
				try {
					const cmd = await req.text();
					if (cmd.trim()) {
						inbox.push({
							type: "user_message",
							threadId: "main",
							timestamp: Date.now(),
							content: cmd.trim(),
						});
						sink.emit({
							kind: "notice",
							level: "info",
							text: `💡 Web: ${cmd.trim().slice(0, 120)}`,
						});
						const time = new Date().toLocaleTimeString("zh-CN", {
							hour12: false,
						});
						_events.push(`[${time}] 📨 ${cmd.trim().slice(0, 80)}`);
					}
				} catch {
					/* request body read failed */
				}
				return new Response("ok");
			}

			if (url.pathname === "/" || url.pathname === "/dashboard.html") {
				const html = Bun.file(`${import.meta.dir}/../dashboard.html`);
				return new Response(html, {
					headers: { "Content-Type": "text/html; charset=utf-8" },
				});
			}

			return new Response("Not Found", { status: 404 });
		},

		websocket: {
			open(ws) {
				_wsClientsAny.add(ws);
				const agents = registry.peekAll();
				ws.send(
					JSON.stringify({
						type: "state",
						agents: agents.map((a) => ({
							id: a.id.slice(-8),
							role: a.role,
							status: a.status,
							progress: a.progress,
							summary: a.summary,
						})),
						running: agents.filter((a) => a.status === "running").length,
						done: agents.filter((a) => a.status === "done").length,
						errors: agents.filter((a) => a.status === "error").length,
					}),
				);
			},
			close(ws) {
				_wsClientsAny.delete(ws);
			},
			message(_ws, message) {
				const text = typeof message === "string" ? message : "";
				if (text.startsWith("cmd:")) {
					const cmd = text.slice(4).trim();
					if (cmd) {
						inbox.push({
							type: "user_message",
							threadId: "main",
							timestamp: Date.now(),
							content: cmd,
						});
						sink.emit({
							kind: "notice",
							level: "info",
							text: `💡 Web: ${cmd.slice(0, 120)}`,
						});
						pushEvent(`📨 收到命令: ${cmd.slice(0, 80)}`);
					}
				}
			},
		},
	});
}
