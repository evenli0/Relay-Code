import type { ChatMessage, DispatchConfig } from "./types";

const SUB_AGENT_SYSTEM_PROMPT =
	"你是一个子Agent。输出是返回值，不是对话。不要道歉，不要问用户。";

/**
 * 将 DispatchConfig 转为子Agent 的 ChatMessage[]
 */
export async function assembleMessages(
	config: DispatchConfig,
): Promise<ChatMessage[]> {
	const messages: ChatMessage[] = [
		{ role: "system", content: SUB_AGENT_SYSTEM_PROMPT },
	];

	// 前缀：preload 文件
	for (const filePath of config.preload ?? []) {
		try {
			const file = Bun.file(filePath);
			const content = await file.text();
			messages.push({
				role: "system",
				content: `[上下文文件: ${filePath}]\n${content}`,
			});
		} catch {
			messages.push({
				role: "system",
				content: `[上下文文件: ${filePath}]\n（文件读取失败）`,
			});
		}
	}

	// 后缀：编排Agent 的 prompt
	let prompt = "";
	if (config.prompt.instructions) {
		messages.push({ role: "system", content: config.prompt.instructions });
	}
	if (config.prompt.role) prompt += `角色：${config.prompt.role}\n`;
	prompt += `任务：${config.prompt.task}\n`;

	// 如果指定了 responseSchema，注入标准字段 + 任务特定字段
	if (config.responseSchema) {
		const schema = config.responseSchema as Record<string, unknown>;
		const userProps =
			(schema.properties as Record<string, unknown> | undefined) ?? {};
		const STANDARD_FIELDS = new Set(["keyFindings", "decisions", "summary"]);
		const userFields = Object.entries(userProps)
			.filter(([k]) => !STANDARD_FIELDS.has(k))
			.map(([k, v]: [string, unknown]) => {
				const desc = (v as Record<string, unknown> | undefined)?.description;
				return `      "${k}": ${JSON.stringify(desc ?? `${k}的内容`)}`;
			})
			.join(",\n");
		const exampleJson = `{\n  "keyFindings": ["发现了 X 问题", "发现了 Y 问题"],\n  "decisions": ["决定做 A", "决定做 B"],\n  "summary": "一句话总结做了什么"${userFields ? `,\n${userFields}` : ""}\n}`;
		prompt += `\n输出纯 JSON，不要 markdown 代码块，不要额外文字。格式如下：\n${exampleJson}\n`;
	}

	// 如果指定了 plan，告诉子Agent 完整的阶段编排
	if (config.plan) {
		prompt += `\n[计划上下文]\n`;
		if (config.plan.goal) prompt += `总体目标：${config.plan.goal}\n`;
		if (config.plan.phases && config.plan.phases.length > 0) {
			prompt += `阶段编排：\n`;
			for (const phase of config.plan.phases) {
				prompt += `  → ${phase.name}：${phase.description}\n`;
			}
		}
	}

	messages.push({ role: "user", content: prompt });
	return messages;
}
