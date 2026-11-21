#!/usr/bin/env node
import { Args, Command, Options } from "@effect/cli"
import { FileSystem, type Path } from "@effect/platform"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import * as Sqlite from "@effect/sql-sqlite-node"
import { Console, Effect, Layer, ManagedRuntime, Stream } from "effect"
import { appConfig } from "../domain/config.js"
import { serveHttp } from "../http/index.js"
import { startMcpServer } from "../mcp/index.js"
import { FileWalkerLive } from "../services/FileWalker.js"
import { type GraphQuery, GraphQueryLive } from "../services/GraphQuery.js"
import { Indexer, IndexerLive } from "../services/Indexer.js"
import { IndexStore, IndexStoreLive } from "../services/IndexStore.js"
import { ParserLive } from "../services/Parser.js"

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

// 4. MCP command (Model Context Protocol stdio server)
const mcpCommand = Command.make("mcp", {}, () =>
  Effect.gen(function* () {
    const store = yield* IndexStore
    yield* store.initSchema()
    const runtime = yield* Effect.runtime<
      IndexStore | GraphQuery | FileSystem.FileSystem | Path.Path
    >()
    const managedRuntime = ManagedRuntime.make(Layer.succeedContext(runtime.context))
    yield* Effect.promise(() => startMcpServer(managedRuntime))
  })
)

// Root command
const rootCommand = Command.make("codegraph").pipe(
  Command.withSubcommands([indexCommand, statsCommand, serveCommand, mcpCommand])
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
    const WalkerLive = FileWalkerLive.pipe(Layer.provide(NodeContext.layer))
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
