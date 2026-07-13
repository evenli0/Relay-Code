/**
 * 终端反馈工具 —— 轻量级的 stderr 输出，非 TTY 时自动静默
 */

const isTTY = process.stderr.isTTY;

export function feedback(msg: string): void {
	if (isTTY) process.stderr.write(msg);
}

export function feedbackLine(msg: string): void {
	if (isTTY) process.stderr.write(msg + "\n");
}

export function elapsed(t0: number): string {
	return ((Date.now() - t0) / 1000).toFixed(1) + "s";
}
