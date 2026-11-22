import { FileSystem, Path } from "@effect/platform"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import * as Sqlite from "@effect/sql-sqlite-node"
import { it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { describe, expect } from "vitest"
import { FileWalkerLive } from "../src/services/FileWalker.js"
import { GraphQuery, GraphQueryLive } from "../src/services/GraphQuery.js"
import { Indexer, IndexerLive } from "../src/services/Indexer.js"
import { IndexStoreLive } from "../src/services/IndexStore.js"
import { Parser, ParserLive } from "../src/services/Parser.js"

const makeTestLive = () => {
  const SqlLive = Sqlite.SqliteClient.layer({ filename: ":memory:" })
  const StoreLive = IndexStoreLive.pipe(Layer.provide(SqlLive))
  const QueryLive = GraphQueryLive.pipe(Layer.provide(SqlLive))
  const PlatformLive = Layer.merge(NodeFileSystem.layer, NodePath.layer)
  const WalkerLive = FileWalkerLive.pipe(Layer.provide(PlatformLive))
  const IndexerTestLive = IndexerLive.pipe(
    Layer.provide(Layer.mergeAll(StoreLive, WalkerLive, ParserLive, PlatformLive))
  )
  return Layer.mergeAll(IndexerTestLive, StoreLive, QueryLive, PlatformLive)
}

describe("OpenAPI and GraphQL schemas", () => {
  it.effect("extracts OpenAPI JSON/YAML routes", () =>
    Effect.gen(function* () {
      const parser = yield* Parser

      const json = yield* parser.parse(
        "openapi.json",
        JSON.stringify({
          openapi: "3.0.0",
          paths: {
            "/funds": {
              get: { summary: "List funds" },
              post: { summary: "Create fund" }
            },
            "/funds/{id}": { delete: { summary: "Delete fund" } }
          }
        })
      )
      expect(json.symbols.map((symbol) => symbol.name)).toEqual([
        "GET /funds",
        "POST /funds",
        "DELETE /funds/{id}"
      ])
      expect(json.symbols[0]?.doc).toContain("List funds")

      const yaml = yield* parser.parse(
        "swagger.yaml",
        `openapi: 3.0.0
paths:
  /users:
    get:
      summary: List users
    post:
      summary: Create user
`
      )
      expect(yaml.symbols.map((symbol) => symbol.name)).toEqual(["GET /users", "POST /users"])
    }).pipe(Effect.provide(ParserLive))
  )

  it.effect("extracts GraphQL types, fields and enums", () =>
    Effect.gen(function* () {
      const parser = yield* Parser
      const parsed = yield* parser.parse(
        "schema.graphql",
        `# The query root
type Query {
  funds(id: ID!): Fund
  users: [User!]!
}

enum Status {
  ACTIVE
  INACTIVE
}

interface Node {
  id: ID!
}
`
      )

      const byName = (name: string) => parsed.symbols.find((symbol) => symbol.name === name)
      expect(byName("Query")?.kind).toBe("type")
      expect(byName("Query")?.doc).toContain("query root")
      expect(byName("Query.funds")?.kind).toBe("property")
      expect(byName("Query.funds")?.containerName).toBe("Query")
      expect(byName("Status")?.kind).toBe("enum")
      expect(byName("Status.ACTIVE")?.kind).toBe("property")
      expect(byName("Node")?.kind).toBe("interface")
      expect(byName("Node.id")?.kind).toBe("property")
    }).pipe(Effect.provide(ParserLive))
  )

  it.effect("indexes OpenAPI and GraphQL files discovered by the walker", () =>
    Effect.gen(function* () {
      const indexer = yield* Indexer
      const query = yield* GraphQuery
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const tmpDir = path.resolve(`./.test-tmp-schemas-${Date.now()}`)
      yield* fs.makeDirectory(tmpDir, { recursive: true })

      try {
        yield* fs.writeFileString(
          path.join(tmpDir, "openapi.json"),
          JSON.stringify({ paths: { "/funds": { get: { summary: "List" } } } })
        )
        yield* fs.writeFileString(
          path.join(tmpDir, "schema.graphql"),
          "type Fund {\n  id: ID!\n}\n"
        )

        const report = yield* indexer.indexRepo(tmpDir, { name: "schemas" })
        expect(report.filesIndexed).toBe(2)

        const routes = yield* query.searchSymbols("GET", 10, report.repoId)
        expect(routes.some((symbol) => symbol.name === "GET /funds")).toBe(true)

        const types = yield* query.searchSymbols("Fund", 10, report.repoId)
        expect(types.some((symbol) => symbol.name === "Fund" && symbol.kind === "type")).toBe(true)
        expect(types.some((symbol) => symbol.name === "Fund.id")).toBe(true)
      } finally {
        yield* fs.remove(tmpDir, { recursive: true }).pipe(Effect.ignore)
      }
    }).pipe(Effect.provide(makeTestLive()))
  )
})
