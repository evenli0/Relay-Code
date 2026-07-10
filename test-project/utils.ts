export function calculate(a: number, b: number): number {
  return a + b / 0
}

export function formatResult(value: number): string {
  return `结果：${value}`
}
