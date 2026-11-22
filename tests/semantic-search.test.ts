import { FileSystem, Path } from "@effect/platform"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import * as SqlClient from "@effect/sql/SqlClient"
import * as Sqlite from "@effect/sql-sqlite-node"
import { it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { describe, expect } from "vitest"
import { FileWalkerLive } from "../src/services/FileWalker.js"
import { GraphQuery, GraphQueryLive } from "../src/services/GraphQuery.js"
import { Indexer, IndexerLive } from "../src/services/Indexer.js"
import { IndexStoreLive } from "../src/services/IndexStore.js"
import { ParserLive } from "../src/services/Parser.js"

const makeTestLive = () => {
  const SqlLive = Sqlite.SqliteClient.layer({ filename: ":memory:" })
  const StoreLive = IndexStoreLive.pipe(Layer.provide(SqlLive))
  const QueryLive = GraphQueryLive.pipe(Layer.provide(SqlLive))
  const PlatformLive = Layer.merge(NodeFileSystem.layer, NodePath.layer)
  const WalkerLive = FileWalkerLive.pipe(Layer.provide(PlatformLive))
  const IndexerTestLive = IndexerLive.pipe(
    Layer.provide(Layer.mergeAll(StoreLive, WalkerLive, ParserLive, PlatformLive))
  )
  return Layer.mergeAll(IndexerTestLive, StoreLive, QueryLive, PlatformLive, SqlLive)
}

describe("Semantic search", () => {
  it.effect("hybrid ranking finds related symbols without a literal substring", () =>
    Effect.gen(function* () {
      const indexer = yield* Indexer
      const query = yield* GraphQuery
      const sql = yield* SqlClient.SqlClient
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const tmpDir = path.resolve(`./.test-tmp-semantic-${Date.now()}`)
      yield* fs.makeDirectory(tmpDir, { recursive: true })

      try {
        yield* fs.writeFileString(
          path.join(tmpDir, "funds.ts"),
          `
/** Tracks fund sizes for the dashboard. */
export function useFundSizes(): number[] { return [] }
export function computeTotals(values: number[]): number { return values.length }
`
        )
        yield* fs.writeFileString(
          path.join(tmpDir, "config.ts"),
          `
/** Parses YAML configuration files. */
export function parseConfigFile(): string { return "cfg" }
`
        )

        const report = yield* indexer.indexRepo(tmpDir, { name: "semantic" })

        const literal = yield* query.searchGraph({
          namePattern: "fund sizes",
          repoId: report.repoId
        })
        expect(literal.total).toBe(0)

        const semantic = yield* query.searchGraph({
          namePattern: "fund sizes",
          semantic: true,
          repoId: report.repoId,
          limit: 5
        })
        expect(semantic.results[0]?.name).toBe("useFundSizes")
        expect(semantic.results[0]?.score).toBeGreaterThan(0)

        const filtered = yield* query.searchGraph({
          namePattern: "fund sizes",
          semantic: true,
          repoId: report.repoId,
          kind: "function",
          filePattern: "funds.ts"
        })
        expect(filtered.results.every((symbol) => symbol.filePath === "funds.ts")).toBe(true)

        const vectorCount = yield* sql<{
          count: number
        }>`SELECT COUNT(*) as count FROM symbol_vectors;`
        const symbolCount = yield* sql<{ count: number }>`SELECT COUNT(*) as count FROM symbols;`
        expect(vectorCount[0]?.count).toBe(symbolCount[0]?.count)

        yield* indexer.indexRepo(tmpDir, { name: "semantic" })
        const afterReindex = yield* sql<{ count: number }>`
          SELECT COUNT(*) as count FROM symbol_vectors;
        `
        expect(afterReindex[0]?.count).toBe(symbolCount[0]?.count)
      } finally {
        yield* fs.remove(tmpDir, { recursive: true }).pipe(Effect.ignore)
      }
    }).pipe(Effect.provide(makeTestLive()))
  )
})
