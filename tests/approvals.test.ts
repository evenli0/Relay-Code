import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { grantApproval, loadApprovals } from "../src/approvals";

const FILE = ".relay/approvals.jsonl";

afterAll(() => {
	try {
		rmSync(FILE, { force: true });
	} catch {
		/* ignore */
	}
});

describe("approvals 批准点确认流", () => {
	test("grant 后 load 可见（记忆化 + 按服务隔离）", () => {
		grantApproval("svc-a", "bash");
		const approvals = loadApprovals();
		expect(approvals.has("svc-a:bash")).toBe(true);
		expect(approvals.has("svc-b:bash")).toBe(false);
	});

	test("坏行忽略，不影响已有批准", async () => {
		const { appendFileSync } = await import("node:fs");
		appendFileSync(FILE, "{bad json}\n");
		const approvals = loadApprovals();
		expect(approvals.has("svc-a:bash")).toBe(true);
	});
});
