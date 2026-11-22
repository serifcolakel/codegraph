import * as SqlClient from "@effect/sql/SqlClient"
import { Context, Effect, Layer } from "effect"
import { NotFoundError, StoreError } from "../domain/errors.js"
import type { ParseCoverage, StatsReport } from "../domain/models.js"
import { IndexStore } from "./IndexStore.js"

export interface UnresolvedSummary {
  readonly total: number
  readonly byKind: Readonly<Record<string, number>>
  readonly missingSymbol: number
  readonly missingModule: number
  readonly samples: ReadonlyArray<{
    readonly kind: string
    readonly target: string
    readonly sourceName: string
    readonly sourcePath: string
    readonly sourceLine: number
  }>
}

export interface RepoStatus {
  readonly repoId: string
  readonly repoName: string
  readonly rootPath: string
  readonly stats: StatsReport
  readonly coverage: ParseCoverage
  readonly unresolved: UnresolvedSummary
}

export interface Diagnostics {
  readonly repoStatus: (repoId: string) => Effect.Effect<RepoStatus, StoreError | NotFoundError>
  readonly listStatuses: () => Effect.Effect<readonly RepoStatus[], StoreError>
}

export const Diagnostics = Context.GenericTag<Diagnostics>("@codegraph/Diagnostics")

const SAMPLE_LIMIT = 8

export const DiagnosticsLive = Layer.effect(
  Diagnostics,
  Effect.gen(function* () {
    const store = yield* IndexStore
    const sql = yield* SqlClient.SqlClient

    const unresolvedFor = (repoId: string): Effect.Effect<UnresolvedSummary, StoreError> =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          kind: string
          target: string
          sourceName: string
          sourcePath: string
          sourceLine: number
        }>`
          SELECT e.kind, e.dst_symbol_id as target, s.name as sourceName,
                 f.path as sourcePath, s.start_line as sourceLine
          FROM edges e
          JOIN symbols s ON e.src_symbol_id = s.id
          JOIN files f ON s.file_id = f.id
          WHERE f.repo_id = ${repoId}
            AND (e.dst_symbol_id LIKE 'symbol:%' OR e.dst_symbol_id LIKE 'module:%');
        `.pipe(
          Effect.mapError(
            (e) => new StoreError({ message: "Failed to query unresolved edges", cause: e })
          )
        )

        const byKind: Record<string, number> = {}
        let missingSymbol = 0
        let missingModule = 0

        for (const row of rows) {
          byKind[row.kind] = (byKind[row.kind] ?? 0) + 1
          if (row.target.startsWith("module:")) missingModule++
          else missingSymbol++
        }

        return {
          total: rows.length,
          byKind,
          missingSymbol,
          missingModule,
          samples: rows.slice(0, SAMPLE_LIMIT).map((row) => ({
            kind: row.kind,
            target: row.target,
            sourceName: row.sourceName,
            sourcePath: row.sourcePath,
            sourceLine: row.sourceLine
          }))
        }
      })

    const repoStatus = (repoId: string): Effect.Effect<RepoStatus, StoreError | NotFoundError> =>
      Effect.gen(function* () {
        const repo = yield* store.getRepo(repoId)
        if (!repo) {
          return yield* Effect.fail(new NotFoundError({ entity: "Repository", id: repoId }))
        }
        const [stats, coverage, unresolved] = yield* Effect.all(
          [store.getStats(repo.id), store.getCoverage(repo.id), unresolvedFor(repo.id)],
          { concurrency: 1 }
        )
        return {
          repoId: repo.id,
          repoName: repo.name,
          rootPath: repo.rootPath,
          stats,
          coverage,
          unresolved
        }
      })

    const listStatuses = (): Effect.Effect<readonly RepoStatus[], StoreError> =>
      Effect.gen(function* () {
        const repos = yield* store.listRepos()
        const statuses: RepoStatus[] = []
        for (const repo of repos) {
          const status = yield* repoStatus(repo.id).pipe(
            Effect.catchTag("NotFoundError", () => Effect.succeed(undefined))
          )
          if (status) statuses.push(status)
        }
        return statuses
      })

    return { repoStatus, listStatuses }
  })
)

export const formatStatus = (status: RepoStatus): string => {
  const kinds = Object.entries(status.unresolved.byKind)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => `${kind}=${count}`)
    .join(", ")
  const languages = Object.entries(status.coverage.languages)
    .sort((a, b) => b[1] - a[1])
    .map(([language, count]) => `${language}=${count}`)
    .join(", ")

  const lines = [
    `${status.repoName} (${status.repoId})`,
    `  root: ${status.rootPath}`,
    `  files=${status.stats.files} symbols=${status.stats.symbols} edges=${status.stats.edges}`,
    `  coverage: parsed=${status.coverage.parsed} partial=${status.coverage.partial} skipped=${status.coverage.skipped} unsupported=${status.coverage.unsupported} unknown=${status.coverage.unknown}`,
    `  languages: ${languages || "none"}`,
    `  unresolved edges: ${status.unresolved.total} (missing symbol=${status.unresolved.missingSymbol}, missing module=${status.unresolved.missingModule})`,
    `  unresolved by kind: ${kinds || "none"}`
  ]

  for (const sample of status.unresolved.samples) {
    lines.push(
      `    ${sample.sourcePath}:${sample.sourceLine} ${sample.sourceName} --[${sample.kind}]--> ${sample.target}`
    )
  }

  return lines.join("\n")
}
