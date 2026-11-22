import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { Parser, ParserLive } from "../src/services/Parser.js"

const SOURCE = `
package funds

import "fmt"

// MaxSize is the limit.
const MaxSize = 10

// Fund is a fund model.
type Fund struct {
  Code string
}

type Service interface {
  Compare(codes []string) string
}

// Compare compares funds.
func (f *Fund) Compare(codes []string) string {
  return helper(codes)
}

func helper(codes []string) string { return fmt.Sprintf("%v", codes) }

func summarize(values []int) int {
  total := 0
  for _, value := range values {
    if value > 0 {
      total += value
    }
  }
  return total
}

type hidden struct{}
`

describe("Go tree-sitter parser", () => {
  it.effect("extracts AST-backed symbols, visibility and edges", () =>
    Effect.gen(function* () {
      const parser = yield* Parser
      const parsed = yield* parser.parse("internal/funds/funds.go", SOURCE)

      expect(parsed.parseStatus).toBe("parsed")
      const byName = (name: string) => parsed.symbols.find((symbol) => symbol.name === name)

      const fund = byName("Fund")
      expect(fund?.kind).toBe("class")
      expect(fund?.doc).toContain("fund model")
      expect(fund?.visibility).toBe("public")

      expect(byName("Fund.Code")?.kind).toBe("property")
      expect(byName("Fund.Code")?.containerName).toBe("Fund")

      const service = byName("Service")
      expect(service?.kind).toBe("interface")
      expect(byName("Service.Compare")?.kind).toBe("method")

      const compare = byName("Fund.Compare")
      expect(compare?.kind).toBe("method")
      expect(compare?.containerName).toBe("Fund")
      expect(compare?.doc).toContain("Compare compares")
      expect(compare?.signature).toContain("func (f *Fund) Compare")

      expect(byName("MaxSize")?.kind).toBe("const")

      const summarize = byName("summarize")
      expect(summarize?.cyclomatic).toBe(3)
      expect(summarize?.loopDepth).toBe(1)
      expect(summarize?.paramCount).toBe(1)
      expect(byName("hidden")?.visibility).toBe("package")

      expect(
        parsed.edges.some(
          (edge) =>
            edge.kind === "call" && edge.srcName === "Fund.Compare" && edge.dstName === "helper"
        )
      ).toBe(true)

      expect(
        parsed.edges.some(
          (edge) => edge.kind === "call" && edge.dstName === "Sprintf" && edge.importPath === "fmt"
        )
      ).toBe(true)
    }).pipe(Effect.provide(ParserLive))
  )
})
