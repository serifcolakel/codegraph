import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { Parser, ParserLive } from "../src/services/Parser.js"

describe("Generic language parser", () => {
  it.effect("extracts documented symbols from C#, Go, Rust and Python", () =>
    Effect.gen(function* () {
      const parser = yield* Parser

      const csharp = yield* parser.parse(
        "src/FundService.cs",
        `
namespace Demo {
  /// <summary>Handles fund comparisons.</summary>
  public class FundService : IFundService {
    /// <summary>Compares funds by code.</summary>
    /// <exception cref="ArgumentException">Codes are missing.</exception>
    public string Compare(string[] codes) { return string.Join(",", codes); }
  }
}
`
      )
      const csharpClass = csharp.symbols.find((s) => s.name === "FundService")
      expect(csharpClass?.kind).toBe("class")
      expect(csharpClass?.doc).toContain("Handles fund comparisons")
      const csharpMethod = csharp.symbols.find((s) => s.name === "FundService.Compare")
      expect(csharpMethod?.kind).toBe("method")
      expect(csharpMethod?.doc).toContain("Compares funds by code")
      expect(csharpMethod?.doc).toContain("@throws ArgumentException Codes are missing.")
      expect(
        csharp.edges.some((e) => e.kind === "implements" && e.dstName === "IFundService")
      ).toBe(true)

      const go = yield* parser.parse(
        "main.go",
        `
package main

// Fund is a fund model.
type Fund struct {
  Code string
}

// CompareFunds compares funds.
func CompareFunds(codes []string) string { return codes[0] }
`
      )
      expect(go.symbols.find((s) => s.name === "Fund")?.doc).toContain("fund model")
      expect(go.symbols.find((s) => s.name === "CompareFunds")?.doc).toContain("compares funds")

      const rust = yield* parser.parse(
        "lib.rs",
        `
/// Fund service.
pub struct FundService { name: String }

impl FundService {
    /// Compares funds.
    pub fn compare(&self, codes: Vec<String>) -> String { codes.join(",") }
}
`
      )
      expect(rust.symbols.find((s) => s.name === "FundService")?.doc).toContain("Fund service")
      expect(rust.symbols.find((s) => s.name === "FundService.compare")?.doc).toContain(
        "Compares funds"
      )

      const python = yield* parser.parse(
        "app.py",
        `
class FundService:
    """Fund service docs."""

    def compare(self, codes):
        """Compare funds by code."""
        return ",".join(codes)
`
      )
      expect(python.symbols.find((s) => s.name === "FundService")?.doc).toContain(
        "Fund service docs"
      )
      expect(python.symbols.find((s) => s.name === "FundService.compare")?.doc).toContain(
        "Compare funds"
      )
    }).pipe(Effect.provide(ParserLive))
  )
})
