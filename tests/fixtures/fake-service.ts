/**
 * fake-service.ts —— Supervisor 测试夹具
 *
 * 通过任务文件（DispatchConfig）中的 fixtureMode 控制行为：
 *   live          — 每 400ms 发心跳，永不退出
 *   die           — 发心跳，1.2s 后 exit(1)
 *   crash         — 立即 exit(1)，不发心跳
 *   stale         — 发 2 次心跳后沉默（供心跳僵死检测）
 *   schedule-log  — 监听 stdin，把 schedule 指令回显为事件（端到端节奏测试）
 */

import { readFileSync } from "node:fs";

const taskPath = process.argv[2];
const config = taskPath
	? (JSON.parse(readFileSync(taskPath, "utf-8")) as {
			fixtureMode?: string;
		})
	: {};
const mode = config.fixtureMode ?? "live";

let beats = 0;
const hb = setInterval(() => {
	beats++;
	if (mode === "stale" && beats > 2) {
		clearInterval(hb);
		return;
	}
	process.stdout.write(
		`${JSON.stringify({ kind: "heartbeat", ts: Date.now() })}\n`,
	);
}, 400);

if (mode === "die") {
	setTimeout(() => process.exit(1), 1200);
}
if (mode === "crash") {
	process.exit(1);
}
if (mode === "schedule-log") {
	// 监听 stdin：把 schedule 指令回显为事件（端到端节奏测试）
	process.stdin.on("data", (chunk) => {
		for (const line of chunk.toString().split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const cmd = JSON.parse(trimmed) as { kind?: string; spec?: unknown };
				if (cmd.kind === "schedule") {
					process.stdout.write(
						`${JSON.stringify({
							kind: "event",
							type: "schedule.received",
							level: "info",
							payload: { spec: cmd.spec },
							ts: Date.now(),
						})}\n`,
					);
				}
			} catch {
				/* ignore */
			}
		}
	});
}
