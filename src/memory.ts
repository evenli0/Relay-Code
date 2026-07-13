import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { appendFile } from "node:fs/promises";

const MEMORY_DIR = "memory";

/** 每进程唯一的会话 ID */
const SESSION_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

interface DialogueEntry {
	role: "user" | "assistant" | "system" | "tool";
	content: string;
	ts: string;
	session: string;
}

/** 确保 memory/ 目录存在 */
function ensureDir(): void {
	if (!existsSync(MEMORY_DIR)) {
		mkdirSync(MEMORY_DIR, { recursive: true });
	}
}

/** 今日文件名：dialogue_2026-07-09.jsonl */
function getTodayFilePath(): string {
	const date = new Date().toISOString().slice(0, 10);
	return `${MEMORY_DIR}/dialogue_${date}.jsonl`;
}

/** 追加一条对话记录到今日文件（原子追加，无竞争条件） */
export async function saveDialogue(
	role: "user" | "assistant" | "system" | "tool",
	content: string,
): Promise<void> {
	ensureDir();
	const entry: DialogueEntry = {
		role,
		content,
		ts: new Date().toISOString(),
		session: SESSION_ID,
	};
	await appendFile(getTodayFilePath(), `${JSON.stringify(entry)}\n`, "utf-8");
}

/** 返回 memory/ 下所有文件信息 */
export async function listMemoryFiles(): Promise<
	{ path: string; size: number; isToday: boolean }[]
> {
	ensureDir();
	const names = readdirSync(MEMORY_DIR);
	const files: { path: string; size: number; isToday: boolean }[] = [];

	for (const name of names) {
		if (!name.endsWith(".jsonl")) continue;
		const path = `${MEMORY_DIR}/${name}`;
		const file = Bun.file(path);
		const stat = await file.stat();
		files.push({
			path,
			size: stat.size,
			isToday: name === getTodayFilePath().split("/").pop(),
		});
	}

	return files.sort((a, b) => b.size - a.size);
}

/** 读取一个记忆文件的全部内容，文件不存在则返回空字符串 */
export async function readMemoryFile(path: string): Promise<string> {
	try {
		const file = Bun.file(path);
		if (!(await file.exists())) return "";
		return await file.text();
	} catch (e: unknown) {
		console.error(`[memory] 读取文件失败: ${path}`, e);
		return "";
	}
}
