/**
 * ANSI 工具包 + 终端展示基础设施
 * 增强: 进度条、工具颜色编码、卡片式计划、Banner/Footer、CJK 宽度感知。
 */
const CSI = "\x1b[";
const SGR = (n: number) => `${CSI}${n}m`;
const VERSION = "0.1.0";

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

// ---- CJK 宽度辅助 ----

/** 终端显示宽度：CJK 字符=2，跳过 ANSI 转义序列 */
function strWidth(s: string): number {
	let w = 0,
		esc = false;
	for (const ch of s) {
		if (ch === "\x1b") {
			esc = true;
			continue;
		}
		if (esc) {
			if (ch === "m") esc = false;
			continue;
		}
		w += ch.charCodeAt(0) > 0x7f ? 2 : 1;
	}
	return w;
}
function padRight(s: string, width: number): string {
	return s + " ".repeat(Math.max(0, width - strWidth(s)));
}
function stripAnsi(s: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape strip
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// ---- 终端工具 ----

export function getTermWidth(): number {
	return process.stdout.columns || 80;
}

/** 工具名 → ANSI 颜色 */
export function colorByTool(name: string): string {
	const l = name.toLowerCase();
	if (l.includes("bash") || l.includes("shell")) return c.green;
	if (l.includes("read") || l.includes("cat")) return c.blue;
	if (l.includes("write") || l.includes("edit")) return c.yellow;
	if (l.includes("grep") || l.includes("find")) return c.cyan;
	if (l.includes("glob")) return c.magenta;
	return c.dim;
}

/** 渲染 ANSI 彩色进度条 `[████░░░░] 50%`（非 TTY 降级为纯文本） */
export function progressBar(
	current: number,
	total: number,
	width = 10,
): string {
	const pct = Math.min(1, Math.max(0, current / total));
	const filled = Math.round(pct * width);
	const bar = "█".repeat(filled) + "░".repeat(width - filled);
	const pctStr = `${Math.round(pct * 100)}%`;
	return isTTY
		? `${c.green}[${bar}]${c.reset} ${c.bold}${pctStr}${c.reset}`
		: `[${bar}] ${pctStr}`;
}

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

export function milestone(msg: string): void {
	const ts = new Date().toLocaleTimeString("zh-CN", { hour12: false });
	process.stderr.write(`[${ts}] ${msg}\n`);
}

/** TTY: 原地刷新状态行（含进度条 + Relay 前缀）| 非 TTY: milestone */
export function statusLine(
	step: number,
	total: number,
	action: string,
	elapsedSec: number,
): void {
	if (isTTY) {
		const spin = icon.spinner[spinnerIdx];
		process.stderr.write(
			`\r${c.cyan}Relay · Step ${step}/${total} ${progressBar(step, total)} · ⏱ ${elapsedSec.toFixed(1)}s${c.reset} · ${spin} ${action}`,
		);
	} else {
		milestone(`[${step}/${total}] ${action} (${elapsedSec.toFixed(1)}s)`);
	}
}

export function clearStatusLine(): void {
	if (isTTY) process.stderr.write("\r\x1b[2K");
}

// ---- 工具/子Agent 输出 ----

/** 工具结果（TTY: 工具名颜色编码） */
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
	const tc = isTTY ? colorByTool(name) : "",
		tr = isTTY ? c.reset : "";
	const msg = `  ${mark} ${tc}${name}${tr} ${icon.arrow} ${summary} ${time}`;
	if (isTTY) process.stderr.write(`${msg}\n`);
	else milestone(`${ok ? "OK" : "FAIL"} ${name}: ${summary}`);
}

export function subAgentStart(depth: number, task: string): void {
	const indent = "│  ".repeat(depth);
	const msg = `${indent}${c.magenta}├─ 🔹 子Agent${c.reset} ${task}`;
	if (isTTY) process.stderr.write(`${msg}\n`);
	else milestone(`[子Agent] ${task}`);
}

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

export function elapsed(t0: number): string {
	return ((Date.now() - t0) / 1000).toFixed(1);
}

/** 通用框线绘制（single: ┌─┐│└─┘ | double: ╔═╗║╚═╝），CJK 宽度感知 */
function drawBox(
	lines: string[],
	style: "single" | "double" = "single",
): string {
	const s =
		style === "double"
			? { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║" }
			: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" };
	const w = Math.max(...lines.map((l) => strWidth(l)), 0);
	return [
		`${s.tl}${s.h.repeat(w + 2)}${s.tr}`,
		...lines.map((l) => `${s.v} ${padRight(l, w)} ${s.v}`),
		`${s.bl}${s.h.repeat(w + 2)}${s.br}`,
	].join("\n");
}

/** 增强: 卡片式计划（📋 标题 + 单线框） */
export function showPlan(planText: string): void {
	if (!isTTY) {
		milestone(`计划: ${planText.replace(/\n/g, " | ")}`);
		return;
	}
	process.stderr.write(
		`\n${c.bold}📋 计划:${c.reset}\n${drawBox(planText.trim().split("\n"))}\n`,
	);
}

/** 卡片式计划（纯框无标题），CJK 感知 + 自动换行适应终端宽度 */
export function showPlanCard(planText: string): void {
	if (!isTTY) {
		milestone(`计划: ${planText.replace(/\n/g, " | ")}`);
		return;
	}
	const maxW = Math.min(getTermWidth() - 4, 72);
	const wrapped: string[] = [];
	for (const line of planText.trim().split("\n")) {
		if (strWidth(stripAnsi(line)) <= maxW) {
			wrapped.push(line);
			continue;
		}
		let cur = "";
		for (const ch of line) {
			if (strWidth(cur + ch) > maxW) {
				wrapped.push(cur);
				cur = ch;
			} else cur += ch;
		}
		if (cur) wrapped.push(cur);
	}
	process.stderr.write(`\n${drawBox(wrapped)}\n`);
}

// ---- Banner & Footer ----

export interface RunStats {
	rounds: number;
	toolsCalled: number;
	totalSec: number;
	ok: boolean;
	subAgents?: number;
}

/** 双线框 Banner: Relay Code v0.1.0 + task，自动截断适配终端宽度 */
export function printBanner(task: string): void {
	if (!isTTY) {
		milestone(`Relay Code v${VERSION} - ${task}`);
		return;
	}
	const maxW = Math.min(getTermWidth() - 2, 64);
	let dt = task;
	while (strWidth(`${VERSION} · ${dt}`) > maxW && dt.length > 0)
		dt = dt.slice(0, -1);
	process.stderr.write(
		`\n${drawBox(
			[
				`${c.bold}Relay Code v${VERSION}${c.reset}`,
				`${c.dim}${dt}${dt !== task ? "…" : ""}${c.reset}`,
			],
			"double",
		)}\n`,
	);
}

/** 单行统计摘要: 轮次 / 工具 / 耗时 / 子Agent / 成功/失败 */
export function printFooter(stats: RunStats): void {
	const status = stats.ok
		? `${c.green}✓ 成功${c.reset}`
		: `${c.red}✗ 失败${c.reset}`;
	const parts = [
		`轮次: ${stats.rounds}`,
		`工具: ${stats.toolsCalled}`,
		`耗时: ${stats.totalSec.toFixed(1)}s`,
	];
	if (stats.subAgents !== undefined) parts.push(`子Agent: ${stats.subAgents}`);
	parts.push(status);
	if (isTTY) process.stderr.write(`\n${c.dim}${parts.join(" · ")}${c.reset}\n`);
	else milestone(parts.join(" | "));
}
