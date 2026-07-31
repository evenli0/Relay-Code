/**
 * approvals.ts —— 批准点确认流（framework-design §9，Phase4-B）
 *
 * 声明 approval 的操作需用户批准：未批准 → 拒绝并提示；批准一次 →
 * 记忆化（.relay/approvals.jsonl），后续自动放行。
 * 文件即状态：daemon 写入，actor 进程每次读盘（小文件，无缓存陈旧问题）。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";

const APPROVALS_FILE = ".relay/approvals.jsonl";

interface ApprovalEntry {
	serviceId: string;
	tool: string;
	grantedAt: number;
}

/** 读取全部已批准条目（key: serviceId:tool） */
export function loadApprovals(): Map<string, number> {
	const map = new Map<string, number>();
	if (!existsSync(APPROVALS_FILE)) return map;
	for (const line of readFileSync(APPROVALS_FILE, "utf-8").split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		try {
			const entry = JSON.parse(trimmed) as ApprovalEntry;
			map.set(`${entry.serviceId}:${entry.tool}`, entry.grantedAt);
		} catch {
			/* 坏行忽略 */
		}
	}
	return map;
}

/** 批准一次（用户确认后记忆化） */
export function grantApproval(serviceId: string, tool: string): void {
	if (!existsSync(APPROVALS_FILE)) {
		mkdirSync(".relay", { recursive: true });
	}
	const entry: ApprovalEntry = {
		serviceId,
		tool,
		grantedAt: Date.now(),
	};
	appendFileSync(APPROVALS_FILE, `${JSON.stringify(entry)}\n`, "utf-8");
}
