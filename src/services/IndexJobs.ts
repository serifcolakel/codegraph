import * as SqlClient from "@effect/sql/SqlClient"
import { Context, Effect, Layer } from "effect"
import { StoreError } from "../domain/errors.js"
import type { IndexJob, IndexReport } from "../domain/models.js"

export interface CreateIndexJobInput {
  readonly path: string
  readonly name?: string
  readonly force?: boolean
}

export interface IndexJobs {
  readonly createJob: (input: CreateIndexJobInput) => Effect.Effect<IndexJob, StoreError>
  readonly markRunning: (jobId: string) => Effect.Effect<void, StoreError>
  readonly completeJob: (
    jobId: string,
    repoId: string,
    report: IndexReport
  ) => Effect.Effect<void, StoreError>
  readonly failJob: (jobId: string, message: string) => Effect.Effect<void, StoreError>
  readonly getJob: (jobId: string) => Effect.Effect<IndexJob | null, StoreError>
  readonly listJobs: (limit?: number) => Effect.Effect<readonly IndexJob[], StoreError>
}

export const IndexJobs = Context.GenericTag<IndexJobs>("@codegraph/IndexJobs")

type JobRow = {
  id: string
  path: string
  name: string | null
  force: number
  status: string
  created_at: string
  started_at: string | null
  finished_at: string | null
  error: string | null
  repo_id: string | null
  report_json: string | null
}

const isStatus = (value: string): value is IndexJob["status"] =>
  value === "queued" || value === "running" || value === "completed" || value === "failed"

const toJob = (row: JobRow): IndexJob => {
  let report: unknown
  if (row.report_json) {
    try {
      report = JSON.parse(row.report_json)
    } catch {
      report = undefined
    }
  }
  return {
    id: row.id,
    path: row.path,
    force: row.force === 1,
    status: isStatus(row.status) ? row.status : "failed",
    createdAt: row.created_at,
    ...(row.name ? { name: row.name } : {}),
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(row.repo_id ? { repoId: row.repo_id } : {}),
    ...(report !== undefined ? { report } : {})
  }
}

export const IndexJobsLive = Layer.effect(
  IndexJobs,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const createJob = (input: CreateIndexJobInput): Effect.Effect<IndexJob, StoreError> =>
      Effect.gen(function* () {
        const id = `job_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`
        const createdAt = new Date().toISOString()
        const name = input.name?.trim() ? input.name.trim() : null
        const force = input.force ? 1 : 0
        yield* sql`
          INSERT INTO index_jobs (id, path, name, force, status, created_at)
          VALUES (${id}, ${input.path}, ${name}, ${force}, 'queued', ${createdAt});
        `.pipe(
          Effect.mapError(
            (e) => new StoreError({ message: "Failed to create index job", cause: e })
          )
        )
        return {
          id,
          path: input.path,
          force: force === 1,
          status: "queued",
          createdAt,
          ...(name ? { name } : {})
        }
      })

    const markRunning = (jobId: string): Effect.Effect<void, StoreError> =>
      sql`
        UPDATE index_jobs SET status = 'running', started_at = ${new Date().toISOString()}
        WHERE id = ${jobId};
      `.pipe(
        Effect.mapError((e) => new StoreError({ message: "Failed to start index job", cause: e }))
      )

    const completeJob = (
      jobId: string,
      repoId: string,
      report: IndexReport
    ): Effect.Effect<void, StoreError> =>
      sql`
        UPDATE index_jobs
        SET status = 'completed', finished_at = ${new Date().toISOString()},
            repo_id = ${repoId}, report_json = ${JSON.stringify(report)}, error = NULL
        WHERE id = ${jobId};
      `.pipe(
        Effect.mapError(
          (e) => new StoreError({ message: "Failed to complete index job", cause: e })
        )
      )

    const failJob = (jobId: string, message: string): Effect.Effect<void, StoreError> =>
      sql`
        UPDATE index_jobs
        SET status = 'failed', finished_at = ${new Date().toISOString()}, error = ${message}
        WHERE id = ${jobId};
      `.pipe(
        Effect.mapError((e) => new StoreError({ message: "Failed to fail index job", cause: e }))
      )

    const getJob = (jobId: string): Effect.Effect<IndexJob | null, StoreError> =>
      Effect.gen(function* () {
        const rows = yield* sql<JobRow>`
          SELECT id, path, name, force, status, created_at, started_at, finished_at, error,
                 repo_id, report_json
          FROM index_jobs WHERE id = ${jobId} LIMIT 1;
        `.pipe(
          Effect.mapError((e) => new StoreError({ message: "Failed to read index job", cause: e }))
        )
        const row = rows[0]
        return row ? toJob(row) : null
      })

    const listJobs = (limit: number = 20): Effect.Effect<readonly IndexJob[], StoreError> =>
      Effect.gen(function* () {
        const rows = yield* sql<JobRow>`
          SELECT id, path, name, force, status, created_at, started_at, finished_at, error,
                 repo_id, report_json
          FROM index_jobs ORDER BY created_at DESC LIMIT ${Math.max(1, Math.min(100, limit))};
        `.pipe(
          Effect.mapError((e) => new StoreError({ message: "Failed to list index jobs", cause: e }))
        )
        return rows.map(toJob)
      })

    return { createJob, markRunning, completeJob, failJob, getJob, listJobs }
  })
)
