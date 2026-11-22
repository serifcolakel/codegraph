import { FileSystem, Path } from "@effect/platform"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import * as Sqlite from "@effect/sql-sqlite-node"
import { it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { describe, expect } from "vitest"
import { FileWalkerLive } from "../src/services/FileWalker.js"
import { IndexerLive } from "../src/services/Indexer.js"
import { IndexJobRunner, IndexJobRunnerLive } from "../src/services/IndexJobRunner.js"
import {
  IndexJobs,
  IndexJobsLive,
  type IndexJobs as IndexJobsService
} from "../src/services/IndexJobs.js"
import { IndexStore, IndexStoreLive } from "../src/services/IndexStore.js"
import { ParserLive } from "../src/services/Parser.js"

const TestLive = (() => {
  const SqlLive = Sqlite.SqliteClient.layer({ filename: ":memory:" })
  const StoreLive = IndexStoreLive.pipe(Layer.provide(SqlLive))
  const JobsLive = IndexJobsLive.pipe(Layer.provide(SqlLive))
  const PlatformLive = Layer.merge(NodeFileSystem.layer, NodePath.layer)
  const WalkerLive = FileWalkerLive.pipe(Layer.provide(PlatformLive))
  const IndexerTestLive = IndexerLive.pipe(
    Layer.provide(Layer.mergeAll(StoreLive, WalkerLive, ParserLive, PlatformLive))
  )
  const RunnerLive = IndexJobRunnerLive.pipe(
    Layer.provide(Layer.mergeAll(JobsLive, IndexerTestLive))
  )
  return Layer.mergeAll(StoreLive, JobsLive, RunnerLive, IndexerTestLive, PlatformLive)
})()

describe("Async indexing jobs", () => {
  it.live("runs an indexing job in the background and records the report", () =>
    Effect.gen(function* () {
      const store = yield* IndexStore
      const jobs = yield* IndexJobs
      const runner = yield* IndexJobRunner
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      yield* store.initSchema()
      const tmpDir = path.resolve(`./.test-tmp-jobs-${Date.now()}`)
      yield* fs.makeDirectory(tmpDir, { recursive: true })

      try {
        yield* fs.writeFileString(
          path.join(tmpDir, "service.ts"),
          "export function run(): number { return 1 }"
        )

        const job = yield* runner.start({ path: tmpDir, name: "async-repo" })
        expect(job.status).toBe("queued")

        const finished = yield* waitForJob(jobs, job.id)
        expect(finished?.status).toBe("completed")
        expect(finished?.repoId).toBeTruthy()
        expect(finished?.startedAt).toBeTruthy()
        expect(finished?.finishedAt).toBeTruthy()
        const report = finished?.report as { filesIndexed?: number } | undefined
        expect(report?.filesIndexed).toBe(1)

        const list = yield* jobs.listJobs(5)
        expect(list.some((entry) => entry.id === job.id)).toBe(true)

        const failedJob = yield* runner.start({ path: path.join(tmpDir, "missing") })
        const failed = yield* waitForJob(jobs, failedJob.id)
        expect(failed?.status).toBe("failed")
        expect(failed?.error).toBeTruthy()

        const missing = yield* jobs.getJob("does-not-exist")
        expect(missing).toBeNull()
      } finally {
        yield* fs.remove(tmpDir, { recursive: true }).pipe(Effect.ignore)
      }
    }).pipe(Effect.provide(TestLive))
  )
})

const waitForJob = (jobs: IndexJobsService, jobId: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt++) {
      const current = yield* jobs.getJob(jobId)
      if (current?.status === "completed" || current?.status === "failed") return current
      yield* Effect.sleep("50 millis")
    }
    return yield* jobs.getJob(jobId)
  })
