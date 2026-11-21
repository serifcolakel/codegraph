import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { Parser, ParserLive } from "../src/services/Parser.js"

const SOURCE = `
import os
from typing import List

MAX_SIZE = 10

class Base:
    pass

class FundService(Base):
    """Fund service docs."""

    count = 0

    def compare(self, codes: List[str]) -> str:
        """Compare funds.

        :raises ValueError: when codes are empty.
        """
        return helper(codes)

    async def remote(self):
        pass

def _hidden():
    pass

def helper(codes):
    return len(codes)
`

describe("Python tree-sitter parser", () => {
  it.effect("extracts AST-backed symbols, docs, visibility and edges", () =>
    Effect.gen(function* () {
      const parser = yield* Parser
      const parsed = yield* parser.parse("service/funds.py", SOURCE)

      expect(parsed.parseStatus).toBe("parsed")

      const byName = (name: string) => parsed.symbols.find((symbol) => symbol.name === name)

      const service = byName("FundService")
      expect(service?.kind).toBe("class")
      expect(service?.doc).toContain("Fund service docs")
      expect(service?.signature).toContain("class FundService(Base)")
      expect(service?.visibility).toBe("public")

      const compare = byName("FundService.compare")
      expect(compare?.kind).toBe("method")
      expect(compare?.containerName).toBe("FundService")
      expect(compare?.doc).toContain("Compare funds")
      expect(compare?.signature).toContain("codes: List[str]")
      expect(compare?.visibility).toBe("public")

      expect(byName("FundService.remote")?.kind).toBe("method")
      expect(byName("FundService.count")?.kind).toBe("property")
      expect(byName("MAX_SIZE")?.kind).toBe("const")
      expect(byName("_hidden")?.visibility).toBe("private")

      expect(
        parsed.edges.some(
          (edge) =>
            edge.kind === "extends" && edge.srcName === "FundService" && edge.dstName === "Base"
        )
      ).toBe(true)

      expect(
        parsed.edges.some(
          (edge) =>
            edge.kind === "contains" &&
            edge.srcName === "FundService" &&
            edge.dstName === "FundService.compare"
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
      expect(
        parsed.edges.some(
          (edge) =>
            edge.kind === "raises" &&
            edge.srcName === "FundService.compare" &&
            edge.dstName === "ValueError"
        )
      ).toBe(true)
    }).pipe(Effect.provide(ParserLive))
  )
})
