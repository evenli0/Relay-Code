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
import type { Inbox } from "./inbox";

const _events: string[] = [];
const _wsClientsAny = new Set<{ send(data: string): void }>();

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

export function startServer(
	port: number,
	registry: AgentRegistry,
	inbox: Inbox,
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
		fetch(req, server) {
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

			if (url.pathname === "/api/events") {
				return new Response(JSON.stringify(_events.slice(-20)), {
					headers: { "Content-Type": "application/json" },
				});
			}

			if (url.pathname === "/api/cmd" && req.method === "POST") {
				req.text().then((cmd) => {
					if (cmd.trim()) {
						inbox.push({
							type: "user_message",
							threadId: "main",
							timestamp: Date.now(),
							content: cmd.trim(),
						});
						pushEvent(`📨 收到命令: ${cmd.trim().slice(0, 80)}`);
					}
				});
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
						pushEvent(`📨 收到命令: ${cmd.slice(0, 80)}`);
					}
				}
			},
		},
	});
}
