import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect, Layer, ManagedRuntime } from "effect"
import * as Sqlite from "@effect/sql-sqlite-node"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { FileSystem, Path } from "@effect/platform"
import { FileWalkerLive } from "../src/services/FileWalker.js"
import { ParserLive } from "../src/services/Parser.js"
import { IndexStoreLive } from "../src/services/IndexStore.js"
import { Indexer, IndexerLive } from "../src/services/Indexer.js"
import { GraphQueryLive } from "../src/services/GraphQuery.js"
import { createMcpServer } from "../src/mcp/index.js"
import {
  ListToolsRequestSchema,
  CallToolRequestSchema
} from "@modelcontextprotocol/sdk/types.js"

describe("MCP server tools", () => {
  it.live("handles MCP tool requests backed by Effect services", () =>
    Effect.gen(function* () {
      const indexer = yield* Indexer
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const tmpDir = path.resolve("./.test-tmp-mcp-" + Date.now())
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
        const runtime = yield* Effect.runtime<any>()
        const managedRuntime = ManagedRuntime.make(Layer.succeedContext(runtime.context))
        const mcpServer = createMcpServer(managedRuntime)

        // 1. List tools
        const listToolsHandler = (mcpServer as any)._requestHandlers.get(
          ListToolsRequestSchema.shape.method.value
        )
        const toolsList = yield* Effect.promise(() => listToolsHandler({ method: "tools/list", params: {} }))
        const toolNames = toolsList.tools.map((t: any) => t.name)

        expect(toolNames).toContain("repo_map")
        expect(toolNames).toContain("outline_file")
        expect(toolNames).toContain("search_symbol")
        expect(toolNames).toContain("find_references")
        expect(toolNames).toContain("neighborhood")
        expect(toolNames).toContain("read_file_range")

        const callToolHandler = (mcpServer as any)._requestHandlers.get(
          CallToolRequestSchema.shape.method.value
        )

        // 2. Test search_symbol
        const searchResult = yield* Effect.promise(() => callToolHandler({
          method: "tools/call",
          params: {
            name: "search_symbol",
            arguments: { query: "MemoryDataService" }
          }
        }))
        expect(searchResult.content[0].text).toContain("MemoryDataService")
        expect(searchResult.content[0].text).toContain("service.ts")

        // 3. Test outline_file
        const outlineResult = yield* Effect.promise(() => callToolHandler({
          method: "tools/call",
          params: {
            name: "outline_file",
            arguments: { path: "service.ts", repoId: report.repoId }
          }
        }))
        expect(outlineResult.content[0].text).toContain("DataService")
        expect(outlineResult.content[0].text).toContain("MemoryDataService")

        // 4. Test repo_map
        const repoMapResult = yield* Effect.promise(() => callToolHandler({
          method: "tools/call",
          params: {
            name: "repo_map",
            arguments: { repoId: report.repoId }
          }
        }))
        expect(repoMapResult.content[0].text).toContain("service.ts:")
        expect(repoMapResult.content[0].text).toContain("DataService")

        // 5. Test read_file_range
        const readRangeResult = yield* Effect.promise(() => callToolHandler({
          method: "tools/call",
          params: {
            name: "read_file_range",
            arguments: { path: "service.ts", startLine: 1, endLine: 5, repoId: report.repoId }
          }
        }))
        expect(readRangeResult.content[0].text).toContain("1 |")
        expect(readRangeResult.content[0].text).toContain("DataService")
      } finally {
        yield* fs.remove(tmpDir, { recursive: true }).pipe(Effect.ignore)
      }
    }).pipe(
      Effect.provide(
        (() => {
          const SqlLive = Sqlite.SqliteClient.layer({ filename: ":memory:" })
          const StoreLive = IndexStoreLive.pipe(Layer.provide(SqlLive))
          const QueryLive = GraphQueryLive.pipe(Layer.provide(SqlLive))
          const PlatformLive = Layer.merge(NodeFileSystem.layer, NodePath.layer)
          const WalkerLive = FileWalkerLive.pipe(Layer.provide(PlatformLive))
          const IndexerTestLive = IndexerLive.pipe(
            Layer.provide(Layer.mergeAll(StoreLive, WalkerLive, ParserLive, PlatformLive))
          )
          return Layer.mergeAll(IndexerTestLive, StoreLive, QueryLive, PlatformLive)
        })()
      )
    )
  )
})
