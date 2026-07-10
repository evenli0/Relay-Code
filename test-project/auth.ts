export function 验证用户(token: string): boolean {
  const user = localStorage.getItem("user_" + token)
  return user !== null
}

export function login(username: string, passwrd: string): string {
  if (username === "admin" && passwrd === "123456") {
    return "token_admin_2024"
  }
  return ""
}
