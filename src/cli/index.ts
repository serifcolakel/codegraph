#!/usr/bin/env node
import { Command, Args, Options } from "@effect/cli"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import * as Sqlite from "@effect/sql-sqlite-node"
import { Console, Effect, Layer } from "effect"
import { appConfig } from "../domain/config.js"
import { FileWalkerLive } from "../services/FileWalker.js"
import { ParserLive } from "../services/Parser.js"
import { IndexStore, IndexStoreLive } from "../services/IndexStore.js"
import { Indexer, IndexerLive } from "../services/Indexer.js"
import { GraphQuery, GraphQueryLive } from "../services/GraphQuery.js"

// 1. Index command
const indexCommand = Command.make(
  "index",
  {
    path: Args.text({ name: "path" }),
    watch: Options.boolean("watch")
  },
  ({ path, watch }) =>
    Effect.gen(function* () {
      const indexer = yield* Indexer
      yield* Console.log(`Indexing repository at: ${path}...`)

      const report = yield* indexer.indexRepo(path)
      yield* Console.log(`\n=== Indexing Complete ===`)
      yield* Console.log(`Repo:          ${report.repoName} (${report.repoId})`)
      yield* Console.log(`Files indexed: ${report.filesIndexed} (skipped: ${report.filesSkipped}, deleted: ${report.filesDeleted})`)
      yield* Console.log(`Symbols:       ${report.symbolsCount}`)
      yield* Console.log(`Edges:         ${report.edgesCount}`)
      yield* Console.log(`Duration:      ${report.durationMs}ms\n`)

      if (watch) {
        yield* Console.log(`[Watch mode enabled] Watching for changes...`)
        // Will be connected to watch mode stream in phase 5
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
      yield* Console.log(`codegraph serve: HTTP API and Graph visualization starting on http://localhost:${port}`)
    })
)

// 4. MCP command (Model Context Protocol stdio server)
const mcpCommand = Command.make("mcp", {}, () =>
  Effect.gen(function* () {
    yield* Console.log(`codegraph mcp: starting MCP server over stdio...`)
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
