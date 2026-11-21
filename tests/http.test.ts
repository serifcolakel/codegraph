import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { createServer } from "node:http"
import { Effect, Layer } from "effect"
import * as Sqlite from "@effect/sql-sqlite-node"
import { NodeFileSystem, NodePath, NodeHttpServer } from "@effect/platform-node"
import { FileSystem, Path } from "@effect/platform"
import { FileWalkerLive } from "../src/services/FileWalker.js"
import { ParserLive } from "../src/services/Parser.js"
import { IndexStoreLive } from "../src/services/IndexStore.js"
import { Indexer, IndexerLive } from "../src/services/Indexer.js"
import { GraphQueryLive } from "../src/services/GraphQuery.js"
import { makeHttpRouter } from "../src/http/index.js"

describe("HTTP API & visualization", () => {
  it.live("serves repos, file graph, search, and static HTML", () =>
    Effect.gen(function* () {
      const indexer = yield* Indexer
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const tmpDir = path.resolve("./.test-tmp-http-" + Date.now())
      yield* fs.makeDirectory(tmpDir, { recursive: true })

      try {
        const fileA = path.join(tmpDir, "greet.ts")
        yield* fs.writeFileString(
          fileA,
          `export function greet(name: string): string { return "Hello " + name; }`
        )

        // 1. Index test repo
        const report = yield* indexer.indexRepo(tmpDir, { name: "http-test-repo" })
        expect(report.filesIndexed).toBe(1)

        // 2. Start HTTP server scoped
        const TEST_PORT = 43220
        yield* Effect.scoped(
          Effect.gen(function* () {
            const router = yield* makeHttpRouter
            const server = yield* NodeHttpServer.make(() => createServer(), { port: TEST_PORT })
            yield* server.serve(router)

            // 3. Test GET /api/repos
            const reposRes = yield* Effect.tryPromise(() =>
              fetch(`http://127.0.0.1:${TEST_PORT}/api/repos`).then(r => r.json())
            )
            expect(Array.isArray(reposRes)).toBe(true)
            expect(reposRes.length).toBeGreaterThan(0)
            expect(reposRes[0].name).toBe("http-test-repo")

            // 4. Test GET /api/graph?repo=&level=file
            const graphRes = yield* Effect.tryPromise(() =>
              fetch(`http://127.0.0.1:${TEST_PORT}/api/graph?repo=${encodeURIComponent(report.repoId)}&level=file`).then(r => r.json())
            )
            expect(graphRes.nodes).toBeDefined()
            expect(graphRes.nodes.length).toBe(1)

            // 5. Test GET /api/search?q=greet
            const searchRes = yield* Effect.tryPromise(() =>
              fetch(`http://127.0.0.1:${TEST_PORT}/api/search?q=greet`).then(r => r.json())
            )
            expect(Array.isArray(searchRes)).toBe(true)
            expect(searchRes.length).toBeGreaterThan(0)
            expect(searchRes[0].name).toBe("greet")

            // 6. Test GET / - HTML serving
            const htmlRes = yield* Effect.tryPromise(() =>
              fetch(`http://127.0.0.1:${TEST_PORT}/`).then(r => r.text())
            )
            expect(htmlRes).toContain("CodeGraph")
            expect(htmlRes).toContain("cytoscape")
          })
        )
      } finally {
        yield* fs.remove(tmpDir, { recursive: true }).pipe(Effect.ignore)
      }
    }).pipe(
      Effect.provide(
        (() => {
          const SqlLive = Sqlite.SqliteClient.layer({ filename: ":memory:" })
          const StoreLive = IndexStoreLive.pipe(Layer.provide(SqlLive))
          const QueryLive = GraphQueryLive.pipe(Layer.provide(SqlLive))
          const PlatformLive = Layer.merge(NodeFileSystem.layer, NodePath.layer)
          const WalkerLive = FileWalkerLive.pipe(Layer.provide(PlatformLive))
          const IndexerTestLive = IndexerLive.pipe(
            Layer.provide(Layer.mergeAll(StoreLive, WalkerLive, ParserLive, PlatformLive))
          )
          return Layer.mergeAll(IndexerTestLive, StoreLive, QueryLive, PlatformLive)
        })()
      )
    )
  )
})
