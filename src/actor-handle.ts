/**
 * actor-handle.ts —— 主进程侧的节点遥控器（ServiceRuntime 载体）
 *
 * 封装：
 *   - spawn 节点进程（永不退出的 stdin/stdout JSONL 进程，协议见 protocol.ts）
 *   - send() 发 ServiceCommand
 *   - readLoop() 持续读 stdout，分发到 pending promise 和 onEvent 回调
 *   - shutdown() 优雅关闭
 *
 * 演进说明（framework-design §3）：pending-promise 通道机制保留；
 * 心跳检测/退避重启归 Supervisor（Step B 接入）。
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import type { Subprocess } from "bun";
import {
	decodeServiceEvent,
	encodeServiceCommand,
	type ServiceCommand,
	type ServiceEvent,
} from "./protocol";
import type { DispatchConfig, SubAgentResult } from "./types";

const TASKS_DIR = ".relay/tasks";

export class ActorHandle {
	private proc: Subprocess;
	private pending = new Map<string, (event: ServiceEvent) => void>();
	public agentId: string;
	public onEvent?: (msg: ServiceEvent) => void;

	constructor(agentId: string, config: DispatchConfig) {
		this.agentId = agentId;

		// 写任务文件（actor.ts 读它初始化）
		if (!existsSync(TASKS_DIR)) {
			mkdirSync(TASKS_DIR, { recursive: true });
		}
		const taskPath = `${TASKS_DIR}/${agentId}.json`;
		writeFileSync(
			taskPath,
			JSON.stringify({ ...config, agentId }, null, 2),
			"utf-8",
		);

		// spawn 节点进程
		this.proc = Bun.spawn(["bun", "run", "src/actor.ts", taskPath], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "inherit",
		});

		this.proc.exited.then((exitCode) => {
			process.stderr.write(
				`[ActorHandle] ${agentId.slice(-8)} 进程退出 (exit=${exitCode})\n`,
			);
		});

		this.readLoop();
	}

	private async readLoop(): Promise<void> {
		const decoder = new TextDecoder();
		let buf = "";

		try {
			for await (const chunk of this.proc
				.stdout as ReadableStream<Uint8Array>) {
				buf += decoder.decode(chunk, { stream: true });
				// 按行分割处理
				const lines = buf.split("\n");
				buf = lines.pop() ?? ""; // 最后一段可能不完整，保留

				for (const line of lines) {
					const msg = decodeServiceEvent(line);
					if (!msg) {
						if (line.trim()) {
							process.stderr.write(
								`[ActorHandle] 无效事件: ${line.slice(0, 80)}\n`,
							);
						}
						continue;
					}

					// 匹配 pending promise（result / reply）
					if (msg.kind === "result") {
						const resolve = this.pending.get(msg.taskId);
						if (resolve) {
							resolve(msg);
							this.pending.delete(msg.taskId);
						}
					}
					if (msg.kind === "reply") {
						const resolve = this.pending.get(msg.requestId);
						if (resolve) {
							resolve(msg);
							this.pending.delete(msg.requestId);
						}
					}

					// 所有事件转发给外部监听者（→ registry/inbox → sink → web/cli）
					this.onEvent?.(msg);
				}
			}
		} catch (e) {
			process.stderr.write(`[ActorHandle] readLoop 异常: ${e}\n`);
		}
	}

	/** 主进程→节点：写一行 JSON 指令到 stdin */
	send(msg: ServiceCommand): void {
		if (this.proc.killed) {
			process.stderr.write(`[ActorHandle] 进程已终止，无法发送\n`);
			return;
		}
		try {
			(this.proc.stdin as unknown as Bun.FileSink).write(
				`${encodeServiceCommand(msg)}\n`,
			);
		} catch (e) {
			process.stderr.write(`[ActorHandle] stdin 写入失败: ${e}\n`);
		}
	}

	/** 发一个 task 并等待结果（兼容现有 dispatch 接口） */
	async dispatch(config: DispatchConfig): Promise<SubAgentResult> {
		const taskId = `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

		const promise = new Promise<ServiceEvent>((resolve) => {
			this.pending.set(taskId, resolve);
		});

		this.send({ kind: "task", taskId, content: config.prompt.task });

		const event = await promise;
		if (event.kind === "result") {
			return { status: event.status, output: event.output };
		}
		return { status: "error", output: "未收到 result 事件" };
	}

	/** 人类/main 直接问节点一个问题 */
	async ask(content: string, from: "human" | "main" = "main"): Promise<string> {
		const requestId = `ask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

		const promise = new Promise<ServiceEvent>((resolve) => {
			this.pending.set(requestId, resolve);
		});

		this.send({ kind: "ask", requestId, content, from });

		const event = await promise;
		return event.kind === "reply" ? event.content : "";
	}

	/** 运行时更换工具集 */
	configure(tools: string[]): void {
		this.send({ kind: "configure", tools });
	}

	/** 优雅关闭 */
	shutdown(): void {
		this.send({ kind: "shutdown", reason: "handle-shutdown" });
		// 5 秒后强制 kill
		setTimeout(() => {
			if (!this.proc.killed) {
				try {
					this.proc.kill();
				} catch {
					/* ignore */
				}
			}
		}, 5000);
	}
}
