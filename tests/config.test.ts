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
import { Parser, ParserLive } from "../src/services/Parser.js"

const makeTestLive = () => {
  const SqlLive = Sqlite.SqliteClient.layer({ filename: ":memory:" })
  const StoreLive = IndexStoreLive.pipe(Layer.provide(SqlLive))
  const QueryLive = GraphQueryLive.pipe(Layer.provide(SqlLive))
  const PlatformLive = Layer.merge(NodeFileSystem.layer, NodePath.layer)
  const WalkerLive = FileWalkerLive.pipe(Layer.provide(PlatformLive))
  const IndexerTestLive = IndexerLive.pipe(
    Layer.provide(Layer.mergeAll(StoreLive, WalkerLive, ParserLive, PlatformLive))
  )
  return Layer.mergeAll(IndexerTestLive, StoreLive, QueryLive, PlatformLive)
}

describe("Deployment configuration nodes", () => {
  it.effect("extracts Dockerfile stages, Compose services, K8s resources and Helm charts", () =>
    Effect.gen(function* () {
      const parser = yield* Parser

      const dockerfile = yield* parser.parse(
        "Dockerfile",
        `FROM node:20 AS builder
RUN npm ci
FROM node:20 AS runtime
CMD ["node", "dist/index.js"]
`
      )
      expect(dockerfile.symbols.map((symbol) => symbol.name)).toEqual([
        "stage:builder",
        "stage:runtime"
      ])

      const compose = yield* parser.parse(
        "docker-compose.yml",
        `services:
  web:
    image: nginx
  db:
    image: postgres
`
      )
      expect(compose.symbols.map((symbol) => symbol.name)).toEqual(["service:web", "service:db"])

      const k8s = yield* parser.parse(
        "k8s/deployment.yaml",
        `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
`
      )
      expect(k8s.symbols[0]?.name).toBe("Deployment:web")

      const chart = yield* parser.parse(
        "helm/Chart.yaml",
        `apiVersion: v2
name: codegraph
version: 0.1.0
`
      )
      expect(chart.symbols[0]?.name).toBe("chart:codegraph")
      expect(chart.symbols[0]?.doc).toContain("0.1.0")
    }).pipe(Effect.provide(ParserLive))
  )

  it.effect("indexes config files discovered by the walker", () =>
    Effect.gen(function* () {
      const indexer = yield* Indexer
      const query = yield* GraphQuery
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const tmpDir = path.resolve(`./.test-tmp-config-${Date.now()}`)
      yield* fs.makeDirectory(path.join(tmpDir, "k8s"), { recursive: true })

      try {
        yield* fs.writeFileString(path.join(tmpDir, "Dockerfile"), "FROM node:20 AS runtime\n")
        yield* fs.writeFileString(
          path.join(tmpDir, "docker-compose.yml"),
          "services:\n  web:\n    image: nginx\n"
        )
        yield* fs.writeFileString(
          path.join(tmpDir, "k8s/deployment.yaml"),
          "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n"
        )
        yield* fs.writeFileString(path.join(tmpDir, "app.ts"), "export const value = 1\n")

        const report = yield* indexer.indexRepo(tmpDir, { name: "config" })
        expect(report.filesIndexed).toBe(4)

        const dockerfile = yield* query.outlineFile(report.repoId, "Dockerfile")
        expect(dockerfile.some((symbol) => symbol.kind === "config")).toBe(true)

        const compose = yield* query.outlineFile(report.repoId, "docker-compose.yml")
        expect(compose[0]?.name).toBe("service:web")

        const search = yield* query.searchSymbols("Deployment:web", 10, report.repoId)
        expect(search.some((symbol) => symbol.name === "Deployment:web")).toBe(true)
      } finally {
        yield* fs.remove(tmpDir, { recursive: true }).pipe(Effect.ignore)
      }
    }).pipe(Effect.provide(makeTestLive()))
  )
})
