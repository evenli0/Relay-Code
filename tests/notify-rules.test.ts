import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { appendNotifyRule, loadNotifyRules } from "../src/notify-rules";

const RULES_FILE = ".relay/notify-rules.jsonl";

afterAll(() => {
	try {
		rmSync(RULES_FILE, { force: true });
	} catch {
		/* ignore */
	}
});

describe("notify-rules 反馈沉淀（策略随使用变好）", () => {
	test("追加后能读回", () => {
		appendNotifyRule({ match: { eventType: "scan.done" }, action: "digest" });
		appendNotifyRule({
			match: { eventType: "opportunity.found", level: "notify" },
			action: "notify",
		});

		const rules = loadNotifyRules();
		expect(
			rules.some(
				(r) => r.match.eventType === "scan.done" && r.action === "digest",
			),
		).toBe(true);
		expect(
			rules.some(
				(r) =>
					r.match.eventType === "opportunity.found" && r.action === "notify",
			),
		).toBe(true);
	});

	test("坏行忽略，不影响后续规则", async () => {
		const { appendFileSync } = await import("node:fs");
		appendFileSync(RULES_FILE, "{bad json}\n");

		const rules = loadNotifyRules();
		expect(rules.length).toBeGreaterThanOrEqual(2); // 坏行被跳过，好规则仍在
		expect(rules.every((r) => r.match && r.action)).toBe(true);
	});
});
