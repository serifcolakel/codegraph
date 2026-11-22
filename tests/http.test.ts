import { createServer } from "node:http"
import { FileSystem, Path } from "@effect/platform"
import { NodeFileSystem, NodeHttpServer, NodePath } from "@effect/platform-node"
import * as Sqlite from "@effect/sql-sqlite-node"
import { it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { describe, expect } from "vitest"
import { makeHttpRouter } from "../src/http/index.js"
import { AnalyticsLive } from "../src/services/Analytics.js"
import { ChangeImpactLive } from "../src/services/ChangeImpact.js"
import { FileWalkerLive } from "../src/services/FileWalker.js"
import { GitChangesLive } from "../src/services/GitChanges.js"
import { GraphQueryLive } from "../src/services/GraphQuery.js"
import { Indexer, IndexerLive } from "../src/services/Indexer.js"
import { IndexJobRunnerLive } from "../src/services/IndexJobRunner.js"
import { IndexJobsLive } from "../src/services/IndexJobs.js"
import { IndexStoreLive } from "../src/services/IndexStore.js"
import { ParserLive } from "../src/services/Parser.js"

describe("HTTP API & visualization", () => {
  it.live("serves repos, file graph, search, and static HTML", () =>
    Effect.gen(function* () {
      const indexer = yield* Indexer
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const tmpDir = path.resolve(`./.test-tmp-http-${Date.now()}`)
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
              fetch(`http://127.0.0.1:${TEST_PORT}/api/repos`).then((r) => r.json())
            )
            expect(Array.isArray(reposRes)).toBe(true)
            expect(reposRes.length).toBeGreaterThan(0)
            expect(reposRes[0].name).toBe("http-test-repo")
            expect(reposRes[0].files).toBe(1)
            expect(reposRes[0].sourceBytes).toBeGreaterThan(0)
            expect(typeof reposRes[0].indexedAt).toBe("string")
            expect(reposRes[0].indexDurationMs).toBeGreaterThanOrEqual(0)

            // 4. GET /api/coverage includes parse coverage and import diagnostics
            const coverageRes = yield* Effect.tryPromise(() =>
              fetch(
                `http://127.0.0.1:${TEST_PORT}/api/coverage?repo=${encodeURIComponent(report.repoId)}`
              ).then((r) => r.json())
            )
            expect(coverageRes.repoId).toBe(report.repoId)
            expect(coverageRes.coverage.parsed).toBe(1)
            expect(coverageRes.imports.total).toBe(0)

            // 5. GET /api/architecture summarizes languages and packages
            const architectureRes = yield* Effect.tryPromise(() =>
              fetch(
                `http://127.0.0.1:${TEST_PORT}/api/architecture?repo=${encodeURIComponent(report.repoId)}`
              ).then((r) => r.json())
            )
            expect(architectureRes.languages.typescript).toBe(1)
            expect(Array.isArray(architectureRes.packages)).toBe(true)
            expect(Array.isArray(architectureRes.hotspots)).toBe(true)

            // 8. Test GET /api/graph?repo=&level=file
            const graphRes = yield* Effect.tryPromise(() =>
              fetch(
                `http://127.0.0.1:${TEST_PORT}/api/graph?repo=${encodeURIComponent(report.repoId)}&level=file`
              ).then((r) => r.json())
            )
            expect(graphRes.nodes).toBeDefined()
            expect(graphRes.nodes.length).toBe(1)

            // 9. Test GET /api/search?q=greet
            const searchRes = yield* Effect.tryPromise(() =>
              fetch(`http://127.0.0.1:${TEST_PORT}/api/search?q=greet`).then((r) => r.json())
            )
            expect(Array.isArray(searchRes)).toBe(true)
            expect(searchRes.length).toBeGreaterThan(0)
            expect(searchRes[0].name).toBe("greet")

            // 10. Test GET / - HTML serving
            const htmlRes = yield* Effect.tryPromise(() =>
              fetch(`http://127.0.0.1:${TEST_PORT}/`).then((r) => r.text())
            )
            expect(htmlRes).toContain("CodeGraph")
            expect(htmlRes).toContain("cytoscape")

            // 11. POST /api/reindex refreshes an existing repository
            const reindexRes = yield* Effect.tryPromise(() =>
              fetch(`http://127.0.0.1:${TEST_PORT}/api/reindex`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ repoId: report.repoId })
              }).then((r) => r.json())
            )
            expect(reindexRes.filesIndexed).toBe(0)
            expect(reindexRes.filesSkipped).toBe(1)

            // 12. POST /api/index indexes a new folder from the web UI/API
            const secondDir = path.join(tmpDir, "second-repo")
            yield* fs.makeDirectory(secondDir, { recursive: true })
            yield* fs.writeFileString(path.join(secondDir, "other.ts"), `export const answer = 42;`)
            const indexRes = yield* Effect.tryPromise(() =>
              fetch(`http://127.0.0.1:${TEST_PORT}/api/index`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ path: secondDir, name: "second-repo" })
              }).then((r) => r.json())
            )
            expect(indexRes.filesIndexed).toBe(1)
            expect(indexRes.repoName).toBe("second-repo")

            const reposAfter = yield* Effect.tryPromise(() =>
              fetch(`http://127.0.0.1:${TEST_PORT}/api/repos`).then((r) => r.json())
            )
            expect(reposAfter.length).toBe(2)

            // 13. DELETE /api/repos/:id removes an index without touching files
            const secondRepo = reposAfter.find(
              (repo: { name: string }) => repo.name === "second-repo"
            )
            expect(secondRepo).toBeDefined()
            const deleteRes = yield* Effect.tryPromise(() =>
              fetch(
                `http://127.0.0.1:${TEST_PORT}/api/repos/${encodeURIComponent(secondRepo.id)}`,
                { method: "DELETE" }
              ).then((r) => r.json())
            )
            expect(deleteRes.deleted).toBe(true)

            const reposAfterDelete = yield* Effect.tryPromise(() =>
              fetch(`http://127.0.0.1:${TEST_PORT}/api/repos`).then((r) => r.json())
            )
            expect(reposAfterDelete.length).toBe(1)

            const secondFiles = yield* fs.readDirectory(secondDir)
            expect(secondFiles).toContain("other.ts")

            const deleteMissing = yield* Effect.tryPromise(() =>
              fetch(
                `http://127.0.0.1:${TEST_PORT}/api/repos/${encodeURIComponent(secondRepo.id)}`,
                { method: "DELETE" }
              ).then((r) => r.status)
            )
            expect(deleteMissing).toBe(404)

            // 14. Async indexing returns a job and exposes its status
            const asyncDir = path.join(tmpDir, "async-repo")
            yield* fs.makeDirectory(asyncDir, { recursive: true })
            yield* fs.writeFileString(path.join(asyncDir, "async.ts"), "export const value = 1;")

            const createdJob = yield* Effect.tryPromise(() =>
              fetch(`http://127.0.0.1:${TEST_PORT}/api/index`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ path: asyncDir, name: "async-repo", async: true })
              }).then((r) => r.json())
            )
            expect(createdJob.id).toMatch(/^job_/)
            expect(["queued", "running"]).toContain(createdJob.status)

            let asyncJob = createdJob
            for (let attempt = 0; attempt < 100; attempt++) {
              if (asyncJob.status === "completed" || asyncJob.status === "failed") break
              yield* Effect.sleep("50 millis")
              asyncJob = yield* Effect.tryPromise(() =>
                fetch(`http://127.0.0.1:${TEST_PORT}/api/jobs/${createdJob.id}`).then((r) =>
                  r.json()
                )
              )
            }
            expect(asyncJob.status).toBe("completed")
            expect(asyncJob.repoId).toBeTruthy()

            const jobsList = yield* Effect.tryPromise(() =>
              fetch(`http://127.0.0.1:${TEST_PORT}/api/jobs?limit=5`).then((r) => r.json())
            )
            expect(jobsList.some((job: { id: string }) => job.id === createdJob.id)).toBe(true)

            const missingJob = yield* Effect.tryPromise(() =>
              fetch(`http://127.0.0.1:${TEST_PORT}/api/jobs/does-not-exist`).then((r) => r.status)
            )
            expect(missingJob).toBe(404)
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
          const JobsLive = IndexJobsLive.pipe(Layer.provide(SqlLive))
          const AnalyticsServiceLive = AnalyticsLive.pipe(Layer.provide(SqlLive))
          const ChangeImpactServiceLive = ChangeImpactLive.pipe(
            Layer.provide(Layer.mergeAll(StoreLive, QueryLive, GitChangesLive))
          )
          const PlatformLive = Layer.merge(NodeFileSystem.layer, NodePath.layer)
          const WalkerLive = FileWalkerLive.pipe(Layer.provide(PlatformLive))
          const IndexerTestLive = IndexerLive.pipe(
            Layer.provide(Layer.mergeAll(StoreLive, WalkerLive, ParserLive, PlatformLive))
          )
          const RunnerLive = IndexJobRunnerLive.pipe(
            Layer.provide(Layer.mergeAll(JobsLive, IndexerTestLive))
          )
          return Layer.mergeAll(
            IndexerTestLive,
            StoreLive,
            QueryLive,
            JobsLive,
            RunnerLive,
            AnalyticsServiceLive,
            ChangeImpactServiceLive,
            PlatformLive
          )
        })()
      )
    )
  )
})
