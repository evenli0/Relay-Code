import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { grantApproval } from "../src/approvals";
import { ToolExecutor } from "../src/tool-executor";

const APPROVALS_FILE = ".relay/approvals.jsonl";

afterAll(() => {
	try {
		rmSync(APPROVALS_FILE, { force: true });
	} catch {
		/* ignore */
	}
});

describe("ToolExecutor 权限 enforcement", () => {
	test("无权限声明 = 不限制（旧路径兼容）", async () => {
		const ex = new ToolExecutor();
		const r = await ex.executeToolCall("bash", { command: "echo hi" });
		expect(r).toContain("hi");
	});

	test("工具白名单拒绝（bash 默认禁用）", async () => {
		const ex = new ToolExecutor();
		ex.setPermissions({ tools: ["read", "grep"] });
		const r = await ex.executeToolCall("bash", { command: "echo hi" });
		expect(r).toContain("权限拒绝");
		expect(r).toContain("bash");
	});

	test("dispatch 默认不在白名单（服务节点无权派生子代理）", async () => {
		const ex = new ToolExecutor();
		ex.setPermissions({ tools: ["read"] });
		const r = await ex.executeToolCall("dispatch", {
			task: "子任务",
		} as never);
		expect(r).toContain("权限拒绝");
	});

	test("白名单内工具放行", async () => {
		const ex = new ToolExecutor();
		ex.setPermissions({ tools: ["read"], paths: ["docs"] });
		const r = await ex.executeToolCall("read", {
			path: "docs/framework-design.md",
		});
		expect(r).not.toContain("权限拒绝");
	});

	test("路径越界拒绝（绝对路径 / 逃逸相对路径）", async () => {
		const ex = new ToolExecutor();
		ex.setPermissions({ tools: ["read"], paths: ["docs"] });
		expect(
			await ex.executeToolCall("read", { path: "../secret.txt" }),
		).toContain("权限拒绝");
		expect(
			await ex.executeToolCall("read", { path: "C:/Windows/win.ini" }),
		).toContain("权限拒绝");
		expect(
			await ex.executeToolCall("read", { path: "docs/design.md" }),
		).not.toContain("权限拒绝");
	});

	test("未声明路径白名单时只允许相对路径", async () => {
		const ex = new ToolExecutor();
		ex.setPermissions({ tools: ["read"] });
		expect(
			await ex.executeToolCall("read", { path: "README.md" }),
		).not.toContain("权限拒绝");
		expect(
			await ex.executeToolCall("read", { path: "../outside.txt" }),
		).toContain("权限拒绝");
	});

	test("批准点：未批准拒绝，批准后放行（按服务隔离）", async () => {
		const ex = new ToolExecutor();
		ex.serviceId = "svc-a";
		ex.setPermissions({ tools: ["bash", "read"], approval: ["bash"] });

		// 未批准 → 拒绝并提示
		const denied = await ex.executeToolCall("bash", { command: "echo hi" });
		expect(denied).toContain("批准");

		// 批准 svc-a 的 bash → 放行（记忆化）
		grantApproval("svc-a", "bash");
		const allowed = await ex.executeToolCall("bash", { command: "echo hi" });
		expect(allowed).toContain("hi");

		// 其他服务未批准 → 仍拒绝（按服务隔离）
		ex.serviceId = "svc-b";
		expect(await ex.executeToolCall("bash", { command: "echo hi" })).toContain(
			"批准",
		);
	});
});
