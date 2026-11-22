import { FileSystem, Path } from "@effect/platform"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import * as Sqlite from "@effect/sql-sqlite-node"
import { it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { describe, expect } from "vitest"
import { FileWalkerLive } from "../src/services/FileWalker.js"
import { Indexer, IndexerLive } from "../src/services/Indexer.js"
import { IndexStore, IndexStoreLive } from "../src/services/IndexStore.js"
import { ParserLive } from "../src/services/Parser.js"

const makeTestLive = () => {
  const SqlLive = Sqlite.SqliteClient.layer({ filename: ":memory:" })
  const StoreLive = IndexStoreLive.pipe(Layer.provide(SqlLive))
  const PlatformLive = Layer.merge(NodeFileSystem.layer, NodePath.layer)
  const WalkerLive = FileWalkerLive.pipe(Layer.provide(PlatformLive))
  const IndexerTestLive = IndexerLive.pipe(
    Layer.provide(Layer.mergeAll(StoreLive, WalkerLive, ParserLive, PlatformLive))
  )
  return Layer.mergeAll(IndexerTestLive, StoreLive, PlatformLive)
}

describe("Index snapshots", () => {
  it.effect("records snapshots and compares two runs", () =>
    Effect.gen(function* () {
      const indexer = yield* Indexer
      const store = yield* IndexStore
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const tmpDir = path.resolve(`./.test-tmp-snapshots-${Date.now()}`)
      yield* fs.makeDirectory(tmpDir, { recursive: true })

      try {
        const file = path.join(tmpDir, "a.ts")
        yield* fs.writeFileString(file, "export function one(): number { return 1 }\n")

        const report = yield* indexer.indexRepo(tmpDir, { name: "snapshots" })
        const initial = yield* store.listSnapshots(report.repoId)
        expect(initial).toHaveLength(1)
        expect(initial[0]?.files).toBe(1)

        const noComparison = yield* store.compareSnapshots(report.repoId)
        expect(noComparison).toBeNull()

        yield* fs.writeFileString(
          file,
          "export function one(): number { return 1 }\nexport function two(): number { return 2 }\n"
        )
        yield* indexer.indexRepo(tmpDir, { name: "snapshots" })

        const snapshots = yield* store.listSnapshots(report.repoId)
        expect(snapshots).toHaveLength(2)

        const comparison = yield* store.compareSnapshots(report.repoId)
        expect(comparison).not.toBeNull()
        const total = (name: string) =>
          comparison?.totals.find((entry) => entry.name === name)?.delta
        expect(total("files")).toBe(0)
        expect(total("symbols")).toBe(1)
        expect(total("edges")).toBe(0)
        expect(comparison?.symbolKinds.find((entry) => entry.name === "function")?.delta).toBe(1)
        expect(comparison?.from.id).not.toBe(comparison?.to.id)

        const byId = yield* store.compareSnapshots(
          report.repoId,
          snapshots[1]?.id,
          snapshots[0]?.id
        )
        expect(byId?.to.id).toBe(snapshots[0]?.id)

        const missing = yield* store.compareSnapshots(report.repoId, "missing", "alsomissing")
        expect(missing).toBeNull()
      } finally {
        yield* fs.remove(tmpDir, { recursive: true }).pipe(Effect.ignore)
      }
    }).pipe(Effect.provide(makeTestLive()))
  )
})
