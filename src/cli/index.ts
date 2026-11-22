#!/usr/bin/env node
import { Args, Command, Options } from "@effect/cli"
import { FileSystem, type Path } from "@effect/platform"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import * as Sqlite from "@effect/sql-sqlite-node"
import { Console, Effect, Layer, ManagedRuntime, Stream } from "effect"
import { appConfig } from "../domain/config.js"
import { serveHttp } from "../http/index.js"
import { startMcpServer } from "../mcp/index.js"
import { type Analytics, AnalyticsLive } from "../services/Analytics.js"
import { ChangeImpact, ChangeImpactLive } from "../services/ChangeImpact.js"
import { CrossRepo, CrossRepoLive } from "../services/CrossRepo.js"
import { Diagnostics, DiagnosticsLive, formatStatus } from "../services/Diagnostics.js"
import { FileWalkerLive } from "../services/FileWalker.js"
import { GitChangesLive } from "../services/GitChanges.js"
import { type GraphQuery, GraphQueryLive } from "../services/GraphQuery.js"
import { Indexer, IndexerLive } from "../services/Indexer.js"
import { type IndexJobRunner, IndexJobRunnerLive } from "../services/IndexJobRunner.js"
import { type IndexJobs, IndexJobsLive } from "../services/IndexJobs.js"
import { IndexStore, IndexStoreLive } from "../services/IndexStore.js"
import { ParserLive } from "../services/Parser.js"
import { type QueryLanguage, QueryLanguageLive } from "../services/QueryLanguage.js"

// 1. Index command
const indexCommand = Command.make(
  "index",
  {
    path: Args.text({ name: "path" }),
    watch: Options.boolean("watch"),
    force: Options.boolean("force")
  },
  ({ path, watch, force }) =>
    Effect.gen(function* () {
      const indexer = yield* Indexer
      yield* Console.log(`Indexing repository at: ${path}...`)

      const report = yield* indexer.indexRepo(path, { force })
      yield* Console.log(`\n=== Indexing Complete ===`)
      yield* Console.log(`Repo:          ${report.repoName} (${report.repoId})`)
      yield* Console.log(
        `Files indexed: ${report.filesIndexed} (skipped: ${report.filesSkipped}, deleted: ${report.filesDeleted})`
      )
      yield* Console.log(`Symbols:       ${report.symbolsCount}`)
      yield* Console.log(`Edges:         ${report.edgesCount}`)
      yield* Console.log(
        `Coverage:      parsed ${report.coverage.parsed}, partial ${report.coverage.partial}, unsupported ${report.coverage.unsupported}, unknown ${report.coverage.unknown}`
      )
      yield* Console.log(`Duration:      ${report.durationMs}ms\n`)

      if (watch) {
        const fs = yield* FileSystem.FileSystem
        yield* Console.log(`[Watch mode enabled] Watching for changes...`)

        const reindex = indexer.indexRepo(path).pipe(
          Effect.tap((report) =>
            Console.log(
              `[watch] ${report.filesIndexed} indexed, ${report.filesSkipped} skipped, ${report.filesDeleted} deleted (${report.durationMs}ms)`
            )
          ),
          Effect.catchAll((error) => Console.error(`[watch] re-index failed: ${error}`))
        )

        yield* fs.watch(path, { recursive: true }).pipe(
          Stream.debounce("500 millis"),
          Stream.runForEach(() => reindex)
        )
      }
    })
)

// 2. Stats command
const statsCommand = Command.make("stats", {}, () =>
  Effect.gen(function* () {
    const store = yield* IndexStore
    yield* store.initSchema()
    const stats = yield* store.getStats()
    const repos = yield* store.listRepos()

    yield* Console.log(`\n=== Codegraph Statistics ===`)
    yield* Console.log(`Repositories: ${stats.repos}`)
    yield* Console.log(`Total Files:  ${stats.files}`)
    yield* Console.log(`Symbols:      ${stats.symbols}`)
    yield* Console.log(`Edges:        ${stats.edges}`)
    yield* Console.log(`Source:       ${stats.sourceBytes.toLocaleString("en-US")} bytes`)

    if (repos.length > 0) {
      yield* Console.log(`\nIndexed Repositories:`)
      for (const r of repos) {
        yield* Console.log(`  - ${r.name} (${r.rootPath}) [ID: ${r.id}]`)
      }
    }
    yield* Console.log(``)
  })
)

// 3. Serve command (HTTP + Graph UI)
const serveCommand = Command.make(
  "serve",
  {
    port: Options.integer("port").pipe(Options.withDefault(4310))
  },
  ({ port }) =>
    Effect.gen(function* () {
      const store = yield* IndexStore
      yield* store.initSchema()
      yield* serveHttp(port)
    })
)

// 4. Coverage command (parse coverage and unresolved edge diagnostics)
const coverageCommand = Command.make(
  "coverage",
  {
    repo: Args.text({ name: "repo" }).pipe(Args.optional)
  },
  ({ repo }) =>
    Effect.gen(function* () {
      const store = yield* IndexStore
      yield* store.initSchema()
      const diagnostics = yield* Diagnostics

      if (repo._tag === "Some") {
        const status = yield* diagnostics
          .repoStatus(repo.value)
          .pipe(Effect.catchAll((error) => Console.error(`${error._tag}: ${error.message}`)))
        if (status) yield* Console.log(`\n${formatStatus(status)}\n`)
        return
      }

      const statuses = yield* diagnostics.listStatuses()
      if (statuses.length === 0) {
        yield* Console.log("No repositories indexed yet.")
        return
      }
      yield* Console.log("")
      for (const status of statuses) {
        yield* Console.log(formatStatus(status))
        yield* Console.log("")
      }
    })
)

// 5. Cross-repository link command
const linkCommand = Command.make("link", {}, () =>
  Effect.gen(function* () {
    const store = yield* IndexStore
    yield* store.initSchema()
    const crossRepo = yield* CrossRepo
    const result = yield* crossRepo.link()
    yield* Console.log(
      `Cross-repo links: ${result.total} (http=${result.http}, async=${result.async})`
    )
  })
)

// 6. Change impact command (git diff -> affected symbols and blast radius)
const changesCommand = Command.make(
  "changes",
  {
    repo: Args.text({ name: "repo" }),
    base: Options.text("base").pipe(Options.optional)
  },
  ({ repo, base }) =>
    Effect.gen(function* () {
      const store = yield* IndexStore
      yield* store.initSchema()
      const impact = yield* ChangeImpact
      const report = yield* impact
        .detect(repo, base._tag === "Some" ? base.value : undefined)
        .pipe(Effect.catchAll((error) => Console.error(`${error._tag}: ${error.message}`)))
      if (!report) return

      yield* Console.log(`\n=== Change impact for ${report.repoId} ===`)
      yield* Console.log(`Changed files (${report.changedFiles.length}):`)
      for (const filePath of report.changedFiles) {
        yield* Console.log(
          `  ${filePath}${report.indexedFiles.includes(filePath) ? "" : " (not indexed)"}`
        )
      }
      yield* Console.log(`Affected symbols (${report.affectedSymbols.length}):`)
      for (const symbol of report.affectedSymbols) {
        yield* Console.log(
          `  ${symbol.name} (${symbol.kind}) at ${symbol.filePath}:${symbol.startLine}`
        )
      }
      yield* Console.log(`Blast radius (${report.impactedSymbols.length}):`)
      for (const symbol of report.impactedSymbols) {
        yield* Console.log(
          `  ${symbol.name} (${symbol.kind}) at ${symbol.filePath}:${symbol.startLine} <- ${symbol.referencedBy.join(", ")}`
        )
      }
      if (report.truncated) yield* Console.log("  (truncated)")
      yield* Console.log("")
    })
)

// 6. MCP command (Model Context Protocol stdio server)
const mcpCommand = Command.make("mcp", {}, () =>
  Effect.gen(function* () {
    const store = yield* IndexStore
    yield* store.initSchema()
    const runtime = yield* Effect.runtime<
      | IndexStore
      | GraphQuery
      | Diagnostics
      | ChangeImpact
      | Indexer
      | IndexJobs
      | IndexJobRunner
      | QueryLanguage
      | Analytics
      | CrossRepo
      | FileSystem.FileSystem
      | Path.Path
    >()
    const managedRuntime = ManagedRuntime.make(Layer.succeedContext(runtime.context))
    yield* Effect.promise(() => startMcpServer(managedRuntime))
  })
)

// Root command
const rootCommand = Command.make("codegraph").pipe(
  Command.withSubcommands([
    indexCommand,
    statsCommand,
    coverageCommand,
    changesCommand,
    linkCommand,
    serveCommand,
    mcpCommand
  ])
)

export const cli = Command.run(rootCommand, {
  name: "codegraph",
  version: "0.1.0"
})

// Build runtime layer
export const MainLive = Layer.unwrapEffect(
  Effect.gen(function* () {
    const config = yield* appConfig
    const SqlLive = Sqlite.SqliteClient.layer({ filename: config.dbPath })
    const StoreLive = IndexStoreLive.pipe(Layer.provide(SqlLive))
    const QueryLive = GraphQueryLive.pipe(Layer.provide(SqlLive))
    const QueryLanguageServiceLive = QueryLanguageLive.pipe(Layer.provide(SqlLive))
    const AnalyticsServiceLive = AnalyticsLive.pipe(Layer.provide(SqlLive))
    const CrossRepoServiceLive = CrossRepoLive.pipe(Layer.provide(SqlLive))
    const DiagnosticsServiceLive = DiagnosticsLive.pipe(
      Layer.provide(Layer.mergeAll(StoreLive, SqlLive))
    )
    const ChangeImpactServiceLive = ChangeImpactLive.pipe(
      Layer.provide(Layer.mergeAll(StoreLive, QueryLive, GitChangesLive))
    )
    const WalkerLive = FileWalkerLive.pipe(Layer.provide(NodeContext.layer))
    const IndexJobsServiceLive = IndexJobsLive.pipe(Layer.provide(SqlLive))
    const IndexerServiceLive = IndexerLive.pipe(
      Layer.provide(Layer.mergeAll(StoreLive, WalkerLive, ParserLive, NodeContext.layer))
    )

    return Layer.mergeAll(
      SqlLive,
      StoreLive,
      QueryLive,
      WalkerLive,
      ParserLive,
      IndexerServiceLive,
      IndexJobsServiceLive,
      QueryLanguageServiceLive,
      AnalyticsServiceLive,
      CrossRepoServiceLive,
      IndexJobRunnerLive.pipe(
        Layer.provide(Layer.mergeAll(IndexJobsServiceLive, IndexerServiceLive))
      ),
      DiagnosticsServiceLive,
      ChangeImpactServiceLive,
      GitChangesLive,
      NodeContext.layer
    )
  })
)

if (
  process.argv[1]?.includes("cli/index") ||
  process.argv[1]?.endsWith("codegraph") ||
  import.meta.url === `file://${process.argv[1]}`
) {
  const program = cli(process.argv).pipe(Effect.provide(MainLive))
  NodeRuntime.runMain(program)
}
