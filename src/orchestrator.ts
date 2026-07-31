import { AgentRegistry } from "./agent-registry";
import type { Correlator } from "./correlator";
import {
	clearStatusLine,
	milestone,
	showPlan,
	startSpinner,
	statusLine,
	stopSpinner,
	toolResultLine,
} from "./display";
import { unwrapError } from "./errors";
import { FlowGate } from "./flow-gate";
import { Harness } from "./harness";
import { Inbox } from "./inbox";
import { callLLM } from "./llm";
import { saveDialogue } from "./memory";
import { buildSystemPrompt } from "./prompts";
import type { ServiceEvent } from "./protocol";
import type { Sink } from "./sink";
import type { StateStore } from "./state-store";
import type { Supervisor } from "./supervisor";
import { ALL_TOOLS } from "./tools";
import type { AgentEvent, ChatMessage, LLMResponse } from "./types";
import { MAX_REACT_ITERATIONS } from "./types";

/**
 * Orchestrator —— 主 Agent
 *
 * 两种模式：
 *   1. runReAct(input)  —— 单次同步执行（兼容旧 CLI）
 *   2. start()           —— 事件驱动循环（daemon 模式）
 *
 * 在 daemon 模式下：
 *   - 持续监听收件箱
 *   - User 指令优先，单独一轮处理
 *   - 子 Agent 结果合并一轮处理
 */
export class Orchestrator {
	private harness: Harness;
	private messages: ChatMessage[] = [];
	private inbox: Inbox;
	private registry: AgentRegistry;
	private currentThreadId: string;
	private sink: Sink | null = null;
	private gate: FlowGate;
	private digestQueue: AgentEvent[] = [];
	private stateStore?: StateStore;
	private correlator?: Correlator;
	private lastStateSummary = "";
	private lastCorrelationSummary = "";

	setSink(s: Sink): void {
		this.sink = s;
		this.harness.setSink(s);
	}

	private emit(e: { kind: string; [key: string]: unknown }): void {
		if (this.sink) this.sink.emit(e as never);
	}

	constructor(
		inbox?: Inbox,
		registry?: AgentRegistry,
		threadId?: string,
		gate?: FlowGate,
		stateStore?: StateStore,
		supervisor?: Supervisor,
		correlator?: Correlator,
	) {
		this.inbox = inbox ?? new Inbox();
		this.registry = registry ?? new AgentRegistry();
		this.gate = gate ?? new FlowGate();
		this.stateStore = stateStore;
		this.correlator = correlator;
		this.currentThreadId = threadId ?? `thread-${Date.now().toString(36)}`;
		// 仅在显式传入时启用异步模式（daemon 模式），否则兼容同步 dispatch
		if (inbox && registry) {
			this.harness = new Harness(inbox, registry, this.currentThreadId);
		} else {
			this.harness = new Harness();
		}
		if (stateStore) this.harness.setStateStore(stateStore);
		if (supervisor) this.harness.setSupervisor(supervisor);
	}

	/** 重置对话历史（chat 模式 "/clear" 命令调用） */
	resetConversation(): void {
		this.messages = [];
	}

	/** 运行时添加门控规则（用户反馈"这个别告诉我" → 沉淀 + 生效） */
	addGateRule(rule: import("./flow-gate").GateRule): void {
		this.gate.addRule(rule);
	}

	// ─── 事件驱动循环（daemon 模式）─────────────────────────────

	/**
	 * start —— 启动事件驱动循环
	 *
	 * 持续运行，每轮：
	 *   1. 检查收件箱
	 *   2. User 指令优先单独处理
	 *   3. 错误通知
	 *   4. 子 Agent 结果合并一轮处理
	 */
	async start(): Promise<void> {
		milestone("Relay-Code Agent 集群已启动");
		milestone(`Thread: ${this.currentThreadId}`);
		milestone("等待指令...\n");

		// 每 10 轮做一次 registry 清理；每 30s 吐一次静默摘要
		let cleanupCounter = 0;
		let tick = 0;

		while (true) {
			if (this.inbox.isEmpty()) {
				await new Promise((r) => setTimeout(r, 1000));
				cleanupCounter++;
				if (cleanupCounter >= 10) {
					this.registry.cleanup();
					cleanupCounter = 0;
				}
				if (++tick % 30 === 0) this.flushDigest();
				continue;
			}

			const events = this.inbox.drain();

			// 按优先级分类
			const userMsgs = events.filter((e) => e.type === "user_message");
			const agentErrors = events.filter((e) => e.type === "agent_error");
			const agentDones = events.filter((e) => e.type === "agent_done");

			// User 优先：单独一轮
			for (const msg of userMsgs) {
				await this.processUserMessage(msg);
			}

			// 错误：即时通知
			for (const err of agentErrors) {
				const tag = err.agentRole ? `[${err.agentRole}]` : "";
				process.stderr.write(
					`\n✗ ${tag} ${err.error?.slice(0, 200) ?? "未知错误"}\n`,
				);
			}

			// 子 Agent 完成：合并一轮
			if (agentDones.length > 0) {
				await this.processAgentBatch(agentDones);
			}

			// 清理
			cleanupCounter++;
			if (cleanupCounter >= 10) {
				this.registry.cleanup();
				cleanupCounter = 0;
			}
		}
	}

	// ─── 事件处理 ─────────────────────────────────────────────

	/**
	 * 处理一条 User 消息
	 *
	 * 注入 agent 集群状态到 system prompt，让 LLM 拥有全局视野。
	 */
	private async processUserMessage(event: AgentEvent): Promise<void> {
		const input = event.content ?? "";
		if (!input.trim()) return;

		// 用户开口前先吐出静默归档的摘要
		this.flushDigest();

		// 服务状态摘要（L1，变化去重注入——"知晓"的推送侧）
		this.injectStateSummary();

		// 关联候选（触发点 1：用户对话时注入，framework-design §8）
		this.injectCorrelation();

		const snapshot = this.registry.getSnapshot();

		// 首轮初始化 system prompt
		if (this.messages.length === 0) {
			let systemPrompt = buildSystemPrompt();
			if (snapshot) {
				systemPrompt += `\n\n${snapshot}\n[以上是当前运行中的子 Agent 状态，你可以据此决策]`;
			}
			this.messages.push({ role: "system", content: systemPrompt });
			await saveDialogue("system", systemPrompt);
		} else if (snapshot) {
			// 非首轮：追加当前集群状态
			this.messages.push({
				role: "system",
				content: `[集群状态更新]\n${snapshot}`,
			});
		}

		this.messages.push({ role: "user", content: input });
		await saveDialogue("user", input);

		// 标准 ReAct 循环
		const result = await this.reactLoop();
		this.emit({ kind: "llm_response", text: result });
		// prompt 已在 TerminalSink 中输出
	}

	/**
	 * 合并处理子 Agent 结果
	 *
	 * 将多个 agent 的完成结果一起注入给 LLM，让它有全局视野做决策。
	 */
	private async processAgentBatch(dones: AgentEvent[]): Promise<void> {
		const total = this.registry.size;
		const running = this.registry.getRunning().length;
		milestone(`${dones.length} 个子 Agent 完成`);

		// 纯代码调度：不再调用 LLM（framework-design §4，LLM 卸任）。
		// 门控规则决定每个事件的去向：show 展示 / digest 静默归档 / notify 通知出口 / drop 丢弃
		for (const d of dones) {
			const action = this.gate.decide(d);
			const role = d.agentRole ?? "未知";
			const id = d.agentId?.slice(-8) ?? "";

			switch (action) {
				case "show": {
					const output = d.result?.output?.slice(0, 500) ?? "无输出";
					const status = d.type === "agent_error" ? "❌ ERROR" : "✅ DONE";
					console.log(`\n### ${status} [${role}] (${id})\n${output}\n`);
					await saveDialogue(
						"system",
						`[子Agent结果|show] [${role}] ${output}`,
					);
					break;
				}
				case "notify": {
					// 通知出口：sink notice(notify) → WS/终端广播（server.ts 已订阅）
					const output = d.result?.output?.slice(0, 500) ?? "无输出";
					console.log(`\n🔔 [${role}] (${id})\n${output}\n`);
					this.emit({
						kind: "notice",
						level: "notify",
						text: `[${role}] ${output.slice(0, 200)}`,
					});
					await saveDialogue(
						"system",
						`[子Agent结果|notify] [${role}] ${output}`,
					);
					break;
				}
				case "digest": {
					this.digestQueue.push(d);
					await saveDialogue(
						"system",
						`[子Agent结果|digest] [${role}] ${d.result?.output?.slice(0, 200) ?? "无输出"}`,
					);
					break;
				}
				case "drop": {
					await saveDialogue("system", `[子Agent结果|drop] [${role}]`);
					break;
				}
			}
		}

		console.log(
			`📊 集群: ${dones.length} 个完成，${running} 个运行中，共 ${total} 个`,
		);
	}

	/** 关联候选注入：跨服务上下文关联（"你学的 X 赛道今天异动"） */
	private injectCorrelation(): void {
		if (!this.correlator) return;
		const summary = this.correlator.getCorrelationSummary();
		if (summary && summary !== this.lastCorrelationSummary) {
			this.lastCorrelationSummary = summary;
			this.messages.push({
				role: "system",
				content: `${summary}\n[关联候选：供你判断是否值得告知用户]`,
			});
		}
	}

	/** 服务状态注入：StateStore L1 摘要，变化才注入（防上下文膨胀） */
	private injectStateSummary(): void {
		if (!this.stateStore) return;
		const summary = this.stateStore.getL1Summary();
		if (summary && summary !== this.lastStateSummary) {
			this.lastStateSummary = summary;
			this.messages.push({
				role: "system",
				content: `[服务状态]\n${summary}\n[你可以据此回答用户关于服务状态的问题]`,
			});
		}
	}

	/**
	 * 服务事件入口（Supervisor.onNodeEvent 接入，Phase3-A）：
	 * 门控决策 + 分级语义映射——silent/trace 吸收、info 展示、notify 走通知出口，
	 * 用户规则（rule 命令）优先覆盖。
	 */
	handleServiceEvent(serviceId: string, event: ServiceEvent): void {
		if (event.kind !== "event") return; // state/heartbeat 进 StateStore，不进决策

		// 关联层：带实体的事件进候选池（规则预筛，framework-design §8）
		this.correlator?.ingest(serviceId, event.type, event.payload, event.ts);

		let action = this.gate.decide({
			type: "agent_done",
			threadId: this.currentThreadId,
			timestamp: event.ts,
			agentRole: serviceId,
			agentId: serviceId,
			level: event.level,
			eventType: event.type,
		} as AgentEvent);

		// 分级语义：门控默认"show"针对 agent_done；服务事件按 level 细化
		if (action === "show") {
			if (event.level === "silent" || event.level === "trace") {
				action = "digest";
			} else if (event.level === "notify") {
				action = "notify";
			}
		}

		const payload = formatPayload(event.payload);
		switch (action) {
			case "show":
				console.log(`\n### [${serviceId}] ${event.type}\n${payload}\n`);
				break;
			case "notify": {
				console.log(`\n🔔 [${serviceId}] ${event.type}\n${payload}\n`);
				this.emit({
					kind: "notice",
					level: "notify",
					text: `[${serviceId}] ${event.type}: ${payload.slice(0, 200)}`,
				});
				break;
			}
			case "digest":
				this.digestQueue.push({
					type: "agent_done",
					threadId: this.currentThreadId,
					timestamp: event.ts,
					agentRole: serviceId,
					level: event.level,
					eventType: event.type,
				} as AgentEvent);
				break;
			case "drop":
				break;
		}
	}

	/** 静默归档摘要：把 digest 队列合成一行输出（不占 LLM 上下文） */
	private flushDigest(): void {
		if (this.digestQueue.length === 0) return;
		const byRole = new Map<string, number>();
		for (const d of this.digestQueue) {
			const role = d.agentRole ?? "未知";
			byRole.set(role, (byRole.get(role) ?? 0) + 1);
		}
		const parts = [...byRole.entries()].map(([r, n]) => `${r}×${n}`).join(", ");
		console.log(
			`📥 摘要: ${this.digestQueue.length} 个子 Agent 结果已静默归档（${parts}）`,
		);
		this.digestQueue = [];
	}

	// ─── ReAct 循环（核心逻辑不变）────────────────────────────

	private async reactLoop(): Promise<string> {
		const overallStart = Date.now();
		startSpinner();

		let lastSnapshot = "";

		for (let i = 0; i < MAX_REACT_ITERATIONS; i++) {
			statusLine(
				i + 1,
				MAX_REACT_ITERATIONS,
				"思考中...",
				(Date.now() - overallStart) / 1000,
			);

			// 集群 HUD：只在状态变化时注入，去重避免上下文爆炸
			const snapshot = this.registry.getSnapshot();
			if (snapshot && snapshot !== lastSnapshot) {
				lastSnapshot = snapshot;
				this.messages.push({
					role: "system",
					content: `[集群状态]\n${snapshot}\n[你可以据此回答用户关于子 Agent 进度的问题]`,
				});
			}

			const planMessages = await this.harness.getPlanMessages();
			for (const pm of planMessages) {
				await saveDialogue("system", `[plan 注入]\n${pm.content}`);
				showPlan(pm.content ?? "");
			}
			this.messages.push(...planMessages);

			let response: LLMResponse;
			try {
				response = await callLLM(this.messages, ALL_TOOLS);
			} catch (e: unknown) {
				const err = unwrapError(e);
				if (e instanceof DOMException && e.name === "AbortError") {
					await saveDialogue(
						"assistant",
						`[错误] LLM 调用超时: ${err.message}`,
					);
					clearStatusLine();
					milestone("LLM 调用超时，2s 后重试");
					await new Promise((r) => setTimeout(r, 2000));
					continue;
				}
				const msg = err.message ?? "";
				if (
					msg.includes("DEEPSEEK_API_KEY") ||
					msg.includes("API key") ||
					msg.includes("API_KEY") ||
					msg.includes("认证失败")
				) {
					stopSpinner();
					clearStatusLine();
					const hint =
						"请设置 DEEPSEEK_API_KEY 环境变量后重试。获取地址: https://platform.deepseek.com";
					await saveDialogue("assistant", `[配置错误] ${hint}`);
					process.stderr.write(`\n❌ 配置错误: ${hint}\n`);
					return `配置错误: ${hint}`;
				}
				await saveDialogue(
					"assistant",
					`[错误] LLM 调用异常: ${err.message ?? e}`,
				);
				clearStatusLine();
				milestone("LLM 调用异常，1s 后重试");
				await new Promise((r) => setTimeout(r, 1000));
				continue;
			}

			if (!response.tool_calls || response.tool_calls.length === 0) {
				stopSpinner();
				clearStatusLine();
				statusLine(
					i + 1,
					MAX_REACT_ITERATIONS,
					"完成",
					(Date.now() - overallStart) / 1000,
				);
				this.messages.push({
					role: "assistant",
					content: response.content ?? "",
				});
				await saveDialogue("assistant", response.content ?? "");
				return response.content ?? "";
			}

			const parsed = response.tool_calls.map((tc) => {
				let args: Record<string, unknown> = {};
				try {
					args = JSON.parse(tc.function.arguments);
				} catch {
					args = {};
				}
				// 诊断日志：捕获主 Agent tool call 原始参数
				const rawArgs = tc.function.arguments;
				process.stderr.write(`[主Agent诊断|${tc.function.name}] ${rawArgs}\n`);
				return { tc, args };
			});

			const actions = parsed.map(({ tc, args }) => {
				if (tc.function.name === "dispatch") {
					const prompt = args.prompt as Record<string, unknown> | undefined;
					const task = typeof prompt?.task === "string" ? prompt.task : "";
					return `dispatch: ${task.substring(0, 50)}`;
				}
				return tc.function.name;
			});
			clearStatusLine();
			statusLine(
				i + 1,
				MAX_REACT_ITERATIONS,
				actions.join(" + "),
				(Date.now() - overallStart) / 1000,
			);

			const results = await Promise.all(
				parsed.map(async ({ tc, args }) => {
					const t0 = Date.now();
					const result = await this.harness.executeToolCall(
						tc.function.name,
						args,
					);
					const summary =
						result.length > 60 ? `${result.substring(0, 60)}...` : result;
					toolResultLine(tc.function.name, true, summary, Date.now() - t0);
					return result;
				}),
			);

			for (let ti = 0; ti < parsed.length; ti++) {
				const entry = parsed[ti];
				if (!entry) continue;
				const { tc } = entry;
				this.messages.push({
					role: "assistant",
					content: null,
					tool_calls: [tc],
					reasoning_content: response.reasoning_content ?? null,
				});
				this.messages.push({
					role: "tool",
					content: results[ti] ?? "",
					tool_call_id: tc.id,
				});
				await saveDialogue(
					"assistant",
					`[工具调用] ${tc.function.name}: ${tc.function.arguments}`,
				);
				await saveDialogue("tool", `[结果] ${results[ti] ?? ""}`);
			}
		}

		stopSpinner();
		await saveDialogue(
			"assistant",
			"任务未在限定轮次内完成，请尝试简化指令后重试。",
		);
		return "任务未在限定轮次内完成，请尝试简化指令后重试。";
	}

	// ─── 兼容旧 API ───────────────────────────────────────────

	/**
	 * runReAct —— 单次同步执行（兼容旧 CLI 的 --chat 和单次模式）
	 *
	 * 在内部仍使用事件机制，但阻塞等待本轮 ReAct 完成。
	 */
	async runReAct(userInput: string): Promise<string> {
		// 同步模式下，直接推入收件箱并阻塞处理
		this.inbox.push({
			type: "user_message",
			threadId: this.currentThreadId,
			timestamp: Date.now(),
			content: userInput,
		});

		// 取刚推入的事件并处理
		const events = this.inbox.drain();
		const userMsgs = events.filter((e) => e.type === "user_message");
		const agentDones = events.filter((e) => e.type === "agent_done");
		const agentErrors = events.filter((e) => e.type === "agent_error");

		// 先处理已有的 agent 结果（如果有）
		for (const err of agentErrors) {
			process.stderr.write(
				`\n✗ ${err.agentRole}: ${err.error?.slice(0, 200)}\n`,
			);
		}
		if (agentDones.length > 0) {
			await this.processAgentBatch(agentDones);
		}

		// 用户开口前先吐出静默归档摘要
		this.flushDigest();

		// 处理 User 消息（主要逻辑）
		for (const msg of userMsgs) {
			return await this.processUserMessageAndWait(msg);
		}

		return "";
	}

	/** processUserMessage + 同步等待 LLM 返回结果（不返回控制权直到 ReAct 完成） */
	private async processUserMessageAndWait(event: AgentEvent): Promise<string> {
		const input = event.content ?? "";
		if (!input.trim()) return "";

		const snapshot = this.registry.getSnapshot();

		// 关联候选（触发点 1：同步路径同样注入）
		this.injectCorrelation();

		if (this.messages.length === 0) {
			let systemPrompt = buildSystemPrompt();
			if (snapshot) {
				systemPrompt += `\n\n${snapshot}\n[以上是当前运行中的子 Agent 状态]`;
			}
			this.messages.push({ role: "system", content: systemPrompt });
			await saveDialogue("system", systemPrompt);
		} else if (snapshot) {
			this.messages.push({
				role: "system",
				content: `[集群状态]\n${snapshot}`,
			});
		}

		this.messages.push({ role: "user", content: input });
		await saveDialogue("user", input);

		return this.reactLoop();
	}
}

/** 服务事件 payload 展示格式化 */
function formatPayload(payload: unknown): string {
	if (payload === undefined) return "";
	try {
		return JSON.stringify(payload);
	} catch {
		return String(payload);
	}
}
