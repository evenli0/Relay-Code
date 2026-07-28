import { arch, cwd, platform } from "node:process";
import type { ChatMessage, DispatchConfig } from "./types";

const SUB_AGENT_SYSTEM_PROMPT = [
	"你是一个子 Agent。你有 read/write/grep/bash 工具，可以自由使用它们完成任务。",
	`环境: ${platform === "win32" ? "Windows" : platform} ${arch}, 工作目录 ${cwd()}`,
	"",
	"工作方式：",
	"  1. 用工具完成你的分析/编辑任务（读写文件、搜索、执行命令都可以）。",
	"  2. 全部完成后，不要再调任何工具，直接回复一段 JSON 作为工作汇报。",
	"",
	"汇报格式：使用任务描述中指定的 JSON schema。这就是你的最终交付物。",
].join("\n");

/**
 * 将 DispatchConfig 转为子Agent 的 ChatMessage[]
 */
export async function assembleMessages(
	config: DispatchConfig,
): Promise<ChatMessage[]> {
	const messages: ChatMessage[] = [
		{ role: "system", content: SUB_AGENT_SYSTEM_PROMPT },
	];

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

	let prompt = "";
	if (config.prompt.instructions) {
		messages.push({ role: "system", content: config.prompt.instructions });
	}
	if (config.prompt.role) prompt += `角色：${config.prompt.role}\n`;
	prompt += `任务：${config.prompt.task}\n`;

	if (config.responseSchema) {
		const schema = config.responseSchema as Record<string, unknown>;
		const userProps =
			(schema.properties as Record<string, unknown> | undefined) ?? {};
		// 从实际 responseSchema 生成 example JSON，不硬编码字段
		const fieldEntries = Object.entries(userProps).map(
			([k, v]: [string, unknown]) => {
				const desc =
					(v as Record<string, unknown> | undefined)?.description ?? "";
				return { key: k, desc };
			},
		);
		if (fieldEntries.length > 0) {
			const exampleLines = fieldEntries.map(
				(f) => `  "${f.key}": ${JSON.stringify(f.desc || `${f.key}的内容`)}`,
			);
			const exampleJson = `{\n${exampleLines.join(",\n")}\n}`;
			prompt += `\n全部工作完成后，最后回复一段 JSON 作为汇报。格式如下（不要 markdown 代码块）：\n${exampleJson}\n`;
		} else {
			prompt += `\n全部工作完成后，最后回复一段 JSON 作为汇报。格式：{"result": "你的工作总结"}\n`;
		}
	}

	if (config.plan) {
		prompt += `\n[计划上下文]\n`;
		if (config.plan.goal) prompt += `总体目标：${config.plan.goal}\n`;
		if (config.plan.phases?.length) {
			prompt += `阶段编排：\n`;
			for (const phase of config.plan.phases) {
				prompt += `  → ${phase.name}：${phase.description}\n`;
			}
		}
	}

	messages.push({ role: "user", content: prompt });
	return messages;
}
