import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { Parser, ParserLive } from "../src/services/Parser.js"

const SOURCE = `
package com.example;

import java.util.List;

/** Fund service. */
public class FundService extends Base implements Compare {
    private int count = 0;

    /** Compares funds. */
    public String compare(List<String> codes) throws IOException {
        return helper(codes);
    }

    public int summarize(int[] values) {
        int total = 0;
        for (int value : values) {
            if (value > 0) {
                total += value;
            }
        }
        return total;
    }
}

interface Compare {
    String compare(List<String> codes);
}

enum Mode { Fast, Safe }

class Hidden {}
`

describe("Java tree-sitter parser", () => {
  it.effect("extracts classes, methods, visibility and edges", () =>
    Effect.gen(function* () {
      const parser = yield* Parser
      const parsed = yield* parser.parse("src/main/java/FundService.java", SOURCE)

      expect(parsed.parseStatus).toBe("parsed")
      const byName = (name: string) => parsed.symbols.find((symbol) => symbol.name === name)

      const service = byName("FundService")
      expect(service?.kind).toBe("class")
      expect(service?.doc).toContain("Fund service")
      expect(service?.visibility).toBe("public")

      const compare = byName("FundService.compare")
      expect(compare?.kind).toBe("method")
      expect(compare?.containerName).toBe("FundService")
      expect(compare?.doc).toContain("Compares funds")
      expect(compare?.visibility).toBe("public")
      expect(compare?.signature).toContain("public String compare")

      expect(byName("FundService.count")?.visibility).toBe("private")

      const summarize = byName("FundService.summarize")
      expect(summarize?.cyclomatic).toBe(3)
      expect(summarize?.loopDepth).toBe(1)
      expect(summarize?.paramCount).toBe(1)
      expect(byName("Compare")?.kind).toBe("interface")
      expect(byName("Compare.compare")?.visibility).toBe("public")
      expect(byName("Mode")?.kind).toBe("enum")
      expect(byName("Mode.Fast")?.kind).toBe("property")
      expect(byName("Hidden")?.visibility).toBe("package")

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
            edge.dstName === "Compare"
        )
      ).toBe(true)
      expect(
        parsed.edges.some(
          (edge) =>
            edge.kind === "throws" &&
            edge.srcName === "FundService.compare" &&
            edge.dstName === "IOException"
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
