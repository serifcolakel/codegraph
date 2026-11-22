import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { Parser, ParserLive } from "../src/services/Parser.js"

describe("Route extraction", () => {
  it.effect("extracts explicit Express-style routes", () =>
    Effect.gen(function* () {
      const parser = yield* Parser
      const parsed = yield* parser.parse(
        "src/routes.ts",
        `
function fundHandler(): number { return 1 }
router.get("/funds/:id", fundHandler)
app.post("/funds", fundHandler)
`
      )

      const route = parsed.symbols.find((symbol) => symbol.name === "GET /funds/:id")
      expect(route?.kind).toBe("route")
      expect(
        parsed.edges.some(
          (edge) =>
            edge.kind === "contains" &&
            edge.srcName === "GET /funds/:id" &&
            edge.dstName === "fundHandler"
        )
      ).toBe(true)
      expect(parsed.symbols.some((symbol) => symbol.name === "POST /funds")).toBe(true)
    }).pipe(Effect.provide(ParserLive))
  )

  it.effect("extracts Next.js app and pages routes", () =>
    Effect.gen(function* () {
      const parser = yield* Parser

      const appRoute = yield* parser.parse(
        "app/api/funds/[id]/route.ts",
        "export async function GET(): Promise<number> { return 1 }\n"
      )
      const getRoute = appRoute.symbols.find((symbol) => symbol.name === "GET /api/funds/:id")
      expect(getRoute?.kind).toBe("route")
      expect(
        appRoute.edges.some(
          (edge) => edge.kind === "contains" && edge.srcName === "GET /api/funds/:id"
        )
      ).toBe(true)

      const pagesRoute = yield* parser.parse(
        "pages/api/users/index.ts",
        "export default function handler(): number { return 1 }\n"
      )
      expect(pagesRoute.symbols.some((symbol) => symbol.name === "ALL /api/users")).toBe(true)
    }).pipe(Effect.provide(ParserLive))
  )

  it.effect("extracts Python decorator routes", () =>
    Effect.gen(function* () {
      const parser = yield* Parser
      const parsed = yield* parser.parse(
        "service/funds.py",
        `
from fastapi import FastAPI

app = FastAPI()

@app.get("/funds/{fund_id}")
def get_fund(fund_id: str):
    return fund_id

@app.route("/funds", methods=["GET", "POST"])
def create_fund():
    return None
`
      )

      expect(parsed.symbols.some((symbol) => symbol.name === "GET /funds/{fund_id}")).toBe(true)
      expect(parsed.symbols.some((symbol) => symbol.name === "GET /funds")).toBe(true)
      expect(parsed.symbols.some((symbol) => symbol.name === "POST /funds")).toBe(true)
      expect(
        parsed.edges.some(
          (edge) =>
            edge.kind === "contains" &&
            edge.srcName === "GET /funds/{fund_id}" &&
            edge.dstName === "get_fund"
        )
      ).toBe(true)
    }).pipe(Effect.provide(ParserLive))
  )
})
