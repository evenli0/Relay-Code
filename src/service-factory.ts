/**
 * service-factory.ts —— 服务生成器（framework-design §10，主 agent 创生）
 *
 * create_service 工具的落地：按固定骨架生成 services/<id>/ 目录
 * （service.json + entry.ts），契约校验通过即由 Supervisor 热部署。
 * 生成一致性：结构/命名/配置习惯固定——用户已定义的服务是未来的学习样本。
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { type ServiceContract, validateContract } from "./service-contract";

/** 最小协议服务骨架（心跳 + task/ask 指令处理） */
const ENTRY_TEMPLATE = [
	"/**",
	" * entry.ts —— 由 create_service 生成的最小协议服务骨架",
	" * 协议是唯一共性（framework-design §1）：会说话协议的脚本就是服务。",
	" * 扩展方式：按需处理 task/ask 指令、定期上报 state/event。",
	" */",
	"",
	"// 心跳：Supervisor 据此检测僵死",
	"setInterval(() => {",
	'\tprocess.stdout.write(JSON.stringify({ kind: "heartbeat", ts: Date.now() }) + "\\n");',
	"}, 30_000);",
	"",
	"// 指令处理：task → result / ask → reply",
	'process.stdin.on("data", (chunk) => {',
	'\tfor (const line of chunk.toString().split("\\n")) {',
	"\t\tconst t = line.trim();",
	"\t\tif (!t) continue;",
	"\t\ttry {",
	"\t\t\tconst cmd = JSON.parse(t);",
	'\t\t\tif (cmd.kind === "task") {',
	'\t\t\t\tprocess.stdout.write(JSON.stringify({ kind: "result", taskId: cmd.taskId, status: "completed", output: "骨架服务：任务已接收（业务逻辑待实现）" }) + "\\n");',
	"\t\t\t}",
	'\t\t\tif (cmd.kind === "ask") {',
	'\t\t\t\tprocess.stdout.write(JSON.stringify({ kind: "reply", requestId: cmd.requestId, content: "骨架服务：暂未配置对话能力" }) + "\\n");',
	"\t\t\t}",
	"\t\t} catch { /* 坏行忽略 */ }",
	"\t}",
	"});",
	"",
].join("\n");

export interface CreateServiceOptions {
	name: string;
	description: string;
	archetype: ServiceContract["archetype"];
	execution?: ServiceContract["execution"];
	tools?: string[];
	schedule?: ServiceContract["schedule"];
}

export function createServiceContract(
	opts: CreateServiceOptions,
): ServiceContract {
	const id = toKebab(opts.name);
	return {
		id,
		version: "1.0.0",
		name: opts.name,
		description: opts.description,
		archetype: opts.archetype,
		execution:
			opts.execution ?? (opts.archetype === "watcher" ? "watch" : "react"),
		entry: `services/${id}/entry.ts`,
		tools: opts.tools ?? ["read", "grep"],
		capabilities: [],
		emits: [],
		consumes: [],
		schedule: opts.schedule,
		permissions: {
			fs: ["read"],
			tools: opts.tools ?? ["read", "grep"],
			paths: [`services/${id}/data`],
		},
	};
}

/** 写 services/<id>/ 目录（service.json + entry.ts），返回校验结果 */
export function writeServiceFiles(
	contract: ServiceContract,
): { ok: true } | { ok: false; error: string } {
	const dir = `services/${contract.id}`;
	const v = validateContract(contract);
	if (!v.ok) return { ok: false, error: v.errors.join("; ") };
	try {
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(
			`${dir}/service.json`,
			`${JSON.stringify(contract, null, 2)}\n`,
			"utf-8",
		);
		writeFileSync(`${dir}/entry.ts`, ENTRY_TEMPLATE, "utf-8");
	} catch (e) {
		return { ok: false, error: String(e) };
	}
	return { ok: true };
}

/** 名称 → 小写连字符 id；非 ASCII 名称回退 svc- 前缀 */
function toKebab(name: string): string {
	const base = name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return base || `svc-${Date.now().toString(36)}`;
}
