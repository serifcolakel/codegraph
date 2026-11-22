import { FileSystem, Path } from "@effect/platform"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import * as SqlClient from "@effect/sql/SqlClient"
import * as Sqlite from "@effect/sql-sqlite-node"
import { it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { describe, expect } from "vitest"
import { Artifacts, ArtifactsLive } from "../src/services/Artifacts.js"
import { FileWalkerLive } from "../src/services/FileWalker.js"
import { GraphQuery, GraphQueryLive } from "../src/services/GraphQuery.js"
import { Indexer, IndexerLive } from "../src/services/Indexer.js"
import { IndexStore, IndexStoreLive } from "../src/services/IndexStore.js"
import { ParserLive } from "../src/services/Parser.js"

const makeTestLive = () => {
  const SqlLive = Sqlite.SqliteClient.layer({ filename: ":memory:" })
  const StoreLive = IndexStoreLive.pipe(Layer.provide(SqlLive))
  const QueryLive = GraphQueryLive.pipe(Layer.provide(SqlLive))
  const PlatformLive = Layer.merge(NodeFileSystem.layer, NodePath.layer)
  const WalkerLive = FileWalkerLive.pipe(Layer.provide(PlatformLive))
  const ArtifactsServiceLive = ArtifactsLive.pipe(
    Layer.provide(Layer.mergeAll(StoreLive, SqlLive, PlatformLive))
  )
  const IndexerTestLive = IndexerLive.pipe(
    Layer.provide(Layer.mergeAll(StoreLive, WalkerLive, ParserLive, PlatformLive))
  )
  return Layer.mergeAll(
    IndexerTestLive,
    StoreLive,
    QueryLive,
    ArtifactsServiceLive,
    PlatformLive,
    SqlLive
  )
}

describe("Graph artifacts", () => {
  it.effect("exports, imports and then updates incrementally", () =>
    Effect.gen(function* () {
      const indexer = yield* Indexer
      const store = yield* IndexStore
      const query = yield* GraphQuery
      const artifacts = yield* Artifacts
      const sql = yield* SqlClient.SqlClient
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const root = path.resolve(`./.test-tmp-artifact-${Date.now()}`)
      const repoA = path.join(root, "repo-a")
      const repoB = path.join(root, "repo-b")
      const artifactPath = path.join(root, "graph.json.gz")
      yield* fs.makeDirectory(repoA, { recursive: true })
      yield* fs.makeDirectory(repoB, { recursive: true })

      try {
        yield* fs.writeFileString(
          path.join(repoA, "a.ts"),
          "export function shared(value: number): number { return value }\n"
        )
        yield* fs.writeFileString(
          path.join(repoA, "b.ts"),
          "export function onlyRemote(): number { return 1 }\n"
        )
        const reportA = yield* indexer.indexRepo(repoA, { name: "artifact" })

        const exported = yield* artifacts.exportRepo(reportA.repoId, artifactPath)
        expect(exported.files).toBe(2)
        expect(exported.symbols).toBeGreaterThanOrEqual(2)
        const compressed = yield* fs.readFile(artifactPath)
        expect(compressed[0]).toBe(0x1f)
        expect(compressed[1]).toBe(0x8b)

        yield* fs.writeFileString(
          path.join(repoB, "a.ts"),
          "export function shared(value: number): number { return value }\n"
        )
        const imported = yield* artifacts.importRepo(artifactPath, repoB)
        expect(imported.files).toBe(2)

        const files = yield* store.getFiles(imported.repoId)
        expect(files.size).toBe(2)
        const search = yield* query.searchSymbols("onlyRemote", 10, imported.repoId)
        expect(search.some((symbol) => symbol.name === "onlyRemote")).toBe(true)
        const vectors = yield* sql<{ count: number }>`
          SELECT COUNT(*) as count FROM symbol_vectors v
          JOIN symbols s ON v.symbol_id = s.id
          JOIN files f ON s.file_id = f.id
          WHERE f.repo_id = ${imported.repoId};
        `
        expect(vectors[0]?.count).toBeGreaterThan(0)

        yield* fs.writeFileString(
          path.join(repoB, "c.ts"),
          "export function localOnly(): number { return 2 }\n"
        )
        const update = yield* indexer.indexRepo(repoB)
        expect(update.filesIndexed).toBe(1)
        expect(update.filesDeleted).toBe(1)
        expect((yield* store.getFiles(imported.repoId)).size).toBe(2)
        expect(
          (yield* query.searchSymbols("localOnly", 10, imported.repoId)).some(
            (symbol) => symbol.name === "localOnly"
          )
        ).toBe(true)

        const refused = yield* artifacts.importRepo(artifactPath, repoB).pipe(Effect.flip)
        expect(refused._tag).toBe("StoreError")

        const forced = yield* artifacts.importRepo(artifactPath, repoB, { force: true })
        expect(forced.files).toBe(2)
        expect((yield* store.getFiles(imported.repoId)).size).toBe(2)
      } finally {
        yield* fs.remove(root, { recursive: true }).pipe(Effect.ignore)
      }
    }).pipe(Effect.provide(makeTestLive()))
  )
})
