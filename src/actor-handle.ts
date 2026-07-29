/**
 * actor-handle.ts —— 父进程侧的 Actor 遥控器
 *
 * 封装：
 *   - spawn Actor 子进程（永不退出的 stdin/stdout JSONL 进程）
 *   - send() 发消息给 Actor
 *   - readLoop() 持续读 stdout，分发到 pending promise 和 onOutput 回调
 *   - shutdown() 优雅关闭
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import type { Subprocess } from "bun";
import type { ActorInput, ActorOutput } from "./actor";
import type { DispatchConfig, SubAgentResult } from "./types";

const TASKS_DIR = ".relay/tasks";

export class ActorHandle {
	private proc: Subprocess;
	private pending = new Map<string, (result: ActorOutput) => void>();
	public agentId: string;
	public onOutput?: (msg: ActorOutput) => void;

	constructor(agentId: string, config: DispatchConfig) {
		this.agentId = agentId;

		// 写任务文件（复用现有格式，actor.ts 读它初始化）
		if (!existsSync(TASKS_DIR)) {
			mkdirSync(TASKS_DIR, { recursive: true });
		}
		const taskPath = `${TASKS_DIR}/${agentId}.json`;
		writeFileSync(
			taskPath,
			JSON.stringify({ ...config, agentId }, null, 2),
			"utf-8",
		);

		// spawn Actor 进程
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

		// 启动 stdout 读取循环
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
					const trimmed = line.trim();
					if (!trimmed) continue;

					let msg: ActorOutput;
					try {
						msg = JSON.parse(trimmed) as ActorOutput;
					} catch {
						process.stderr.write(
							`[ActorHandle] 无效 JSON: ${trimmed.slice(0, 80)}\n`,
						);
						continue;
					}

					// 匹配 pending promise（task_done / task_error）
					if (msg.kind === "task_done" || msg.kind === "task_error") {
						const resolve = this.pending.get(msg.taskId);
						if (resolve) {
							resolve(msg);
							this.pending.delete(msg.taskId);
						}
					}

					// 所有消息转发给外部监听者（→ sink → web/cli）
					this.onOutput?.(msg);
				}
			}
		} catch (e) {
			process.stderr.write(`[ActorHandle] readLoop 异常: ${e}\n`);
		}
	}

	/** 父→子：写一行 JSON 到 Actor 的 stdin */
	send(msg: ActorInput): void {
		if (this.proc.killed) {
			process.stderr.write(`[ActorHandle] 进程已终止，无法发送\n`);
			return;
		}
		try {
			(this.proc.stdin as unknown as Bun.FileSink).write(
				`${JSON.stringify(msg)}\n`,
			);
		} catch (e) {
			process.stderr.write(`[ActorHandle] stdin 写入失败: ${e}\n`);
		}
	}

	/** 发一个 task 并等待结果（兼容现有 dispatch 接口） */
	async dispatch(config: DispatchConfig): Promise<SubAgentResult> {
		const taskId = `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

		const promise = new Promise<ActorOutput>((resolve) => {
			this.pending.set(taskId, resolve);
		});

		this.send({ kind: "task", taskId, content: config.prompt.task });

		const result = await promise;
		if (result.kind === "task_done") {
			return { status: "completed", output: result.output };
		}
		return {
			status: "error",
			output:
				(result as { kind: "task_error"; error: string }).error || "未知错误",
		};
	}

	/** 人类/main 直接问 Actor 一个问题 */
	async ask(content: string, from: "human" | "main" = "main"): Promise<string> {
		const askId = `ask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

		const promise = new Promise<ActorOutput>((resolve) => {
			this.pending.set(askId, resolve);
		});

		this.send({ kind: "ask", askId, from, content });

		const result = await promise;
		return result.kind === "ask_reply" ? result.content : "";
	}

	/** 运行时更换工具集 */
	configure(tools: string[]): void {
		this.send({ kind: "configure", tools });
	}

	/** 优雅关闭 */
	shutdown(): void {
		this.send({ kind: "shutdown" });
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
