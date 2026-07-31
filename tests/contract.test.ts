import { describe, expect, test } from "bun:test";
import {
	type ServiceContract,
	validateContract,
} from "../src/service-contract";

const valid: ServiceContract = {
	id: "demo-watcher",
	version: "1.0.0",
	name: "Demo Watcher",
	description: "测试用监控服务",
	archetype: "watcher",
	execution: "watch",
	entry: "entry.ts",
	tools: ["read", "grep"],
	capabilities: ["detect"],
	emits: ["opportunity.found"],
	consumes: [],
	permissions: { fs: ["read"], tools: ["read", "grep"] },
};

describe("validateContract", () => {
	test("合法契约通过", () => {
		const r = validateContract(valid);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.contract.id).toBe("demo-watcher");
	});

	test("缺必填字段报错", () => {
		const { id, ...rest } = valid;
		const r = validateContract(rest);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.errors.some((e) => e.includes("id"))).toBe(true);
	});

	test("非法 archetype 报错", () => {
		const r = validateContract({ ...valid, archetype: "magic" });
		expect(r.ok).toBe(false);
	});

	test("非法 execution 报错", () => {
		const r = validateContract({ ...valid, execution: "brain" });
		expect(r.ok).toBe(false);
	});

	test("id 命名规范", () => {
		expect(validateContract({ ...valid, id: "Bad ID!" }).ok).toBe(false);
		expect(validateContract({ ...valid, id: "ok-id-1" }).ok).toBe(true);
	});

	test("数组字段必须是数组", () => {
		expect(validateContract({ ...valid, tools: "read" }).ok).toBe(false);
		expect(validateContract({ ...valid, emits: 42 }).ok).toBe(false);
	});

	test("permissions 校验", () => {
		expect(validateContract({ ...valid, permissions: "all" }).ok).toBe(false);
		expect(validateContract({ ...valid, permissions: { fs: "read" } }).ok).toBe(
			false,
		);
		// 空 permissions 允许（最小集）
		expect(validateContract({ ...valid, permissions: {} }).ok).toBe(true);
	});

	test("非对象报错", () => {
		expect(validateContract(null).ok).toBe(false);
		expect(validateContract("x").ok).toBe(false);
		expect(validateContract(42).ok).toBe(false);
	});
});
