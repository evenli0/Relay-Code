import { 验证用户 } from "./auth"

export function checkLogin(): string {
  const token = localStorage.getItem("session")
  if (token && 验证用户(token)) {
    return "已登录"
  }
  return "未登录"
}
