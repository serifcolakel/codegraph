import { FileSystem, Path } from "@effect/platform"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import * as Sqlite from "@effect/sql-sqlite-node"
import { it } from "@effect/vitest"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { Effect, Layer, ManagedRuntime } from "effect"
import { describe, expect } from "vitest"
import { createMcpServer } from "../src/mcp/index.js"
import { type Diagnostics, DiagnosticsLive } from "../src/services/Diagnostics.js"
import { FileWalkerLive } from "../src/services/FileWalker.js"
import { type GraphQuery, GraphQueryLive } from "../src/services/GraphQuery.js"
import { Indexer, IndexerLive } from "../src/services/Indexer.js"
import { type IndexStore, IndexStoreLive } from "../src/services/IndexStore.js"
import { ParserLive } from "../src/services/Parser.js"

describe("MCP server tools", () => {
  it.live("handles MCP tool requests backed by Effect services", () =>
    Effect.gen(function* () {
      const indexer = yield* Indexer
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const tmpDir = path.resolve(`./.test-tmp-mcp-${Date.now()}`)
      yield* fs.makeDirectory(tmpDir, { recursive: true })

      try {
        const fileA = path.join(tmpDir, "service.ts")
        yield* fs.writeFileString(
          fileA,
          `
export interface DataService {
  getData(): string[];
}

export class MemoryDataService implements DataService {
  getData(): string[] {
    return ["item1", "item2"];
  }
}
`
        )

        const report = yield* indexer.indexRepo(tmpDir, { name: "mcp-test-repo" })
        expect(report.filesIndexed).toBe(1)

        // Create runtime and MCP server
        const runtime = yield* Effect.runtime<
          IndexStore | GraphQuery | Diagnostics | FileSystem.FileSystem | Path.Path
        >()
        const managedRuntime = ManagedRuntime.make(Layer.succeedContext(runtime.context))
        const mcpServer = createMcpServer(managedRuntime)

        type RequestHandler = (request: unknown) => Promise<unknown>
        interface ToolListResult {
          readonly tools: ReadonlyArray<{ readonly name: string }>
        }
        interface ToolCallResult {
          readonly content: ReadonlyArray<{ readonly text: string }>
        }

        const handlers = (mcpServer as unknown as { _requestHandlers: Map<string, RequestHandler> })
          ._requestHandlers

        // 1. List tools
        const listToolsHandler = handlers.get(ListToolsRequestSchema.shape.method.value)
        if (!listToolsHandler) throw new Error("list tools handler not registered")
        const toolsList = (yield* Effect.promise(() =>
          listToolsHandler({ method: "tools/list", params: {} })
        )) as ToolListResult
        const toolNames = toolsList.tools.map((t) => t.name)

        expect(toolNames).toContain("repo_map")
        expect(toolNames).toContain("outline_file")
        expect(toolNames).toContain("search_symbol")
        expect(toolNames).toContain("find_references")
        expect(toolNames).toContain("neighborhood")
        expect(toolNames).toContain("read_file_range")
        expect(toolNames).toContain("index_status")

        const callToolHandler = handlers.get(CallToolRequestSchema.shape.method.value)
        if (!callToolHandler) throw new Error("call tool handler not registered")

        const callTool = (name: string, args: Record<string, unknown>) =>
          Effect.promise(() =>
            callToolHandler({ method: "tools/call", params: { name, arguments: args } })
          ).pipe(Effect.map((result) => result as ToolCallResult))

        // 2. Test search_symbol
        const searchResult = yield* callTool("search_symbol", { query: "MemoryDataService" })
        expect(searchResult.content[0]?.text).toContain("MemoryDataService")
        expect(searchResult.content[0]?.text).toContain("service.ts")

        // 3. Test outline_file
        const outlineResult = yield* callTool("outline_file", {
          path: "service.ts",
          repoId: report.repoId
        })
        expect(outlineResult.content[0]?.text).toContain("DataService")
        expect(outlineResult.content[0]?.text).toContain("MemoryDataService")

        // 4. Test repo_map
        const repoMapResult = yield* callTool("repo_map", { repoId: report.repoId })
        expect(repoMapResult.content[0]?.text).toContain("service.ts:")
        expect(repoMapResult.content[0]?.text).toContain("DataService")

        // 5. Test index_status
        const statusResult = yield* callTool("index_status", { repoId: report.repoId })
        expect(statusResult.content[0]?.text).toContain("coverage:")
        expect(statusResult.content[0]?.text).toContain("unresolved edges:")

        // 6. Test read_file_range
        const readRangeResult = yield* callTool("read_file_range", {
          path: "service.ts",
          startLine: 1,
          endLine: 5,
          repoId: report.repoId
        })
        expect(readRangeResult.content[0]?.text).toContain("1 |")
        expect(readRangeResult.content[0]?.text).toContain("DataService")
      } finally {
        yield* fs.remove(tmpDir, { recursive: true }).pipe(Effect.ignore)
      }
    }).pipe(
      Effect.provide(
        (() => {
          const SqlLive = Sqlite.SqliteClient.layer({ filename: ":memory:" })
          const StoreLive = IndexStoreLive.pipe(Layer.provide(SqlLive))
          const QueryLive = GraphQueryLive.pipe(Layer.provide(SqlLive))
          const DiagnosticsServiceLive = DiagnosticsLive.pipe(
            Layer.provide(Layer.mergeAll(StoreLive, SqlLive))
          )
          const PlatformLive = Layer.merge(NodeFileSystem.layer, NodePath.layer)
          const WalkerLive = FileWalkerLive.pipe(Layer.provide(PlatformLive))
          const IndexerTestLive = IndexerLive.pipe(
            Layer.provide(Layer.mergeAll(StoreLive, WalkerLive, ParserLive, PlatformLive))
          )
          return Layer.mergeAll(
            IndexerTestLive,
            StoreLive,
            QueryLive,
            DiagnosticsServiceLive,
            PlatformLive
          )
        })()
      )
    )
  )
})
