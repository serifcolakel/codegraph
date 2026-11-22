import { Cause, Context, Effect, Either, Layer } from "effect"
import type { StoreError } from "../domain/errors.js"
import type { IndexJob } from "../domain/models.js"
import { Indexer } from "./Indexer.js"
import { type CreateIndexJobInput, IndexJobs } from "./IndexJobs.js"

export interface IndexJobRunner {
  readonly start: (input: CreateIndexJobInput) => Effect.Effect<IndexJob, StoreError>
}

export const IndexJobRunner = Context.GenericTag<IndexJobRunner>("@codegraph/IndexJobRunner")

export const IndexJobRunnerLive = Layer.effect(
  IndexJobRunner,
  Effect.gen(function* () {
    const jobs = yield* IndexJobs
    const indexer = yield* Indexer

    const runJob = (job: IndexJob): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* jobs.markRunning(job.id)
        const result = yield* indexer
          .indexRepo(job.path, {
            force: job.force,
            ...(job.name !== undefined ? { name: job.name } : {})
          })
          .pipe(Effect.either)

        if (Either.isLeft(result)) {
          yield* jobs.failJob(job.id, result.left.message)
          return
        }
        yield* jobs.completeJob(job.id, result.right.repoId, result.right)
      }).pipe(
        Effect.catchAllCause((cause) =>
          jobs.failJob(job.id, Cause.pretty(cause)).pipe(Effect.ignore)
        ),
        Effect.asVoid
      )

    const start = (input: CreateIndexJobInput): Effect.Effect<IndexJob, StoreError> =>
      Effect.gen(function* () {
        const job = yield* jobs.createJob(input)
        yield* Effect.forkDaemon(runJob(job))
        return job
      })

    return { start }
  })
)
