/**
 * demo-pusher —— 演示推进型服务
 *
 * 协议是唯一共性（framework-design §1）：任何会说话协议的脚本都是服务。
 * 本服务不依赖 actor.ts，直接 emit ServiceEvent。
 */

// 每 10s 上报一次结构化状态（state 通道 → 全局状态模型的数据源）
setInterval(() => {
	process.stdout.write(
		`${JSON.stringify({
			kind: "state",
			updates: {
				topic: "agent 开发",
				mastered: Math.min(1, 0.3 + Math.random() * 0.2),
			},
		})}\n`,
	);
}, 10_000);

// 心跳：Supervisor 据此检测僵死
setInterval(() => {
	process.stdout.write(
		`${JSON.stringify({ kind: "heartbeat", ts: Date.now() })}\n`,
	);
}, 30_000);
