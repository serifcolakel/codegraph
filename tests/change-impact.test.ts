import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { FileSystem, Path } from "@effect/platform"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import * as Sqlite from "@effect/sql-sqlite-node"
import { it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { describe, expect } from "vitest"
import { ChangeImpact, ChangeImpactLive } from "../src/services/ChangeImpact.js"
import { FileWalkerLive } from "../src/services/FileWalker.js"
import { GitChangesLive } from "../src/services/GitChanges.js"
import { GraphQueryLive } from "../src/services/GraphQuery.js"
import { Indexer, IndexerLive } from "../src/services/Indexer.js"
import { IndexStoreLive } from "../src/services/IndexStore.js"
import { ParserLive } from "../src/services/Parser.js"

const execFileAsync = promisify(execFile)

const TestLive = (() => {
  const SqlLive = Sqlite.SqliteClient.layer({ filename: ":memory:" })
  const StoreLive = IndexStoreLive.pipe(Layer.provide(SqlLive))
  const QueryLive = GraphQueryLive.pipe(Layer.provide(SqlLive))
  const ImpactLive = ChangeImpactLive.pipe(
    Layer.provide(Layer.mergeAll(StoreLive, QueryLive, GitChangesLive))
  )
  const PlatformLive = Layer.merge(NodeFileSystem.layer, NodePath.layer)
  const WalkerLive = FileWalkerLive.pipe(Layer.provide(PlatformLive))
  const IndexerTestLive = IndexerLive.pipe(
    Layer.provide(Layer.mergeAll(StoreLive, WalkerLive, ParserLive, PlatformLive))
  )
  return Layer.mergeAll(IndexerTestLive, StoreLive, QueryLive, ImpactLive, PlatformLive)
})()

describe("Change impact", () => {
  it.effect("maps a git change to affected symbols and reverse dependencies", () =>
    Effect.gen(function* () {
      const indexer = yield* Indexer
      const impact = yield* ChangeImpact
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const tmpDir = path.resolve(`./.test-tmp-impact-${Date.now()}`)
      yield* fs.makeDirectory(tmpDir, { recursive: true })

      try {
        const fileA = path.join(tmpDir, "a.ts")
        yield* fs.writeFileString(
          fileA,
          "export function helper(value: number): number { return value }"
        )
        yield* fs.writeFileString(
          path.join(tmpDir, "b.ts"),
          'import { helper } from "./a";\nexport function caller(): number { return helper(1) }\n'
        )

        yield* Effect.promise(() => execFileAsync("git", ["-C", tmpDir, "init"]))
        yield* Effect.promise(() => execFileAsync("git", ["-C", tmpDir, "add", "."]))
        yield* Effect.promise(() =>
          execFileAsync("git", [
            "-C",
            tmpDir,
            "-c",
            "user.email=codegraph@test.local",
            "-c",
            "user.name=CodeGraph Test",
            "commit",
            "-m",
            "init"
          ])
        )

        const report = yield* indexer.indexRepo(tmpDir, { name: "impact" })

        yield* fs.writeFileString(
          fileA,
          "export function helper(value: number): number { return value + 1 }"
        )

        const changes = yield* impact.detect(report.repoId)
        expect(changes.changedFiles).toContain("a.ts")
        expect(changes.indexedFiles).toContain("a.ts")
        expect(changes.affectedSymbols.some((symbol) => symbol.name === "helper")).toBe(true)
        expect(changes.affectedSymbols.some((symbol) => symbol.filePath === "a.ts")).toBe(true)

        const caller = changes.impactedSymbols.find((symbol) => symbol.name === "caller")
        expect(caller).toBeDefined()
        expect(caller?.referencedBy).toContain("helper")

        const missing = yield* impact.detect("does-not-exist").pipe(Effect.flip)
        expect(missing._tag).toBe("NotFoundError")
      } finally {
        yield* fs.remove(tmpDir, { recursive: true }).pipe(Effect.ignore)
      }
    }).pipe(Effect.provide(TestLive))
  )
})
