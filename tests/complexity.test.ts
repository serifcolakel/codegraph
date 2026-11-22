import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { Parser, ParserLive } from "../src/services/Parser.js"

const SOURCE = `
export function scan(values: number[]): number {
  let total = 0;
  for (const value of values) {
    if (values.includes(value)) {
      total += value;
    }
    for (const other of values) {
      total += values.find((x) => x === other) ?? 0;
    }
  }
  return total;
}

export function recurse(n: number): number {
  return n <= 1 ? 1 : recurse(n - 1);
}

export const arrow = (a: number, b: number) => (a > b ? a : b);
`

describe("Complexity metrics", () => {
  it.effect("computes cyclomatic, loop depth, scan/alloc and recursion", () =>
    Effect.gen(function* () {
      const parser = yield* Parser
      const parsed = yield* parser.parse("src/metrics.ts", SOURCE)
      const byName = (name: string) => parsed.symbols.find((symbol) => symbol.name === name)

      const scan = byName("scan")
      expect(scan?.cyclomatic).toBe(5)
      expect(scan?.loopDepth).toBe(2)
      expect(scan?.loopCount).toBe(2)
      expect(scan?.linearScanInLoop).toBeGreaterThanOrEqual(2)
      expect(scan?.allocInLoop).toBe(0)
      expect(scan?.paramCount).toBe(1)
      expect(scan?.recursive).toBe(false)

      const recurse = byName("recurse")
      expect(recurse?.cyclomatic).toBe(2)
      expect(recurse?.recursive).toBe(true)
      expect(recurse?.paramCount).toBe(1)

      const arrow = byName("arrow")
      expect(arrow?.cyclomatic).toBe(2)
      expect(arrow?.paramCount).toBe(2)
    }).pipe(Effect.provide(ParserLive))
  )
})
