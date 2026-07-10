import { add } from "./math"

export function calculate(a: number, b: number): number {
  return add(a, b) * 2
}

export function formatResult(value: number): string {
  return `结果：${value}`
}
