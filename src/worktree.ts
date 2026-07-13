import path from "path"
import { existsSync } from "fs"

const WORKTREE_DIR_RELATIVE = ".relay/worktrees"

/** Worktree 的完整路径 */
function getWorktreeDir(): string {
  return path.resolve(process.cwd(), WORKTREE_DIR_RELATIVE)
}

/** 执行 git 命令，返回 stdout，失败抛错 */
function git(args: string[], cwd?: string): string {
  const proc = Bun.spawnSync(["bash", "-c", `git ${args.map(a => `"${a}"`).join(" ")}`], { cwd })
  if (proc.exitCode !== 0) {
    throw new Error(`git 失败: ${proc.stderr.toString().trim() || proc.stdout.toString().trim()}`)
  }
  return proc.stdout.toString()
}

/**
 * 创建 git worktree（detached HEAD）。
 * 如果同名 worktree 已存在，先删除再重建。
 *
 * @param slug  标识名（仅字母、数字、连字符）
 * @returns      worktree 的绝对路径
 */
export async function createWorktree(slug: string): Promise<string> {
  const worktreePath = path.resolve(getWorktreeDir(), slug)

  // 已存在 → 先删除
  if (existsSync(worktreePath)) {
    git(["worktree", "remove", "--force", worktreePath])
  }

  // 创建 worktree（detached HEAD，不创建新分支）。git 会自动创建所需目录。
  git(["worktree", "add", "--detach", worktreePath])

  return worktreePath
}

/**
 * 删除 git worktree
 */
export async function removeWorktree(worktreePath: string): Promise<void> {
  try {
    git(["worktree", "remove", "--force", worktreePath])
  } catch {
    // 忽略删除失败（可能已被外部删除）
  }
}

/**
 * 检测 worktree 中的变更文件列表（含 untracked 文件）
 */
export async function getChanges(worktreePath: string): Promise<string[]> {
  try {
    // git status --porcelain 输出: "?? new.txt" 或 " M modified.txt"
    const out = git(["status", "--porcelain"], worktreePath)
    const lines = out.trim().split("\n").filter(Boolean)
    return lines.map(line => line.slice(3).trim()) // 去掉状态前缀
  } catch {
    return []
  }
}
