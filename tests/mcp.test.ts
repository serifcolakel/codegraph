import { FileSystem, Path } from "@effect/platform"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import * as Sqlite from "@effect/sql-sqlite-node"
import { it } from "@effect/vitest"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { Effect, Layer, ManagedRuntime } from "effect"
import { describe, expect } from "vitest"
import { createMcpServer } from "../src/mcp/index.js"
import { type Analytics, AnalyticsLive } from "../src/services/Analytics.js"
import { type ChangeImpact, ChangeImpactLive } from "../src/services/ChangeImpact.js"
import { type CrossRepo, CrossRepoLive } from "../src/services/CrossRepo.js"
import { type Diagnostics, DiagnosticsLive } from "../src/services/Diagnostics.js"
import { FileWalkerLive } from "../src/services/FileWalker.js"
import { FreshnessLive } from "../src/services/Freshness.js"
import { GitChangesLive } from "../src/services/GitChanges.js"
import { type GraphQuery, GraphQueryLive } from "../src/services/GraphQuery.js"
import { Indexer, IndexerLive } from "../src/services/Indexer.js"
import { type IndexJobRunner, IndexJobRunnerLive } from "../src/services/IndexJobRunner.js"
import { type IndexJobs, IndexJobsLive } from "../src/services/IndexJobs.js"
import { type IndexStore, IndexStoreLive } from "../src/services/IndexStore.js"
import { ParserLive } from "../src/services/Parser.js"
import { type QueryLanguage, QueryLanguageLive } from "../src/services/QueryLanguage.js"

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

export function leaf(): string {
  return "leaf";
}

export function middle(): string {
  return leaf();
}

export function top(): string {
  return middle();
}

function unusedHelper(): number {
  return 0;
}
`
        )

        const report = yield* indexer.indexRepo(tmpDir, { name: "mcp-test-repo" })
        expect(report.filesIndexed).toBe(1)

        // Create runtime and MCP server
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
          | Freshness
          | FileSystem.FileSystem
          | Path.Path
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

        expect(toolNames).toEqual([
          "index_repository",
          "search_graph",
          "search_code",
          "get_code_snippet",
          "trace_path",
          "get_architecture",
          "analyze_graph",
          "query_graph"
        ])

        const callToolHandler = handlers.get(CallToolRequestSchema.shape.method.value)
        if (!callToolHandler) throw new Error("call tool handler not registered")

        const callTool = (name: string, args: Record<string, unknown>) =>
          Effect.promise(() =>
            callToolHandler({ method: "tools/call", params: { name, arguments: args } })
          ).pipe(Effect.map((result) => result as ToolCallResult))

        // 2. Test BM25 symbol search
        const searchResult = yield* callTool("search_graph", { query: "MemoryDataService" })
        expect(searchResult.content[0]?.text).toContain("MemoryDataService")
        expect(searchResult.content[0]?.text).toContain("service.ts")

        // 3. Test file outline
        const outlineResult = yield* callTool("get_architecture", {
          view: "outline",
          path: "service.ts",
          repoId: report.repoId
        })
        expect(outlineResult.content[0]?.text).toContain("DataService")
        expect(outlineResult.content[0]?.text).toContain("MemoryDataService")

        // 4. Test repository map
        const repoMapResult = yield* callTool("get_architecture", {
          view: "map",
          repoId: report.repoId
        })
        expect(repoMapResult.content[0]?.text).toContain("service.ts:")
        expect(repoMapResult.content[0]?.text).toContain("DataService")

        // 5. Test index_status
        const statusResult = yield* callTool("index_repository", {
          action: "status",
          repoId: report.repoId
        })
        expect(statusResult.content[0]?.text).toContain("coverage:")
        expect(statusResult.content[0]?.text).toContain("unresolved edges:")
        expect(statusResult.content[0]?.text).toContain("freshness: stale=false")

        // 6. Test detect_changes error path on a non-git directory
        const detectResult = (yield* callTool("analyze_graph", {
          analysis: "changes",
          repoId: report.repoId
        })) as ToolCallResult & { readonly isError?: boolean }
        expect(detectResult.content[0]?.text).toContain("Failed to read git changes")

        // 7. Test trace_path
        const traceResult = yield* callTool("trace_path", {
          selector: "service.top",
          direction: "outbound",
          depth: 2,
          mode: "calls"
        })
        expect(traceResult.content[0]?.text).toContain("start: top")
        expect(traceResult.content[0]?.text).toContain("middle")
        expect(traceResult.content[0]?.text).toContain("leaf")
        expect(traceResult.content[0]?.text).toContain("--[call]-->")

        const missingTrace = yield* callTool("trace_path", { selector: "service.Missing" })
        expect(missingTrace.content[0]?.text).toContain("No symbol matched")

        const references = yield* callTool("trace_path", {
          selector: "service.leaf",
          mode: "references"
        })
        expect(references.content[0]?.text).toContain("middle")

        const neighborhood = yield* callTool("trace_path", {
          selector: "service.leaf",
          mode: "neighborhood",
          depth: 1
        })
        expect(neighborhood.content[0]?.text).toContain("Nodes (")

        // 8. Test get_architecture
        const architectureResult = yield* callTool("get_architecture", { repoId: report.repoId })
        expect(architectureResult.content[0]?.text).toContain("languages: typescript=1")
        expect(architectureResult.content[0]?.text).toContain("packages:")
        expect(architectureResult.content[0]?.text).toContain("hotspots:")
        expect(architectureResult.content[0]?.text).toContain("service.ts")

        // 9. Test index_repository
        const reindexResult = yield* callTool("index_repository", {
          path: tmpDir,
          name: "mcp-test-repo",
          force: true
        })
        expect(reindexResult.content[0]?.text).toContain("indexed mcp-test-repo")
        expect(reindexResult.content[0]?.text).toContain("coverage:")

        // 10. Test async indexing and job status
        const asyncIndex = yield* callTool("index_repository", {
          path: tmpDir,
          name: "mcp-test-repo",
          force: true,
          async: true
        })
        const jobId = asyncIndex.content[0]?.text.match(/job (job_[A-Za-z0-9_]+)/)?.[1]
        expect(jobId).toBeTruthy()
        if (!jobId) throw new Error("async index did not return a job id")

        let jobText = ""
        for (let attempt = 0; attempt < 100; attempt++) {
          const status = yield* callTool("index_repository", { action: "job", jobId })
          jobText = status.content[0]?.text ?? ""
          if (jobText.includes("status=completed") || jobText.includes("status=failed")) break
          yield* Effect.sleep("50 millis")
        }
        expect(jobText).toContain("status=completed")
        expect(jobText).toContain("repoId:")

        // 11. Test list_projects
        const projectsResult = yield* callTool("index_repository", { action: "list" })
        expect(projectsResult.content[0]?.text).toContain("mcp-test-repo")
        expect(projectsResult.content[0]?.text).toContain(report.repoId)

        // 12. Test analyze_graph
        const deadCode = yield* callTool("analyze_graph", {
          analysis: "dead_code",
          repoId: report.repoId
        })
        expect(deadCode.content[0]?.text).toContain("analysis=dead_code")
        expect(deadCode.content[0]?.text).toContain("unusedHelper")

        const hotspots = yield* callTool("analyze_graph", {
          analysis: "hotspots",
          repoId: report.repoId,
          limit: 5
        })
        expect(hotspots.content[0]?.text).toContain("hotspot")

        const packages = yield* callTool("analyze_graph", {
          analysis: "packages",
          repoId: report.repoId
        })
        expect(packages.content[0]?.text).toContain("package(s)")

        const communities = yield* callTool("analyze_graph", {
          analysis: "communities",
          level: "file",
          repoId: report.repoId
        })
        expect(communities.content[0]?.text).toContain("analysis=communities")

        // 13. Test compare_snapshots
        const snapshotComparison = yield* callTool("analyze_graph", {
          analysis: "snapshots",
          repoId: report.repoId
        })
        expect(snapshotComparison.content[0]?.text).toContain("snapshots")
        expect(snapshotComparison.content[0]?.text).toContain("files:")

        // 14. Test cross_repo_links
        const crossLinks = yield* callTool("trace_path", {
          mode: "cross_repo",
          repoId: report.repoId,
          refresh: true
        })
        expect(crossLinks.content[0]?.text).toContain("No cross-repo links")

        // 15. Test query_graph
        const queryGraphResult = yield* callTool("query_graph", {
          query: `MATCH (s:Symbol) WHERE s.name CONTAINS "Data" RETURN s.name AS name, s.filePath AS file ORDER BY s.name LIMIT 5`,
          repoId: report.repoId
        })
        expect(queryGraphResult.content[0]?.text).toContain("columns: name, file")
        expect(queryGraphResult.content[0]?.text).toContain("MemoryDataService")

        // 16. Test semantic search_graph
        const semanticSearch = yield* callTool("search_graph", {
          namePattern: "data service",
          semantic: true,
          repoId: report.repoId,
          limit: 5
        })
        expect(semanticSearch.content[0]?.text).toContain("relevance:")

        // 17. Test duplicate analysis
        const duplicates = yield* callTool("analyze_graph", {
          analysis: "duplicates",
          repoId: report.repoId,
          threshold: 0.999
        })
        expect(duplicates.content[0]?.text).toContain("No near-duplicates")

        // 18. Test search_graph with regex, kind filter and paging
        const graphSearch = yield* callTool("search_graph", {
          namePattern: "Memory.*",
          regex: true,
          kind: "class",
          repoId: report.repoId,
          limit: 1
        })
        expect(graphSearch.content[0]?.text).toContain("MemoryDataService")
        expect(graphSearch.content[0]?.text).toContain("in-degree:")

        const graphSearchPage = yield* callTool("search_graph", {
          namePattern: "Data",
          repoId: report.repoId,
          limit: 1,
          offset: 0
        })
        expect(graphSearchPage.content[0]?.text).toContain("Showing 1 of")

        // 19. Test get_graph_schema
        const schemaResult = yield* callTool("get_architecture", {
          view: "schema",
          repoId: report.repoId
        })
        expect(schemaResult.content[0]?.text).toContain("Edge kinds:")
        expect(schemaResult.content[0]?.text).toContain("Symbol properties:")

        // 20. Test get_code_snippet by qualified name
        const snippetResult = yield* callTool("get_code_snippet", {
          qualifiedName: "service.MemoryDataService",
          repoId: report.repoId
        })
        expect(snippetResult.content[0]?.text).toContain("service.ts:")
        expect(snippetResult.content[0]?.text).toContain("MemoryDataService")
        expect(snippetResult.content[0]?.text).toContain("getData")

        const missingSnippet = yield* callTool("get_code_snippet", {
          qualifiedName: "service.DoesNotExist",
          repoId: report.repoId
        })
        expect(missingSnippet.content[0]?.text).toContain("No symbol matched")

        // 21. Test search_code
        const searchCodeResult = yield* callTool("search_code", {
          query: "MemoryDataService",
          repoId: report.repoId
        })
        expect(searchCodeResult.content[0]?.text).toContain("service.ts:")

        const searchCodeFiles = yield* callTool("search_code", {
          query: "MemoryDataService",
          mode: "files",
          repoId: report.repoId
        })
        expect(searchCodeFiles.content[0]?.text).toContain("service.ts")

        const searchCodeFull = yield* callTool("search_code", {
          query: "MemoryDataService",
          mode: "full",
          context: 1,
          repoId: report.repoId
        })
        expect(searchCodeFull.content[0]?.text).toContain("mode=full")

        // 22. Test exact file range
        const readRangeResult = yield* callTool("get_code_snippet", {
          path: "service.ts",
          startLine: 1,
          endLine: 5,
          repoId: report.repoId
        })
        expect(readRangeResult.content[0]?.text).toContain("1 |")
        expect(readRangeResult.content[0]?.text).toContain("DataService")

        // 23. Test delete_project
        const deleteResult = yield* callTool("index_repository", {
          action: "delete",
          repoId: report.repoId
        })
        expect(deleteResult.content[0]?.text).toContain("Deleted index")
        const projectsAfterDelete = yield* callTool("index_repository", { action: "list" })
        expect(projectsAfterDelete.content[0]?.text).toContain("No repositories indexed")
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
          const LanguageLive = QueryLanguageLive.pipe(Layer.provide(SqlLive))
          const AnalyticsServiceLive = AnalyticsLive.pipe(Layer.provide(SqlLive))
          const CrossRepoServiceLive = CrossRepoLive.pipe(Layer.provide(SqlLive))
          const DiagnosticsServiceLive = DiagnosticsLive.pipe(
            Layer.provide(Layer.mergeAll(StoreLive, SqlLive))
          )
          const ChangeImpactServiceLive = ChangeImpactLive.pipe(
            Layer.provide(Layer.mergeAll(StoreLive, QueryLive, GitChangesLive))
          )
          const PlatformLive = Layer.merge(NodeFileSystem.layer, NodePath.layer)
          const WalkerLive = FileWalkerLive.pipe(Layer.provide(PlatformLive))
          const FreshnessServiceLive = FreshnessLive.pipe(
            Layer.provide(Layer.mergeAll(StoreLive, WalkerLive, PlatformLive))
          )
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
            DiagnosticsServiceLive,
            ChangeImpactServiceLive,
            JobsLive,
            RunnerLive,
            LanguageLive,
            AnalyticsServiceLive,
            CrossRepoServiceLive,
            FreshnessServiceLive,
            PlatformLive
          )
        })()
      )
    )
  )
})
