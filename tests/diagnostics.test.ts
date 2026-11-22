import { FileSystem, Path } from "@effect/platform"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import * as Sqlite from "@effect/sql-sqlite-node"
import { it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { describe, expect } from "vitest"
import { Diagnostics, DiagnosticsLive, formatStatus } from "../src/services/Diagnostics.js"
import { FileWalkerLive } from "../src/services/FileWalker.js"
import { Indexer, IndexerLive } from "../src/services/Indexer.js"
import { IndexStoreLive } from "../src/services/IndexStore.js"
import { ParserLive } from "../src/services/Parser.js"

describe("Diagnostics service", () => {
  it.effect("reports coverage and unresolved edge reasons", () =>
    Effect.gen(function* () {
      const indexer = yield* Indexer
      const diagnostics = yield* Diagnostics
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const tmpDir = path.resolve(`./.test-tmp-diagnostics-${Date.now()}`)
      yield* fs.makeDirectory(tmpDir, { recursive: true })

      try {
        yield* fs.writeFileString(
          path.join(tmpDir, "service.ts"),
          "export function run(): number { return missingHelper() }"
        )
        yield* fs.writeFileString(
          path.join(tmpDir, "lib.rs"),
          `
pub fn compute() -> i32 {
    missing_rust_helper()
}
`
        )

        const report = yield* indexer.indexRepo(tmpDir, { name: "diagnostics" })
        const status = yield* diagnostics.repoStatus(report.repoId)

        expect(status.repoName).toBe("diagnostics")
        expect(status.coverage.parsed).toBe(2)
        expect(status.coverage.languages.typescript).toBe(1)
        expect(status.coverage.languages.rust).toBe(1)
        expect(status.unresolved.total).toBeGreaterThanOrEqual(2)
        expect(status.unresolved.missingSymbol).toBeGreaterThanOrEqual(2)
        expect(status.unresolved.byKind.call).toBeGreaterThanOrEqual(2)
        expect(status.unresolved.samples.some((sample) => sample.target.includes("missing"))).toBe(
          true
        )

        const text = formatStatus(status)
        expect(text).toContain("coverage: parsed=2")
        expect(text).toContain("unresolved edges:")

        const statuses = yield* diagnostics.listStatuses()
        expect(statuses.some((entry) => entry.repoId === report.repoId)).toBe(true)

        const missing = yield* diagnostics.repoStatus("does-not-exist").pipe(Effect.flip)
        expect(missing._tag).toBe("NotFoundError")
      } finally {
        yield* fs.remove(tmpDir, { recursive: true }).pipe(Effect.ignore)
      }
    }).pipe(
      Effect.provide(
        (() => {
          const SqlLive = Sqlite.SqliteClient.layer({ filename: ":memory:" })
          const StoreLive = IndexStoreLive.pipe(Layer.provide(SqlLive))
          const DiagnosticsServiceLive = DiagnosticsLive.pipe(
            Layer.provide(Layer.mergeAll(StoreLive, SqlLive))
          )
          const PlatformLive = Layer.merge(NodeFileSystem.layer, NodePath.layer)
          const WalkerLive = FileWalkerLive.pipe(Layer.provide(PlatformLive))
          const IndexerTestLive = IndexerLive.pipe(
            Layer.provide(Layer.mergeAll(StoreLive, WalkerLive, ParserLive, PlatformLive))
          )
          return Layer.mergeAll(IndexerTestLive, StoreLive, DiagnosticsServiceLive, PlatformLive)
        })()
      )
    )
  )
})
