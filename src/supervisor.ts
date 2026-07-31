/**
 * supervisor.ts —— 生命周期管理（framework-design §3）
 *
 * 节点进程是"被管理的"，不是"自管理的"：
 *   - 心跳检测：超时无心跳 → 判僵死 → kill → 重启
 *   - 崩溃重启：指数退避 backoffBaseMs×2^n，连续失败超限 → 标记 error
 *   - 优雅关停：shutdown → 5s 超时强杀（ActorHandle 内实现）
 *   - 启动恢复：按 services/ 目录契约批量拉起
 *
 * 依赖：ActorHandle（ServiceRuntime 载体）；事件转发给 onNodeEvent（Step C 接 EventBus）。
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { ActorHandle } from "./actor-handle";
import type { ServiceEvent } from "./protocol";
import type { Scheduler } from "./scheduler";
import { type ServiceContract, validateContract } from "./service-contract";
import type { DispatchConfig } from "./types";

interface SupervisedNode {
	id: string;
	contract: ServiceContract;
	handle: ActorHandle | null;
	configOverride?: Partial<DispatchConfig>;
	status: "running" | "error" | "stopped";
	startedAt: number;
	lastHeartbeat: number | null;
	restartCount: number;
	consecutiveFailures: number;
	stopped: boolean;
	restartTimer: ReturnType<typeof setTimeout> | null;
}

export interface SupervisorOptions {
	heartbeatTimeoutMs?: number;
	maxConsecutiveFailures?: number;
	watchdogIntervalMs?: number;
	backoffBaseMs?: number;
	logger?: (msg: string) => void;
	/** 节奏调度器：契约 schedule → 到点向节点发 schedule 指令（framework-design §7） */
	scheduler?: Scheduler;
}

const DEFAULT_OPTS: Required<Omit<SupervisorOptions, "logger" | "scheduler">> =
	{
		heartbeatTimeoutMs: 60_000,
		maxConsecutiveFailures: 5,
		watchdogIntervalMs: 5_000,
		backoffBaseMs: 1_000,
	};

const MAX_BACKOFF_MS = 300_000;

export class Supervisor {
	private nodes = new Map<string, SupervisedNode>();
	private opts: Required<Omit<SupervisorOptions, "logger" | "scheduler">>;
	private logger: (msg: string) => void;
	private watchdog: ReturnType<typeof setInterval> | null = null;
	private scheduler?: Scheduler;

	/** 节点事件转发（→ StateStore / EventBus） */
	public onNodeEvent?: (id: string, msg: ServiceEvent) => void;

	constructor(options: SupervisorOptions = {}) {
		this.opts = { ...DEFAULT_OPTS, ...options };
		this.logger =
			options.logger ??
			((msg) => process.stderr.write(`[Supervisor] ${msg}\n`));
		this.scheduler = options.scheduler;
	}

	/** 启动一个服务节点（已存在则忽略） */
	start(
		contract: ServiceContract,
		configOverride?: Partial<DispatchConfig>,
	): string {
		const id = contract.id;
		if (this.nodes.has(id)) {
			this.logger(`${id} 已在运行`);
			return id;
		}

		const node: SupervisedNode = {
			id,
			contract,
			handle: null,
			configOverride,
			status: "running",
			startedAt: Date.now(),
			lastHeartbeat: null,
			restartCount: 0,
			consecutiveFailures: 0,
			stopped: false,
			restartTimer: null,
		};
		node.handle = this.spawn(node, configOverride);
		this.nodes.set(id, node);
		this.ensureWatchdog();

		// 契约 schedule → Scheduler 到点发 schedule 指令（时间轴推进）
		const schedule = contract.schedule;
		if (this.scheduler && schedule) {
			this.scheduler.register(id, schedule, () => {
				node.handle?.send({ kind: "schedule", spec: schedule });
			});
		}
		return id;
	}

	private spawn(
		node: SupervisedNode,
		configOverride?: Partial<DispatchConfig>,
	): ActorHandle {
		const handle = new ActorHandle(
			node.id,
			{ ...buildDispatchConfigFromContract(node.contract), ...configOverride },
			node.contract.entry,
		);
		handle.onEvent = (msg) => {
			if (msg.kind === "heartbeat") {
				node.lastHeartbeat = msg.ts;
				// 心跳到达 = 存活：清零失败计数
				if (node.consecutiveFailures > 0) {
					node.consecutiveFailures = 0;
					node.status = "running";
				}
			}
			this.onNodeEvent?.(node.id, msg);
		};
		handle.onExit = (exitCode) => this.onExit(node, exitCode);
		return handle;
	}

	private onExit(node: SupervisedNode, exitCode: number): void {
		if (node.stopped) {
			node.status = "stopped";
			return;
		}
		node.consecutiveFailures++;
		node.restartCount++;

		if (node.consecutiveFailures >= this.opts.maxConsecutiveFailures) {
			node.status = "error";
			this.logger(
				`${node.id} 连续 ${this.opts.maxConsecutiveFailures} 次失败（exit=${exitCode}），标记 error，不再重启`,
			);
			return;
		}

		const delay = Math.min(
			this.opts.backoffBaseMs * 2 ** (node.consecutiveFailures - 1),
			MAX_BACKOFF_MS,
		);
		this.logger(
			`${node.id} 退出（exit=${exitCode}），${delay}ms 后重启（第 ${node.consecutiveFailures}/${this.opts.maxConsecutiveFailures} 次失败）`,
		);
		node.restartTimer = setTimeout(() => {
			node.restartTimer = null;
			if (node.stopped) return;
			node.handle = this.spawn(node, node.configOverride);
		}, delay);
	}

	/** 主动停止（不触发重启） */
	stop(id: string, reason: string): void {
		const node = this.nodes.get(id);
		if (!node) return;
		node.stopped = true;
		if (node.restartTimer) clearTimeout(node.restartTimer);
		this.scheduler?.unregister(id);
		node.handle?.shutdown();
		node.status = "stopped";
		this.logger(`${id} 停止（${reason}）`);
	}

	stopAll(reason = "shutdown-all"): void {
		for (const id of [...this.nodes.keys()]) this.stop(id, reason);
		if (this.watchdog) clearInterval(this.watchdog);
		this.watchdog = null;
	}

	getStatus(id: string):
		| {
				status: string;
				restartCount: number;
				lastHeartbeat: number | null;
		  }
		| undefined {
		const n = this.nodes.get(id);
		if (!n) return undefined;
		return {
			status: n.status,
			restartCount: n.restartCount,
			lastHeartbeat: n.lastHeartbeat,
		};
	}

	/** 启动恢复：扫描 services/ 目录，按契约批量拉起 */
	restore(): string[] {
		if (!existsSync("services")) return [];
		const ids: string[] = [];
		for (const entry of readdirSync("services", { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const path = `services/${entry.name}/service.json`;
			if (!existsSync(path)) continue;
			let raw: unknown;
			try {
				raw = JSON.parse(readFileSync(path, "utf-8"));
			} catch {
				this.logger(`服务 ${entry.name} 的 service.json 解析失败，跳过`);
				continue;
			}
			const v = validateContract(raw);
			if (!v.ok) {
				this.logger(`服务 ${entry.name} 契约无效: ${v.errors.join("; ")}`);
				continue;
			}
			this.start(v.contract);
			ids.push(v.contract.id);
		}
		return ids;
	}

	private ensureWatchdog(): void {
		if (this.watchdog) return;
		this.watchdog = setInterval(() => {
			const now = Date.now();
			for (const node of this.nodes.values()) {
				if (node.stopped || node.status !== "running") continue;
				const lastBeat = node.lastHeartbeat ?? node.startedAt;
				if (now - lastBeat > this.opts.heartbeatTimeoutMs) {
					this.logger(
						`${node.id} 心跳超时（${now - lastBeat}ms 无心跳），判定僵死，kill 重启`,
					);
					node.handle?.kill();
				}
			}
		}, this.opts.watchdogIntervalMs);
	}
}

/** 临时适配：Step C 后由契约直接驱动（dispatch → send_to_service） */
function buildDispatchConfigFromContract(
	contract: ServiceContract,
): DispatchConfig {
	return {
		prompt: {
			task: `常驻服务 ${contract.name}（${contract.id}）`,
			role: contract.name,
		},
		allowed_tools: contract.permissions.tools ?? contract.tools,
		permissions: contract.permissions, // 下发到节点进程，ToolExecutor 强制执行
		responseSchema: {
			type: "object",
			properties: { result: { type: "string" } },
		},
		max_rounds: 30,
	};
}
