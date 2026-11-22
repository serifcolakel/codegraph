import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { Parser, ParserLive } from "../src/services/Parser.js"

const SOURCE = `
pub const MAX_SIZE: usize = 10;

/// Fund service.
pub struct FundService {
    pub name: String,
    secret: i32,
}

pub enum Mode {
    Fast,
    Safe,
}

pub trait Compare {
    fn compare(&self, codes: Vec<String>) -> String;
}

impl Compare for FundService {
    /// Compares funds.
    pub fn compare(&self, codes: Vec<String>) -> String {
        helper(&codes)
    }
}

pub fn helper(codes: &[String]) -> String {
    codes.join(",")
}

pub fn summarize(values: &[i32]) -> i32 {
    let mut total = 0;
    for value in values {
        if *value > 0 {
            total += *value;
        }
    }
    total
}
`

describe("Rust tree-sitter parser", () => {
  it.effect("extracts AST-backed symbols, trait implementation and edges", () =>
    Effect.gen(function* () {
      const parser = yield* Parser
      const parsed = yield* parser.parse("crates/funds/src/lib.rs", SOURCE)

      expect(parsed.parseStatus).toBe("parsed")
      const byName = (name: string) => parsed.symbols.find((symbol) => symbol.name === name)

      const service = byName("FundService")
      expect(service?.kind).toBe("class")
      expect(service?.doc).toContain("Fund service")
      expect(service?.visibility).toBe("public")

      expect(byName("FundService.name")?.visibility).toBe("public")
      expect(byName("FundService.secret")?.visibility).toBe("private")

      expect(byName("Mode")?.kind).toBe("enum")
      expect(byName("Mode.Fast")?.kind).toBe("property")
      expect(byName("Compare")?.kind).toBe("interface")

      const summarize = byName("summarize")
      expect(summarize?.cyclomatic).toBe(3)
      expect(summarize?.loopDepth).toBe(1)
      expect(summarize?.paramCount).toBe(1)

      const compare = byName("FundService.compare")
      expect(compare?.kind).toBe("method")
      expect(compare?.containerName).toBe("FundService")
      expect(compare?.doc).toContain("Compares funds")
      expect(compare?.visibility).toBe("public")

      expect(
        parsed.edges.some(
          (edge) =>
            edge.kind === "implements" &&
            edge.srcName === "FundService" &&
            edge.dstName === "Compare"
        )
      ).toBe(true)

      expect(
        parsed.edges.some(
          (edge) =>
            edge.kind === "call" &&
            edge.srcName === "FundService.compare" &&
            edge.dstName === "helper"
        )
      ).toBe(true)
    }).pipe(Effect.provide(ParserLive))
  )
})
