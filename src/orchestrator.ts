import { AgentRegistry } from "./agent-registry";
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
import { Harness } from "./harness";
import { Inbox } from "./inbox";
import { callLLM } from "./llm";
import { saveDialogue } from "./memory";
import { buildSystemPrompt } from "./prompts";
import type { Sink } from "./sink";
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

	setSink(s: Sink): void {
		this.sink = s;
		this.harness.setSink(s);
	}

	private emit(e: { kind: string; [key: string]: unknown }): void {
		if (this.sink) this.sink.emit(e as never);
	}

	constructor(inbox?: Inbox, registry?: AgentRegistry, threadId?: string) {
		this.inbox = inbox ?? new Inbox();
		this.registry = registry ?? new AgentRegistry();
		this.currentThreadId = threadId ?? `thread-${Date.now().toString(36)}`;
		// 仅在显式传入时启用异步模式（daemon 模式），否则兼容同步 dispatch
		if (inbox && registry) {
			this.harness = new Harness(inbox, registry, this.currentThreadId);
		} else {
			this.harness = new Harness();
		}
	}

	/** 重置对话历史（chat 模式 "/clear" 命令调用） */
	resetConversation(): void {
		this.messages = [];
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

		// 每 10 轮做一次 registry 清理
		let cleanupCounter = 0;

		while (true) {
			if (this.inbox.isEmpty()) {
				await new Promise((r) => setTimeout(r, 1000));
				cleanupCounter++;
				if (cleanupCounter >= 10) {
					this.registry.cleanup();
					cleanupCounter = 0;
				}
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
		console.log(`\n${result}\n`);
		this.emit({ kind: "llm_response", text: result });
		process.stdout.write("> ");
	}

	/**
	 * 合并处理子 Agent 结果
	 *
	 * 将多个 agent 的完成结果一起注入给 LLM，让它有全局视野做决策。
	 */
	private async processAgentBatch(dones: AgentEvent[]): Promise<void> {
		const details = dones
			.map((d) => {
				const role = d.agentRole ?? "未知";
				const output = d.result?.output?.slice(0, 500) ?? "无输出";
				const id = d.agentId?.slice(-8) ?? "";
				const status = d.type === "agent_error" ? "❌ ERROR" : "✅ DONE";
				return `### ${status} [${role}] (${id})\n${output}`;
			})
			.join("\n\n---\n\n");

		const total = this.registry.size;
		const running = this.registry.getRunning().length;

		// 直接展示给用户，不依赖 LLM 合成
		console.log(`\n${"=".repeat(60)}`);
		console.log(
			`📬 子 Agent 完成通知 — ${dones.length} 个完成，${running} 个运行中，共 ${total} 个`,
		);
		console.log("=".repeat(60));
		console.log(details);
		console.log(`${"=".repeat(60)}\n`);

		const batchMsg = [
			`## 子 Agent 执行结果（${dones.length} 个完成，${running} 个仍在运行，共 ${total} 个）`,
			details,
			this.registry.getSnapshot(),
		].join("\n\n");

		milestone(`${dones.length} 个子 Agent 完成`);

		// 注入给 LLM，让它知晓结果
		this.messages.push({ role: "system", content: batchMsg });
		await saveDialogue("system", batchMsg);

		// 让 LLM 给出简要总结（而不是完整 reactLoop）
		const result = await this.reactLoop();
		if (result && !result.startsWith("任务未在限定轮次")) {
			console.log(`💬 ${result}\n`);
		}
		process.stdout.write("> ");
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
