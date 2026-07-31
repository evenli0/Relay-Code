import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import {
	exportServicePackage,
	installPackage,
	type RpkPackage,
	rollbackService,
	sha256Hex,
	validatePackage,
} from "../src/service-package";

const TEST_SVCS = ".relay/test-svcs";
const TEST_PKG = "packages/demo-pusher-1.0.0.rpk";

afterAll(() => {
	for (const p of [TEST_SVCS, TEST_PKG, ".relay/backups", "packages"]) {
		try {
			rmSync(p, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}
});

describe("service-package（rpk 集群 App 包）", () => {
	test("导出 demo-pusher：manifest + 文件树 + checksum 有效", () => {
		const r = exportServicePackage("demo-pusher");
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.pkg.manifest.format).toBe("relay-package");
		expect(r.pkg.manifest.id).toBe("demo-pusher");
		expect(r.path).toBe(TEST_PKG);
		expect(r.pkg.files.some((f) => f.path === "service.json")).toBe(true);
		expect(r.pkg.files.some((f) => f.path === "entry.ts")).toBe(true);
		expect(validatePackage(r.pkg).ok).toBe(true); // 自校验通过
	});

	test("篡改内容 → checksum 不匹配", () => {
		const r = exportServicePackage("demo-pusher");
		if (!r.ok) return;
		const tampered: RpkPackage = {
			...r.pkg,
			files: r.pkg.files.map((f, i) =>
				i === 0 ? { ...f, content: `${f.content}// tampered` } : f,
			),
		};
		const v = validatePackage(tampered);
		expect(v.ok).toBe(false);
		if (!v.ok) {
			expect(v.errors.some((e) => e.includes("checksum"))).toBe(true);
		}
	});

	test("安装：落盘 services/ 目录", () => {
		const r = exportServicePackage("demo-pusher");
		if (!r.ok) return;
		mkdirSync(TEST_SVCS, { recursive: true });

		const inst = installPackage(r.pkg, TEST_SVCS);
		expect(inst.ok).toBe(true);
		expect(existsSync(`${TEST_SVCS}/demo-pusher/service.json`)).toBe(true);
		expect(existsSync(`${TEST_SVCS}/demo-pusher/entry.ts`)).toBe(true);
	});

	test("依赖缺失 → 拒绝安装", () => {
		const contract = {
			id: "dep-svc",
			version: "1.0.0",
			name: "dep",
			description: "依赖测试",
			archetype: "pusher",
			execution: "react",
			entry: "entry.ts",
			tools: [],
			capabilities: [],
			emits: [],
			consumes: [],
			permissions: {},
		};
		const content = JSON.stringify(contract);
		const pkg: RpkPackage = {
			manifest: {
				format: "relay-package",
				id: "dep-svc",
				version: "1.0.0",
				name: "dep",
				description: "依赖测试",
				archetype: "pusher",
				execution: "react",
				dependsOn: ["ghost-svc"],
				createdAt: 1,
			},
			files: [{ path: "service.json", content, sha256: sha256Hex(content) }],
		};
		expect(validatePackage(pkg).ok).toBe(true);
		const inst = installPackage(pkg, TEST_SVCS);
		expect(inst.ok).toBe(false);
		if (!inst.ok) expect(inst.error).toContain("依赖缺失");
	});

	test("冲突安装：备份旧版后覆盖；rollback 恢复", () => {
		const r = exportServicePackage("demo-pusher");
		if (!r.ok) return;

		// 第二次安装同版本 → 旧版被备份
		const inst = installPackage(r.pkg, TEST_SVCS);
		expect(inst.ok).toBe(true);
		if (!inst.ok) return;
		expect(inst.backedUp).toBeDefined();

		// rollback 到最近备份
		const rb = rollbackService("demo-pusher", TEST_SVCS);
		expect(rb.ok).toBe(true);
		expect(existsSync(`${TEST_SVCS}/demo-pusher/service.json`)).toBe(true);
	});

	test("rollback 无备份 → 报错", () => {
		const rb = rollbackService("no-such-svc", TEST_SVCS);
		expect(rb.ok).toBe(false);
	});

	test("rpk 文件落盘后可读回，内容与源一致", () => {
		const raw = JSON.parse(readFileSync(TEST_PKG, "utf-8")) as unknown;
		const v = validatePackage(raw);
		expect(v.ok).toBe(true);
		if (!v.ok) return;
		const srcEntry = readFileSync("services/demo-pusher/entry.ts", "utf-8");
		const entry = v.pkg.files.find((f) => f.path === "entry.ts");
		expect(entry?.content).toBe(srcEntry);
	});
});
