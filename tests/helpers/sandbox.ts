import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"

let originalCwd = ""
let sandboxDir = ""

/** 在每个测试前调用：创建临时目录并切换进去 */
export function setupSandbox(): void {
  originalCwd = process.cwd()
  sandboxDir = mkdtempSync(tmpdir() + "/relay-test-")
  process.chdir(sandboxDir)
}

/** 在每个测试后调用：切回原目录并删除临时目录 */
export function teardownSandbox(): void {
  process.chdir(originalCwd)
  try { rmSync(sandboxDir, { recursive: true, force: true }) } catch {}
}

/** 获取当前沙箱路径 */
export function getSandboxPath(): string {
  return sandboxDir
}
