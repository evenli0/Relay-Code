import { describe, expect, test } from "bun:test";
import { ToolExecutor } from "../src/tool-executor";

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

	test("批准点：声明为需确认的操作一律拒绝（Phase 4 前）", async () => {
		const ex = new ToolExecutor();
		ex.setPermissions({ tools: ["bash", "read"], approval: ["bash"] });
		const r = await ex.executeToolCall("bash", { command: "echo hi" });
		expect(r).toContain("批准点");
	});
});
