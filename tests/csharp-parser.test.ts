import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { Parser, ParserLive } from "../src/services/Parser.js"

const SOURCE = `
namespace Demo {
  /// <summary>Fund service.</summary>
  public class FundService : Base, ICompare {
    private int count;

    /// <summary>Compares funds.</summary>
    /// <exception cref="ArgumentException">Missing.</exception>
    public string Compare(string[] codes) {
      return Helper(codes);
    }
  }

  public interface ICompare { string Compare(string[] codes); }

  public enum Mode { Fast, Safe }
}
`

describe("C# tree-sitter parser", () => {
  it.effect("extracts namespaced types, XML docs, visibility and edges", () =>
    Effect.gen(function* () {
      const parser = yield* Parser
      const parsed = yield* parser.parse("src/FundService.cs", SOURCE)

      expect(parsed.parseStatus).toBe("parsed")
      const byName = (name: string) => parsed.symbols.find((symbol) => symbol.name === name)

      const service = byName("FundService")
      expect(service?.kind).toBe("class")
      expect(service?.doc).toContain("Fund service")
      expect(service?.visibility).toBe("public")

      const compare = byName("FundService.Compare")
      expect(compare?.kind).toBe("method")
      expect(compare?.containerName).toBe("FundService")
      expect(compare?.doc).toContain("Compares funds")
      expect(compare?.doc).toContain("@throws ArgumentException Missing.")
      expect(compare?.visibility).toBe("public")

      expect(byName("FundService.count")?.visibility).toBe("private")
      expect(byName("ICompare")?.kind).toBe("interface")
      expect(byName("ICompare.Compare")?.visibility).toBe("public")
      expect(byName("Mode")?.kind).toBe("enum")
      expect(byName("Mode.Fast")?.kind).toBe("property")

      expect(
        parsed.edges.some(
          (edge) =>
            edge.kind === "extends" && edge.srcName === "FundService" && edge.dstName === "Base"
        )
      ).toBe(true)
      expect(
        parsed.edges.some(
          (edge) =>
            edge.kind === "implements" &&
            edge.srcName === "FundService" &&
            edge.dstName === "ICompare"
        )
      ).toBe(true)
      expect(
        parsed.edges.some(
          (edge) =>
            edge.kind === "throws" &&
            edge.srcName === "FundService.Compare" &&
            edge.dstName === "ArgumentException"
        )
      ).toBe(true)
      expect(
        parsed.edges.some(
          (edge) =>
            edge.kind === "call" &&
            edge.srcName === "FundService.Compare" &&
            edge.dstName === "Helper"
        )
      ).toBe(true)
    }).pipe(Effect.provide(ParserLive))
  )
})
