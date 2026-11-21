import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import * as Sqlite from "@effect/sql-sqlite-node"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { FileSystem, Path } from "@effect/platform"
import { FileWalker, FileWalkerLive } from "../src/services/FileWalker.js"
import { Parser, ParserLive } from "../src/services/Parser.js"
import { IndexStore, IndexStoreLive } from "../src/services/IndexStore.js"
import { Indexer, IndexerLive } from "../src/services/Indexer.js"

describe("Indexer service (incremental indexing)", () => {
  it.effect("indexes a repository and skips unchanged files on subsequent runs", () =>
    Effect.gen(function* () {
      const indexer = yield* Indexer
      const store = yield* IndexStore
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      // Create a temporary test repo directory
      const tmpDir = path.resolve("./.test-tmp-repo-" + Date.now())
      yield* fs.makeDirectory(tmpDir, { recursive: true })

      try {
        const fileA = path.join(tmpDir, "a.ts")
        const fileB = path.join(tmpDir, "b.ts")

        yield* fs.writeFileString(fileA, "export function add(x: number, y: number): number { return x + y; }")
        yield* fs.writeFileString(fileB, "import { add } from './a'; export function calc() { return add(1, 2); }")

        // 1. Initial indexing
        const report1 = yield* indexer.indexRepo(tmpDir, { name: "test-repo" })
        expect(report1.filesIndexed).toBe(2)
        expect(report1.filesSkipped).toBe(0)
        expect(report1.filesDeleted).toBe(0)
        expect(report1.symbolsCount).toBeGreaterThanOrEqual(2)

        // 2. Second indexing without changes -> should skip all files
        const report2 = yield* indexer.indexRepo(tmpDir, { name: "test-repo" })
        expect(report2.filesIndexed).toBe(0)
        expect(report2.filesSkipped).toBe(2)
        expect(report2.filesDeleted).toBe(0)

        // 3. Modify fileA -> only fileA should be re-indexed
        yield* fs.writeFileString(fileA, "export function add(x: number, y: number, z = 0): number { return x + y + z; }")
        const report3 = yield* indexer.indexRepo(tmpDir, { name: "test-repo" })
        expect(report3.filesIndexed).toBe(1)
        expect(report3.filesSkipped).toBe(1)
        expect(report3.filesDeleted).toBe(0)

        // 4. Delete fileB -> should be deleted from index
        yield* fs.remove(fileB)
        const report4 = yield* indexer.indexRepo(tmpDir, { name: "test-repo" })
        expect(report4.filesIndexed).toBe(0)
        expect(report4.filesSkipped).toBe(1)
        expect(report4.filesDeleted).toBe(1)

        const finalStats = yield* store.getStats(report1.repoId)
        expect(finalStats.files).toBe(1)
      } finally {
        yield* fs.remove(tmpDir, { recursive: true }).pipe(Effect.ignore)
      }
    }).pipe(
      Effect.provide(
        (() => {
          const SqlLive = Sqlite.SqliteClient.layer({ filename: ":memory:" })
          const StoreLive = IndexStoreLive.pipe(Layer.provide(SqlLive))
          const PlatformLive = Layer.merge(NodeFileSystem.layer, NodePath.layer)
          const WalkerLive = FileWalkerLive.pipe(Layer.provide(PlatformLive))
          const IndexerTestLive = IndexerLive.pipe(
            Layer.provide(Layer.mergeAll(StoreLive, WalkerLive, ParserLive, PlatformLive))
          )
          return Layer.mergeAll(IndexerTestLive, StoreLive, PlatformLive)
        })()
      )
    )
  )
})
