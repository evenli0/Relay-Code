/**
 * ANSI 工具包 + 终端展示基础设施
 *
 * 统一管理所有终端输出（stderr），支持 TTY 原地刷新和非 TTY 降级。
 */

// ---- ANSI 基础 ----

const CSI = "\x1b[";
const SGR = (n: number) => `${CSI}${n}m`;

export const c = {
	reset: SGR(0),
	bold: SGR(1),
	dim: SGR(2),
	green: SGR(32),
	red: SGR(31),
	yellow: SGR(33),
	cyan: SGR(36),
	blue: SGR(34),
	magenta: SGR(35),
} as const;

export const icon = {
	spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
	check: "✓",
	cross: "✗",
	warn: "⚠",
	arrow: "→",
} as const;

const isTTY = process.stderr.isTTY;

// ---- Spinner 状态 ----

let spinnerIdx = 0;
let spinnerTimer: ReturnType<typeof setInterval> | null = null;

export function startSpinner(): void {
	if (!isTTY) return;
	if (spinnerTimer) return;
	spinnerTimer = setInterval(() => {
		spinnerIdx = (spinnerIdx + 1) % icon.spinner.length;
	}, 80);
}

export function stopSpinner(): void {
	if (spinnerTimer) {
		clearInterval(spinnerTimer);
		spinnerTimer = null;
	}
}

// ---- 基础输出 ----

/** 非 TTY 降级：时间戳 + 纯文本 */
export function milestone(msg: string): void {
	const ts = new Date().toLocaleTimeString("zh-CN", { hour12: false });
	process.stderr.write(`[${ts}] ${msg}\n`);
}

/** TTY: 原地刷新状态行 */
export function statusLine(
	step: number,
	total: number,
	action: string,
	elapsedSec: number,
): void {
	const spin = icon.spinner[spinnerIdx];
	if (isTTY) {
		process.stderr.write(
			`\r${c.cyan}[${step}/${total}]${c.reset} ${spin} ${action} ${c.dim}⏱ ${elapsedSec.toFixed(1)}s${c.reset}`,
		);
	} else {
		milestone(`[${step}/${total}] ${action} (${elapsedSec.toFixed(1)}s)`);
	}
}

/** 清除状态行并换行 */
export function clearStatusLine(): void {
	if (isTTY) process.stderr.write("\r\x1b[2K");
}

// ---- 工具/子Agent 输出 ----

/** 工具调用结果 */
export function toolResultLine(
	name: string,
	ok: boolean,
	summary: string,
	elapsedMs: number,
): void {
	const mark = ok
		? `${c.green}${icon.check}${c.reset}`
		: `${c.red}${icon.cross}${c.reset}`;
	const time = `${c.dim}(${(elapsedMs / 1000).toFixed(1)}s)${c.reset}`;
	const msg = `  ${mark} ${name} ${icon.arrow} ${summary} ${time}`;
	if (isTTY) process.stderr.write(`${msg}\n`);
	else milestone(`${ok ? "OK" : "FAIL"} ${name}: ${summary}`);
}

/** 子Agent 启动 */
export function subAgentStart(depth: number, task: string): void {
	const indent = "│  ".repeat(depth);
	const msg = `${indent}${c.magenta}├─ 🔹 子Agent${c.reset} ${task}`;
	if (isTTY) process.stderr.write(`${msg}\n`);
	else milestone(`[子Agent] ${task}`);
}

/** 子Agent 完成 */
export function subAgentEnd(
	depth: number,
	rounds: number,
	elapsedSec: number,
	ok: boolean,
): void {
	const indent = "│  ".repeat(depth);
	const mark = ok ? `${c.green}✅${c.reset}` : `${c.red}❌${c.reset}`;
	const msg = `${indent}${mark} 完成 (${rounds}轮, ${elapsedSec.toFixed(1)}s)`;
	if (isTTY) process.stderr.write(`${msg}\n`);
	else
		milestone(
			`[子Agent] ${ok ? "成功" : "失败"} (${rounds}轮, ${elapsedSec.toFixed(1)}s)`,
		);
}

// ---- 计划展示 ----

/** 计算从 t0 到现在的耗时（秒），用于统一的时间格式化 */
export function elapsed(t0: number): string {
	return ((Date.now() - t0) / 1000).toFixed(1);
}

/** 计划渲染 */
export function showPlan(planText: string): void {
	if (isTTY)
		process.stderr.write(`\n${c.bold}📋 计划:${c.reset}\n${planText}\n`);
	else milestone(`计划: ${planText.replace(/\n/g, " | ")}`);
}
