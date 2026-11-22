import { FileSystem, Path } from "@effect/platform"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import * as Sqlite from "@effect/sql-sqlite-node"
import { it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { describe, expect } from "vitest"
import { FileWalkerLive } from "../src/services/FileWalker.js"
import { GraphQuery, GraphQueryLive } from "../src/services/GraphQuery.js"
import { Indexer, IndexerLive } from "../src/services/Indexer.js"
import { IndexStoreLive } from "../src/services/IndexStore.js"
import { collectPackageMappings } from "../src/services/manifest.js"
import { ParserLive } from "../src/services/Parser.js"

const TestLive = (() => {
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

describe("Manifest package resolution", () => {
  it.effect("collects npm workspaces, Go modules, Cargo members and Python projects", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const tmpDir = path.resolve(`./.test-tmp-manifests-${Date.now()}`)
      yield* fs.makeDirectory(path.join(tmpDir, "packages/core"), { recursive: true })
      yield* fs.makeDirectory(path.join(tmpDir, "crates/engine"), { recursive: true })

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
          path.join(tmpDir, "go.mod"),
          "module example.com/funds\n\ngo 1.22\n"
        )
        yield* fs.writeFileString(
          path.join(tmpDir, "Cargo.toml"),
          '[workspace]\nmembers = ["crates/*"]\n'
        )
        yield* fs.writeFileString(
          path.join(tmpDir, "crates/engine/Cargo.toml"),
          '[package]\nname = "fund-engine"\nversion = "0.1.0"\n'
        )
        yield* fs.writeFileString(
          path.join(tmpDir, "pyproject.toml"),
          '[project]\nname = "fund-service"\nversion = "0.1.0"\n'
        )

        const mappings = yield* collectPackageMappings(fs, path, tmpDir)
        const byPrefix = new Map(mappings.map((mapping) => [mapping.prefix, mapping.directory]))

        expect(byPrefix.get("@acme/root")).toBe("")
        expect(byPrefix.get("@acme/core")).toBe("packages/core")
        expect(byPrefix.get("example.com/funds")).toBe("")
        expect(byPrefix.get("fund-engine")).toBe("crates/engine")
        expect(byPrefix.get("fund_engine")).toBe("crates/engine")
        expect(byPrefix.get("fund_service")).toBe("")
      } finally {
        yield* fs.remove(tmpDir, { recursive: true }).pipe(Effect.ignore)
      }
    }).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)))
  )

  it.effect("resolves npm workspace imports across packages", () =>
    Effect.gen(function* () {
      const indexer = yield* Indexer
      const query = yield* GraphQuery
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const tmpDir = path.resolve(`./.test-tmp-workspace-${Date.now()}`)
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
          path.join(tmpDir, "packages/core/src/math.ts"),
          "export function add(a: number, b: number): number { return a + b }"
        )
        yield* fs.writeFileString(
          path.join(tmpDir, "apps/app/src/main.ts"),
          `
import { add } from "@acme/core/src/math";
export function run(): number { return add(1, 2) }
`
        )

        const report = yield* indexer.indexRepo(tmpDir, { name: "workspace" })
        const graph = yield* query.fileGraph(report.repoId)
        expect(
          graph.edges.some(
            (edge) =>
              edge.srcPath === "apps/app/src/main.ts" &&
              edge.dstPath === "packages/core/src/math.ts"
          )
        ).toBe(true)
      } finally {
        yield* fs.remove(tmpDir, { recursive: true }).pipe(Effect.ignore)
      }
    }).pipe(Effect.provide(TestLive))
  )

  it.effect("resolves Go module imports by package directory", () =>
    Effect.gen(function* () {
      const indexer = yield* Indexer
      const query = yield* GraphQuery
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const tmpDir = path.resolve(`./.test-tmp-go-module-${Date.now()}`)
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

func main() { math.Add(1, 2) }
`
        )

        const report = yield* indexer.indexRepo(tmpDir, { name: "go-module" })
        const graph = yield* query.fileGraph(report.repoId)
        expect(
          graph.edges.some((edge) => edge.srcPath === "main.go" && edge.dstPath === "math/math.go")
        ).toBe(true)
      } finally {
        yield* fs.remove(tmpDir, { recursive: true }).pipe(Effect.ignore)
      }
    }).pipe(Effect.provide(TestLive))
  )
})
