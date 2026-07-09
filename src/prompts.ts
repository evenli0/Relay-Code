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
  dispatch(opts)    —— 创建子Agent，可以指定 preload 文件、角色、任务、工具权限和返回格式

完成指令后直接输出最终结果。`
}
