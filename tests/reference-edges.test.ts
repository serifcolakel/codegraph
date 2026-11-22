import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { Parser, ParserLive } from "../src/services/Parser.js"

const SOURCE = `
export const LIMIT = 10;

export function helper(value: number): number {
  return value + LIMIT;
}

export class UserService {
  private name = "user";
}

const callback = helper;
const service: UserService = new UserService();

export function caller(): number {
  return helper(1);
}
`

describe("Reference edges", () => {
  it.effect("emits call_reference and usage without duplicating call edges", () =>
    Effect.gen(function* () {
      const parser = yield* Parser
      const parsed = yield* parser.parse("src/refs.ts", SOURCE)

      const edge = (srcName: string, dstName: string, kind: string) =>
        parsed.edges.find(
          (candidate) =>
            candidate.srcName === srcName &&
            candidate.dstName === dstName &&
            candidate.kind === kind
        )

      // Passing a function without invoking it is a call reference.
      expect(edge("callback", "helper", "call_reference")).toBeDefined()
      expect(edge("callback", "helper", "call")).toBeUndefined()

      // Non-call references to local types are usages.
      expect(edge("service", "UserService", "usage")).toBeDefined()

      // Calls stay calls and do not also become call references.
      expect(edge("caller", "helper", "call")).toBeDefined()
      expect(edge("caller", "helper", "call_reference")).toBeUndefined()

      // Usage of a const from inside a function.
      expect(edge("helper", "LIMIT", "usage")).toBeDefined()

      // Import/export/property identifiers do not create reference edges.
      expect(parsed.edges.some((candidate) => candidate.srcName === "src/refs")).toBe(false)
    }).pipe(Effect.provide(ParserLive))
  )
})
