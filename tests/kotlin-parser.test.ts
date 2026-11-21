import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { Parser, ParserLive } from "../src/services/Parser.js"

const SOURCE = `
package demo

/** Fund service. */
class FundService : Base(), Compare {
    private val count = 0

    /** Compares funds. */
    override fun compare(codes: List<String>): String {
        return helper(codes)
    }
}

interface Compare {
    fun compare(codes: List<String>): String
}

object Registry {
    fun get(): Int { return 1 }
}

enum class Mode { Fast, Safe }

fun helper(codes: List<String>): String = codes.joinToString(",")
`

describe("Kotlin tree-sitter parser", () => {
  it.effect("extracts classes, modifiers, enum entries and edges", () =>
    Effect.gen(function* () {
      const parser = yield* Parser
      const parsed = yield* parser.parse("src/main/kotlin/FundService.kt", SOURCE)

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
      expect(compare?.signature).toContain("override fun compare")

      expect(byName("FundService.count")?.visibility).toBe("private")
      expect(byName("Compare")?.kind).toBe("interface")
      expect(byName("Registry")?.kind).toBe("class")
      expect(byName("Mode")?.kind).toBe("enum")
      expect(byName("Mode.Fast")?.kind).toBe("property")
      expect(byName("helper")?.kind).toBe("function")

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
            edge.kind === "call" &&
            edge.srcName === "FundService.compare" &&
            edge.dstName === "helper"
        )
      ).toBe(true)
    }).pipe(Effect.provide(ParserLive))
  )
})
