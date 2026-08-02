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
		appendNotifyRule({ match: { eventType: "scan.done" }, action: "defer" });
		appendNotifyRule({
			match: { eventType: "opportunity.found", level: "notify" },
			action: "notify",
		});

		const rules = loadNotifyRules();
		expect(
			rules.some(
				(r) => r.match.eventType === "scan.done" && r.action === "defer",
			),
		).toBe(true);
		expect(
			rules.some(
				(r) =>
					r.match.eventType === "opportunity.found" && r.action === "notify",
			),
		).toBe(true);
	});

	test("旧值兼容：digest/show/drop 读回归一化为 defer/notify/archive", async () => {
		const { appendFileSync } = await import("node:fs");
		appendFileSync(
			RULES_FILE,
			'{"match":{"eventType":"old.digest"},"action":"digest"}\n',
		);
		appendFileSync(
			RULES_FILE,
			'{"match":{"eventType":"old.show"},"action":"show"}\n',
		);
		appendFileSync(
			RULES_FILE,
			'{"match":{"eventType":"old.drop"},"action":"drop"}\n',
		);

		const rules = loadNotifyRules();
		expect(rules.find((r) => r.match.eventType === "old.digest")?.action).toBe(
			"defer",
		);
		expect(rules.find((r) => r.match.eventType === "old.show")?.action).toBe(
			"notify",
		);
		expect(rules.find((r) => r.match.eventType === "old.drop")?.action).toBe(
			"archive",
		);
	});

	test("坏行忽略，不影响后续规则", async () => {
		const { appendFileSync } = await import("node:fs");
		appendFileSync(RULES_FILE, "{bad json}\n");
		appendFileSync(
			RULES_FILE,
			'{"match":{"eventType":"bad"},"action":"boom"}\n',
		);

		const rules = loadNotifyRules();
		expect(rules.length).toBeGreaterThanOrEqual(2); // 坏行被跳过，好规则仍在
		expect(rules.every((r) => r.match && r.action)).toBe(true);
	});
});
