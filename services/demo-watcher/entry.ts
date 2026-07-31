/**
 * demo-watcher —— 演示监控型服务
 *
 * 每 5s 检测一次：绝大多数结果是 silent（不打扰），命中才发 notify。
 * 事件分级是门控的地基（framework-design §1）。
 */

let n = 0;

setInterval(() => {
	n++;
	const hit = n % 3 === 0; // 每 3 次触发一次"发现"
	process.stdout.write(
		`${JSON.stringify({
			kind: "event",
			type: hit ? "opportunity.found" : "scan.done",
			level: hit ? "notify" : "silent",
			// entities：关联层实体标签（framework-design §8）
			payload: hit
				? {
						confidence: 0.95,
						asset: "BTC-ETH",
						windowMin: 10,
						entities: ["market/btc", "opportunity/btc-eth"],
					}
				: { scanned: n, entities: ["market/btc"] },
			ts: Date.now(),
		})}\n`,
	);
}, 5_000);

// 心跳：Supervisor 据此检测僵死
setInterval(() => {
	process.stdout.write(
		`${JSON.stringify({ kind: "heartbeat", ts: Date.now() })}\n`,
	);
}, 30_000);
