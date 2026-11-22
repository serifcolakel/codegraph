import { FileSystem, Path } from "@effect/platform"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import * as Sqlite from "@effect/sql-sqlite-node"
import { it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { describe, expect } from "vitest"
import { FileWalkerLive } from "../src/services/FileWalker.js"
import { Freshness, FreshnessLive } from "../src/services/Freshness.js"
import { Indexer, IndexerLive } from "../src/services/Indexer.js"
import { IndexStoreLive } from "../src/services/IndexStore.js"
import { ParserLive } from "../src/services/Parser.js"

const makeTestLive = () => {
  const SqlLive = Sqlite.SqliteClient.layer({ filename: ":memory:" })
  const StoreLive = IndexStoreLive.pipe(Layer.provide(SqlLive))
  const PlatformLive = Layer.merge(NodeFileSystem.layer, NodePath.layer)
  const WalkerLive = FileWalkerLive.pipe(Layer.provide(PlatformLive))
  const FreshnessServiceLive = FreshnessLive.pipe(
    Layer.provide(Layer.mergeAll(StoreLive, WalkerLive, PlatformLive))
  )
  const IndexerTestLive = IndexerLive.pipe(
    Layer.provide(Layer.mergeAll(StoreLive, WalkerLive, ParserLive, PlatformLive))
  )
  return Layer.mergeAll(IndexerTestLive, StoreLive, FreshnessServiceLive, PlatformLive)
}

describe("Index freshness", () => {
  it.effect("reports added, modified and deleted files since the last index", () =>
    Effect.gen(function* () {
      const indexer = yield* Indexer
      const freshness = yield* Freshness
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const tmpDir = path.resolve(`./.test-tmp-freshness-${Date.now()}`)
      yield* fs.makeDirectory(tmpDir, { recursive: true })

      try {
        const fileA = path.join(tmpDir, "a.ts")
        const fileC = path.join(tmpDir, "c.ts")
        yield* fs.writeFileString(fileA, "export function a(): number { return 1 }\n")
        yield* fs.writeFileString(fileC, "export function c(): number { return 3 }\n")

        const report = yield* indexer.indexRepo(tmpDir, { name: "freshness" })

        const current = yield* freshness.check(report.repoId)
        expect(current.stale).toBe(false)
        expect(current.files.unchanged).toBe(2)
        expect(current.files.added).toBe(0)

        yield* fs.writeFileString(fileA, "export function a(): number { return 2 }\n")
        yield* fs.writeFileString(
          path.join(tmpDir, "b.ts"),
          "export function b(): number { return 2 }\n"
        )
        yield* fs.remove(fileC)

        const stale = yield* freshness.check(report.repoId)
        expect(stale.stale).toBe(true)
        expect(stale.files.added).toBe(1)
        expect(stale.files.modified).toBe(1)
        expect(stale.files.deleted).toBe(1)
        expect(stale.samples.added.map((sample) => sample.path)).toContain("b.ts")
        expect(stale.samples.modified.map((sample) => sample.path)).toContain("a.ts")
        expect(stale.samples.deleted.map((sample) => sample.path)).toContain("c.ts")

        const missing = yield* freshness.check("does-not-exist").pipe(Effect.flip)
        expect(missing._tag).toBe("NotFoundError")
      } finally {
        yield* fs.remove(tmpDir, { recursive: true }).pipe(Effect.ignore)
      }
    }).pipe(Effect.provide(makeTestLive()))
  )
})
