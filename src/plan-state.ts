/**
 * PlanState —— 结构化 Plan 状态机
 *
 * 解析 plan.md，跟踪各阶段状态，支持阶段推进和动态更新。
 * 替代 PlanManager 的内容哈希去重策略。
 */

export type PhaseStatus = "pending" | "running" | "completed" | "failed";

export interface Phase {
	name: string;
	description: string;
	status: PhaseStatus;
}

export class PlanState {
	phases: Phase[] = [];
	currentIndex = 0;
	contentHash = "";

	parse(content: string): void {
		this.contentHash = this.hash(content);
		this.phases = [];
		this.currentIndex = 0;

		const lines = content.split("\n");
		let currentPhase: Phase | null = null;

		for (const line of lines) {
			const phaseMatch = line.match(/^##\s*(?:阶段|Phase)\s*\d*\s*[：:]\s*(.+)/);
			if (phaseMatch) {
				if (currentPhase) this.phases.push(currentPhase);
				currentPhase = {
					name: phaseMatch[1]!.trim(),
					description: "",
					status: line.includes("✅") ? "completed" : line.includes("❌") ? "failed" : "pending",
				};
				continue;
			}

			if (currentPhase) {
				const taskMatch = line.match(/^\s*-\s*\[([ x])\]\s*(.+)/);
				if (taskMatch) {
					currentPhase.description += `${taskMatch[2]!.trim()} `;
				}
			}
		}
		if (currentPhase) this.phases.push(currentPhase);

		this.currentIndex = this.phases.findIndex(
			(p) => p.status === "pending" || p.status === "failed",
		);
		if (this.currentIndex < 0) this.currentIndex = this.phases.length - 1;
	}

	getPhaseDigest(): string {
		return this.phases
			.map((p, i) => `${i}:${p.status === "completed" ? "✅" : p.status === "failed" ? "❌" : p.status}`)
			.join(",");
	}

	render(): string {
		if (this.phases.length === 0) return "";
		let result = "";
		for (let i = 0; i < this.phases.length; i++) {
			const p = this.phases[i]!;
			const marker =
				p.status === "completed" ? "✅" : p.status === "failed" ? "❌" : i === this.currentIndex ? "▶️" : "⬜";
			result += `${marker} ${p.name}${p.description ? `：${p.description}` : ""}\n`;
		}
		return result;
	}

	advance(): void {
		if (this.currentIndex < this.phases.length) {
			this.phases[this.currentIndex]!.status = "completed";
			this.currentIndex++;
			if (this.currentIndex < this.phases.length) {
				this.phases[this.currentIndex]!.status = "running";
			}
		}
	}

	/** 检查是否所有阶段都已完成 */
	isCompleted(): boolean {
		return this.phases.length > 0 && this.phases.every((p) => p.status === "completed");
	}

	/** 获取状态键（与 getPhaseDigest 相同） */
	getStatusKey(): string {
		return this.getPhaseDigest();
	}

	/** 构造注入消息 */
	buildMessage(): import("./types").ChatMessage {
		const content = `[当前计划]\n${this.render()}\n\n执行规则：\n- 按阶段顺序执行\n- dispatch 给子Agent 的任务描述必须准确\n- 子Agent 返回后检查其 keyFindings\n- 遇到障碍修改 plan 后 write 保存，系统下次自动采用新版本`;
		return { role: "user" as const, content };
	}

	/** 从文件加载 */
	static async load(): Promise<PlanState | null> {
		let planFile = Bun.file("plan.md");
		if (!(await planFile.exists())) {
			planFile = Bun.file("plans/current.md");
			if (!(await planFile.exists())) return null;
		}
		const content = await planFile.text();
		if (!content.trim() || content.includes("status: completed")) return null;
		const state = new PlanState();
		state.parse(content);
		return state;
	}

	private hash(content: string): string {
		let h = 0;
		for (let i = 0; i < content.length; i++) {
			h = ((h << 5) - h) + content.charCodeAt(i);
			h |= 0;
		}
		return h.toString(36);
	}
}
