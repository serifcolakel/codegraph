import { FileSystem, Path } from "@effect/platform"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import * as Sqlite from "@effect/sql-sqlite-node"
import { it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { describe, expect } from "vitest"
import { Diagnostics, DiagnosticsLive } from "../src/services/Diagnostics.js"
import { FileWalkerLive } from "../src/services/FileWalker.js"
import { GraphQuery, GraphQueryLive } from "../src/services/GraphQuery.js"
import { Indexer, IndexerLive } from "../src/services/Indexer.js"
import { IndexStoreLive } from "../src/services/IndexStore.js"
import { ParserLive } from "../src/services/Parser.js"

const TestLive = (() => {
  const SqlLive = Sqlite.SqliteClient.layer({ filename: ":memory:" })
  const StoreLive = IndexStoreLive.pipe(Layer.provide(SqlLive))
  const QueryLive = GraphQueryLive.pipe(Layer.provide(SqlLive))
  const DiagnosticsServiceLive = DiagnosticsLive.pipe(
    Layer.provide(Layer.mergeAll(StoreLive, SqlLive))
  )
  const PlatformLive = Layer.merge(NodeFileSystem.layer, NodePath.layer)
  const WalkerLive = FileWalkerLive.pipe(Layer.provide(PlatformLive))
  const IndexerTestLive = IndexerLive.pipe(
    Layer.provide(Layer.mergeAll(StoreLive, WalkerLive, ParserLive, PlatformLive))
  )
  return Layer.mergeAll(IndexerTestLive, StoreLive, QueryLive, DiagnosticsServiceLive, PlatformLive)
})()

describe("File-level import edges", () => {
  it.effect("records type-only workspace imports and unresolved external imports", () =>
    Effect.gen(function* () {
      const indexer = yield* Indexer
      const query = yield* GraphQuery
      const diagnostics = yield* Diagnostics
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const tmpDir = path.resolve(`./.test-tmp-file-imports-${Date.now()}`)
      yield* fs.makeDirectory(path.join(tmpDir, "packages/core/src"), { recursive: true })
      yield* fs.makeDirectory(path.join(tmpDir, "apps/app/src"), { recursive: true })

      try {
        yield* fs.writeFileString(
          path.join(tmpDir, "package.json"),
          JSON.stringify({ name: "@acme/root", workspaces: ["packages/*"] })
        )
        yield* fs.writeFileString(
          path.join(tmpDir, "packages/core/package.json"),
          JSON.stringify({ name: "@acme/core" })
        )
        yield* fs.writeFileString(
          path.join(tmpDir, "packages/core/src/types.ts"),
          "export type Fund = { code: string }"
        )
        yield* fs.writeFileString(
          path.join(tmpDir, "apps/app/src/main.ts"),
          `
import type { Fund } from "@acme/core/src/types";
import external from "external-pkg";

export type Alias = Fund;
`
        )

        const report = yield* indexer.indexRepo(tmpDir, { name: "file-imports" })
        const graph = yield* query.fileGraph(report.repoId)

        const importEdge = graph.edges.find(
          (edge) =>
            edge.srcPath === "apps/app/src/main.ts" && edge.dstPath === "packages/core/src/types.ts"
        )
        expect(importEdge).toBeDefined()
        expect(importEdge?.kinds).toContain("imports")

        const status = yield* diagnostics.repoStatus(report.repoId)
        expect(status.imports.total).toBe(2)
        expect(status.imports.resolved).toBe(1)
        expect(status.imports.unresolved).toBe(1)
      } finally {
        yield* fs.remove(tmpDir, { recursive: true }).pipe(Effect.ignore)
      }
    }).pipe(Effect.provide(TestLive))
  )

  it.effect("records Go package imports as file edges", () =>
    Effect.gen(function* () {
      const indexer = yield* Indexer
      const query = yield* GraphQuery
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const tmpDir = path.resolve(`./.test-tmp-go-imports-${Date.now()}`)
      yield* fs.makeDirectory(path.join(tmpDir, "math"), { recursive: true })

      try {
        yield* fs.writeFileString(path.join(tmpDir, "go.mod"), "module example.com/funds\n")
        yield* fs.writeFileString(
          path.join(tmpDir, "math/math.go"),
          `package math

func Add(a int, b int) int { return a + b }
`
        )
        yield* fs.writeFileString(
          path.join(tmpDir, "main.go"),
          `package main

import "example.com/funds/math"

func unused() int { return 0 }
`
        )

        const report = yield* indexer.indexRepo(tmpDir, { name: "go-imports" })
        const graph = yield* query.fileGraph(report.repoId)
        const importEdge = graph.edges.find(
          (edge) => edge.srcPath === "main.go" && edge.dstPath === "math/math.go"
        )
        expect(importEdge).toBeDefined()
        expect(importEdge?.kinds).toContain("imports")
      } finally {
        yield* fs.remove(tmpDir, { recursive: true }).pipe(Effect.ignore)
      }
    }).pipe(Effect.provide(TestLive))
  )
})
