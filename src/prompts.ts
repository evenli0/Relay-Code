/**
 * 构建主 Agent 的系统提示
 *
 * 最小版本：只有角色定义和工具列表。
 * 没有资源清单、定价、实验结论、relay 说明。
 */
export function buildSystemPrompt(): string {
  return `你是 Relay Code Agent。你有以下工具可用：

  read(path)        —— 读取本地文件
  write(path, cont) —— 写入本地文件
  grep(pattern)     —— 搜索文本
  bash(command)     —— 执行 shell 命令
  dispatch(opts)    —— 派子Agent 执行当前阶段。plan.md 记录整体编排计划。`
}
