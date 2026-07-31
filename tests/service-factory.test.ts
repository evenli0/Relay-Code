import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { validateContract } from "../src/service-contract";
import {
	createServiceContract,
	writeServiceFiles,
} from "../src/service-factory";
import { Supervisor } from "../src/supervisor";
import { ToolExecutor } from "../src/tool-executor";

const TEST_DIR = "services/test-gen-svc";

afterAll(() => {
	try {
		rmSync(TEST_DIR, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

describe("service-factory（主 agent 生成服务）", () => {
	test("契约生成：id 规范化 + 默认值", () => {
		const c = createServiceContract({
			name: "news-scraper",
			description: "抓取新闻并分析套利机会",
			archetype: "watcher",
		});
		expect(c.id).toBe("news-scraper");
		expect(c.execution).toBe("watch"); // watcher → watch 执行模式
		expect(c.entry).toBe("services/news-scraper/entry.ts");
		expect(c.version).toBe("1.0.0");
		expect(validateContract(c).ok).toBe(true);
	});

	test("中文名回退 svc- 前缀", () => {
		const c = createServiceContract({
			name: "套利监控",
			description: "x",
			archetype: "watcher",
		});
		expect(c.id.startsWith("svc-")).toBe(true);
	});

	test("写入目录：service.json + entry.ts，契约可校验", () => {
		const c = createServiceContract({
			name: "test-gen-svc",
			description: "t",
			archetype: "pusher",
		});
		const w = writeServiceFiles(c);
		expect(w.ok).toBe(true);
		expect(existsSync("services/test-gen-svc/service.json")).toBe(true);
		expect(existsSync("services/test-gen-svc/entry.ts")).toBe(true);

		const raw = JSON.parse(
			readFileSync("services/test-gen-svc/service.json", "utf-8"),
		) as unknown;
		expect(validateContract(raw).ok).toBe(true);
	});
});

describe("create_service 工具", () => {
	test("未接入 Supervisor → 提示不可用", async () => {
		const ex = new ToolExecutor();
		const r = await ex.executeToolCall("create_service", {
			name: "x",
		} as never);
		expect(r).toContain("不可用");
	});

	test("接入后生成并部署（Supervisor 启动）", async () => {
		const s = new Supervisor({ logger: () => {} });
		const ex = new ToolExecutor();
		ex.supervisor = s;
		s.onNodeEvent = () => {};

		const r = await ex.executeToolCall("create_service", {
			name: "test-gen-svc",
			description: "生成测试",
			archetype: "pusher",
		} as never);

		expect(r).toContain("已生成并部署");
		expect(r).toContain("test-gen-svc");
		expect(s.getStatus("test-gen-svc")?.status).toBe("running");
		s.stopAll();
	});

	test("缺失 name / 非法 archetype 拒绝", async () => {
		const s = new Supervisor({ logger: () => {} });
		const ex = new ToolExecutor();
		ex.supervisor = s;

		const noName = await ex.executeToolCall("create_service", {} as never);
		expect(noName).toContain("name");

		const badType = await ex.executeToolCall("create_service", {
			name: "x",
			archetype: "magic",
		} as never);
		expect(badType).toContain("archetype");
		s.stopAll();
	});
});
