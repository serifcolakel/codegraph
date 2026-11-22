import { add } from "./math"

export class Calculator {
  /** Computes a sum through the math module. */
  run(a: number, b: number): number {
    return add(a, b)
  }
}

function unusedLocal(): number {
  return 1
}
