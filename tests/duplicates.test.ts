import { FileSystem, Path } from "@effect/platform"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import * as SqlClient from "@effect/sql/SqlClient"
import * as Sqlite from "@effect/sql-sqlite-node"
import { it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { describe, expect } from "vitest"
import { Analytics, AnalyticsLive } from "../src/services/Analytics.js"
import { FileWalkerLive } from "../src/services/FileWalker.js"
import { Indexer, IndexerLive } from "../src/services/Indexer.js"
import { IndexStoreLive } from "../src/services/IndexStore.js"
import { ParserLive } from "../src/services/Parser.js"

const makeTestLive = () => {
  const SqlLive = Sqlite.SqliteClient.layer({ filename: ":memory:" })
  const StoreLive = IndexStoreLive.pipe(Layer.provide(SqlLive))
  const AnalyticsServiceLive = AnalyticsLive.pipe(Layer.provide(SqlLive))
  const PlatformLive = Layer.merge(NodeFileSystem.layer, NodePath.layer)
  const WalkerLive = FileWalkerLive.pipe(Layer.provide(PlatformLive))
  const IndexerTestLive = IndexerLive.pipe(
    Layer.provide(Layer.mergeAll(StoreLive, WalkerLive, ParserLive, PlatformLive))
  )
  return Layer.mergeAll(IndexerTestLive, StoreLive, AnalyticsServiceLive, PlatformLive, SqlLive)
}

describe("Near-duplicate detection", () => {
  it.effect("finds similar functions and persists similar_to edges", () =>
    Effect.gen(function* () {
      const indexer = yield* Indexer
      const analytics = yield* Analytics
      const sql = yield* SqlClient.SqlClient
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const tmpDir = path.resolve(`./.test-tmp-duplicates-${Date.now()}`)
      yield* fs.makeDirectory(tmpDir, { recursive: true })

      try {
        yield* fs.writeFileString(
          path.join(tmpDir, "math.ts"),
          `
/** Adds two numbers together. */
export function add(a: number, b: number): number { return a + b }
/** Adds two numbers together. */
export function plus(a: number, b: number): number { return a + b }
/** Reads the configuration file from disk. */
export function readConfig(): string { return "cfg" }
`
        )

        const report = yield* indexer.indexRepo(tmpDir, { name: "duplicates" })
        const pairs = yield* analytics.duplicates(report.repoId, { threshold: 0.5 })
        expect(pairs.length).toBeGreaterThan(0)
        const names = pairs.flatMap((pair) => [pair.left.name, pair.right.name])
        expect(names).toEqual(expect.arrayContaining(["add", "plus"]))
        expect(pairs.every((pair) => pair.similarity >= 0.5)).toBe(true)

        const edges = yield* sql<{ count: number }>`
          SELECT COUNT(*) as count FROM edges WHERE kind = 'similar_to';
        `
        expect(edges[0]?.count).toBeGreaterThan(0)

        const none = yield* analytics.duplicates(report.repoId, { threshold: 0.999 })
        expect(none).toHaveLength(0)
        const cleared = yield* sql<{ count: number }>`
          SELECT COUNT(*) as count FROM edges WHERE kind = 'similar_to';
        `
        expect(cleared[0]?.count).toBe(0)
      } finally {
        yield* fs.remove(tmpDir, { recursive: true }).pipe(Effect.ignore)
      }
    }).pipe(Effect.provide(makeTestLive()))
  )
})
