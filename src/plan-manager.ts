import type { ChatMessage } from "./types";

/**
 * PlanManager —— plan 注入管理
 *
 * 负责读取 plan.md 或 plans/current.md，注入执行规则，
 * 并跟踪已注入的内容避免重复。
 */
export class PlanManager {
	private injectedPlans: Set<string> = new Set();

	async getPlanMessages(): Promise<ChatMessage[]> {
		let planFile = Bun.file("plan.md");
		if (!(await planFile.exists())) {
			planFile = Bun.file("plans/current.md");
			if (!(await planFile.exists())) return [];
		}

		const content = await planFile.text();
		if (!content.trim() || content.includes("status: completed")) return [];

		const rules = [
			"执行规则：",
			"- 按阶段顺序执行，完成一个阶段后 write 更新 plan.md 状态",
			"- dispatch 给子Agent 的任务描述必须准确，不要编造代码细节（函数签名、文件路径等）",
			"- 子Agent 返回后检查其 keyFindings，判断是否合理。合理就继续，不合理就修正 plan 重试",
			'- dispatch 的 prompt 必须是 { task: "..." } 对象，不是字符串',
			"- 遇到障碍（文件不存在、任务失败），修改后续阶段调整路线",
			"- 同一阶段内多个 dispatch 可以在同一轮发出",
			"- 修改 plan 后用 write 保存，系统下次自动采用新版本",
		].join("\n");

		const fullContent = `[当前计划]\n${content}\n\n${rules}`;

		const key = fullContent.trim();
		if (this.injectedPlans.has(key)) return [];

		this.injectedPlans.add(key);
		return [{ role: "user" as const, content: fullContent }];
	}
}
