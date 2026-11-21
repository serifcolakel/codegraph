import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { Parser, ParserLive } from "../src/services/Parser.js"

describe("throws / raises edges", () => {
  it.effect("extracts throws from JSDoc tags in TypeScript", () =>
    Effect.gen(function* () {
      const parser = yield* Parser
      const parsed = yield* parser.parse(
        "src/pick.ts",
        `
/** Picks a value. @throws {RangeError} when the index is out of range. */
export function pick(values: number[], index: number): number {
  return values[index] ?? 0;
}
`
      )

      expect(
        parsed.edges.some(
          (edge) =>
            edge.kind === "throws" && edge.srcName === "pick" && edge.dstName === "RangeError"
        )
      ).toBe(true)
    }).pipe(Effect.provide(ParserLive))
  )

  it.effect("extracts raises from doc comments in the regex fallback", () =>
    Effect.gen(function* () {
      const parser = yield* Parser
      const parsed = yield* parser.parse(
        "lib/funds.rb",
        `
class FundService
  # Compares funds.
  # @raises ArgumentError when codes are empty
  def compare(codes)
    codes
  end
end
`
      )

      expect(
        parsed.edges.some(
          (edge) =>
            edge.kind === "raises" &&
            edge.srcName === "FundService.compare" &&
            edge.dstName === "ArgumentError"
        )
      ).toBe(true)
    }).pipe(Effect.provide(ParserLive))
  )
})
