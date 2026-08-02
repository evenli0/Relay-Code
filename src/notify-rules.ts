/**
 * notify-rules.ts —— 通知规则反馈沉淀（framework-design §4.3）
 *
 * 用户反馈（"这个别告诉我" / "这个要立刻说"）沉淀为规则文件，
 * 策略随使用变好。文件：.relay/notify-rules.jsonl，每行一条 GateRule。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { type GateRule, normalizeDisposition } from "./flow-gate";

const RULES_FILE = ".relay/notify-rules.jsonl";

/** 读取全部沉淀规则（坏行忽略；旧值 show/digest/drop 归一化为新处置） */
export function loadNotifyRules(): GateRule[] {
	if (!existsSync(RULES_FILE)) return [];
	const rules: GateRule[] = [];
	for (const line of readFileSync(RULES_FILE, "utf-8").split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		try {
			const parsed = JSON.parse(trimmed) as {
				match?: unknown;
				action?: unknown;
			};
			// 旧值兼容：show→notify / digest→defer / drop→archive；无效处置整条忽略
			const action =
				typeof parsed.action === "string"
					? normalizeDisposition(parsed.action)
					: null;
			if (
				!action ||
				typeof parsed.match !== "object" ||
				parsed.match === null
			) {
				continue;
			}
			rules.push({ match: parsed.match as GateRule["match"], action });
		} catch {
			/* 坏规则忽略 */
		}
	}
	return rules;
}

/** 追加一条规则（用户反馈 → 策略沉淀） */
export function appendNotifyRule(rule: GateRule): void {
	if (!existsSync(RULES_FILE)) {
		mkdirSync(".relay", { recursive: true });
	}
	appendFileSync(RULES_FILE, `${JSON.stringify(rule)}\n`, "utf-8");
}
