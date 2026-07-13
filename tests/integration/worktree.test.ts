/**
 * worktree 集成测试——真实的 git worktree 操作
 *
 * 不 mock worktree 模块，直接调用 git 命令创建/删除 worktree。
 */

import { test, expect, beforeEach, afterAll } from "bun:test"
import { createWorktree, removeWorktree, getChanges } from "../../src/worktree"
import path from "path"
import { existsSync } from "fs"

const REPO_ROOT = process.cwd()
const WT_BASE = path.join(REPO_ROOT, ".relay", "worktrees")

/** 每个测试用唯一的 slug */
let slugCounter = 0
function nextSlug(label: string): string {
  slugCounter++
  return `test-int-${label}-${slugCounter}`
}

afterAll(async () => {
  // 清理所有 test-int- 开头的 worktree
  const list = Bun.spawnSync(["bash", "-c", "git worktree list --porcelain"], { cwd: REPO_ROOT })
  if (list.exitCode === 0) {
    const lines = list.stdout.toString().split("\n")
    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        const wp = line.slice(9).trim()
        if (wp.includes("test-int-") && existsSync(wp)) {
          try { await removeWorktree(wp) } catch {}
        }
      }
    }
  }

  // 额外清理目录（git worktree remove 可能留下空目录）
  for (const entry of (Bun.spawnSync(["bash", "-c", "ls .relay/worktrees/"], { cwd: REPO_ROOT }).stdout.toString().split("\n").filter(Boolean))) {
    const full = path.join(WT_BASE, entry.trim())
    if (entry.startsWith("test-int-") && existsSync(full)) {
      try { await removeWorktree(full) } catch {
        try { Bun.spawnSync(["bash", "-c", `rm -rf "${full}"`]) } catch {}
      }
    }
  }
})

test("创建 worktree → 目录存在且是 git 仓库", async () => {
  const slug = nextSlug("create")
  const wtPath = await createWorktree(slug)

  expect(wtPath).toContain(path.join(".relay", "worktrees"))
  expect(wtPath).toContain(slug)

  // 目录存在（fs.existsSync 支持目录检查）
  expect(existsSync(wtPath)).toBe(true)

  // 是 git 仓库
  expect(existsSync(path.join(wtPath, ".git"))).toBe(true)

  // .git 是文件（worktree 专用指针）
  const stat = Bun.spawnSync(["bash", "-c", `test -f "${path.join(wtPath, ".git")}" && echo file || echo not-file`])
  expect(stat.stdout.toString().trim()).toBe("file")
})

test("worktree 内写文件 → getChanges 能检测到", async () => {
  const slug = nextSlug("changes")
  const wtPath = await createWorktree(slug)

  // 写一个新文件
  await Bun.write(path.join(wtPath, "test-output.txt"), "worktree content")
  await Bun.write(path.join(wtPath, "another-file.md"), "# Worktree")

  // 检测变更
  const changes = await getChanges(wtPath)
  expect(changes.length).toBeGreaterThanOrEqual(2)
  expect(changes).toContain("test-output.txt")
  expect(changes).toContain("another-file.md")
})

test("两个 worktree 互不干扰（模拟并行 agent 隔离）", async () => {
  const slugA = nextSlug("agent-a")
  const slugB = nextSlug("agent-b")
  const wtA = await createWorktree(slugA)
  const wtB = await createWorktree(slugB)

  // agent A 写 conflict.txt
  await Bun.write(path.join(wtA, "conflict.txt"), "内容来自 Agent A")
  // agent B 写同名文件——内容不同
  await Bun.write(path.join(wtB, "conflict.txt"), "内容来自 Agent B")

  // 验证：两个 worktree 各自有自己的 conflict.txt
  const contentA = await Bun.file(path.join(wtA, "conflict.txt")).text()
  const contentB = await Bun.file(path.join(wtB, "conflict.txt")).text()
  expect(contentA).toBe("内容来自 Agent A")
  expect(contentB).toBe("内容来自 Agent B")

  // 主仓库不受影响
  expect(existsSync("conflict.txt")).toBe(false)
})

test("getChanges 空 worktree → 返回空数组", async () => {
  const slug = nextSlug("empty")
  const wtPath = await createWorktree(slug)
  const changes = await getChanges(wtPath)
  expect(changes).toEqual([])
})

test("删除 worktree 后目录消失", async () => {
  const slug = nextSlug("cleanup")
  const wtPath = await createWorktree(slug)
  expect(existsSync(wtPath)).toBe(true)

  await removeWorktree(wtPath)
  expect(existsSync(wtPath)).toBe(false)
})
