import { FileSystem, Path } from "@effect/platform"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError
} from "@modelcontextprotocol/sdk/types.js"
import { Effect, type ManagedRuntime, Schema } from "effect"
import { Analytics } from "../services/Analytics.js"
import { ChangeImpact } from "../services/ChangeImpact.js"
import { Diagnostics, formatStatus } from "../services/Diagnostics.js"
import { GraphQuery } from "../services/GraphQuery.js"
import { Indexer } from "../services/Indexer.js"
import { IndexJobRunner } from "../services/IndexJobRunner.js"
import { IndexJobs } from "../services/IndexJobs.js"
import { IndexStore } from "../services/IndexStore.js"
import { QueryLanguage } from "../services/QueryLanguage.js"

const docSnippet = (doc?: string): string =>
  doc ? doc.replace(/\s+/g, " ").trim().slice(0, 180) : ""

// Tool Input Schemas
export const RepoMapInput = Schema.Struct({
  repoId: Schema.optional(Schema.String),
  maxTokens: Schema.optional(Schema.Number)
})
export type RepoMapInput = typeof RepoMapInput.Type

export const OutlineFileInput = Schema.Struct({
  path: Schema.String,
  repoId: Schema.optional(Schema.String)
})
export type OutlineFileInput = typeof OutlineFileInput.Type

export const SearchSymbolInput = Schema.Struct({
  query: Schema.String,
  limit: Schema.optional(Schema.Number),
  repoId: Schema.optional(Schema.String)
})
export type SearchSymbolInput = typeof SearchSymbolInput.Type

export const FindReferencesInput = Schema.Struct({
  symbolId: Schema.String
})
export type FindReferencesInput = typeof FindReferencesInput.Type

export const NeighborhoodInput = Schema.Struct({
  symbolId: Schema.String,
  depth: Schema.optional(Schema.Number)
})
export type NeighborhoodInput = typeof NeighborhoodInput.Type

export const ReadFileRangeInput = Schema.Struct({
  path: Schema.String,
  startLine: Schema.Number,
  endLine: Schema.Number,
  repoId: Schema.optional(Schema.String)
})
export type ReadFileRangeInput = typeof ReadFileRangeInput.Type

export const IndexStatusInput = Schema.Struct({
  repoId: Schema.optional(Schema.String)
})
export type IndexStatusInput = typeof IndexStatusInput.Type

export const GraphSchemaInput = Schema.Struct({
  repoId: Schema.optional(Schema.String)
})
export type GraphSchemaInput = typeof GraphSchemaInput.Type

export const CodeSnippetInput = Schema.Struct({
  qualifiedName: Schema.String,
  repoId: Schema.optional(Schema.String)
})
export type CodeSnippetInput = typeof CodeSnippetInput.Type

export const ListProjectsInput = Schema.Struct({})
export type ListProjectsInput = typeof ListProjectsInput.Type

export const IndexJobStatusInput = Schema.Struct({
  jobId: Schema.String
})
export type IndexJobStatusInput = typeof IndexJobStatusInput.Type

export const DeleteProjectInput = Schema.Struct({
  repoId: Schema.String
})
export type DeleteProjectInput = typeof DeleteProjectInput.Type

export const IndexRepositoryInput = Schema.Struct({
  path: Schema.String,
  name: Schema.optional(Schema.String),
  force: Schema.optional(Schema.Boolean),
  async: Schema.optional(Schema.Boolean)
})
export type IndexRepositoryInput = typeof IndexRepositoryInput.Type

export const DetectChangesInput = Schema.Struct({
  repoId: Schema.optional(Schema.String),
  base: Schema.optional(Schema.String)
})
export type DetectChangesInput = typeof DetectChangesInput.Type

export const TracePathInput = Schema.Struct({
  selector: Schema.String,
  direction: Schema.optional(Schema.Literal("inbound", "outbound", "both")),
  depth: Schema.optional(Schema.Number),
  mode: Schema.optional(Schema.Literal("calls", "references", "data_flow", "cross_file"))
})
export type TracePathInput = typeof TracePathInput.Type

export const ArchitectureInput = Schema.Struct({
  repoId: Schema.optional(Schema.String)
})
export type ArchitectureInput = typeof ArchitectureInput.Type

export const AnalyzeGraphInput = Schema.Struct({
  analysis: Schema.Literal(
    "pagerank",
    "in_degree",
    "complexity",
    "hotspots",
    "dead_code",
    "cycles",
    "communities",
    "packages"
  ),
  repoId: Schema.optional(Schema.String),
  level: Schema.optional(Schema.Literal("symbol", "file", "package")),
  limit: Schema.optional(Schema.Number)
})
export type AnalyzeGraphInput = typeof AnalyzeGraphInput.Type

export const CompareSnapshotsInput = Schema.Struct({
  repoId: Schema.optional(Schema.String),
  from: Schema.optional(Schema.String),
  to: Schema.optional(Schema.String)
})
export type CompareSnapshotsInput = typeof CompareSnapshotsInput.Type

export const QueryGraphInput = Schema.Struct({
  query: Schema.String,
  repoId: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Number)
})
export type QueryGraphInput = typeof QueryGraphInput.Type

export const SearchGraphInput = Schema.Struct({
  namePattern: Schema.optional(Schema.String),
  regex: Schema.optional(Schema.Boolean),
  kind: Schema.optional(
    Schema.Literal(
      "function",
      "class",
      "interface",
      "type",
      "const",
      "method",
      "property",
      "enum",
      "doc"
    )
  ),
  filePattern: Schema.optional(Schema.String),
  repoId: Schema.optional(Schema.String),
  minDegree: Schema.optional(Schema.Number),
  maxDegree: Schema.optional(Schema.Number),
  limit: Schema.optional(Schema.Number),
  offset: Schema.optional(Schema.Number)
})
export type SearchGraphInput = typeof SearchGraphInput.Type

export const SearchCodeInput = Schema.Struct({
  query: Schema.String,
  repoId: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Number),
  regex: Schema.optional(Schema.Boolean),
  caseSensitive: Schema.optional(Schema.Boolean)
})
export type SearchCodeInput = typeof SearchCodeInput.Type

export const createMcpServer = <R>(
  runtime: ManagedRuntime.ManagedRuntime<
    | IndexStore
    | GraphQuery
    | Diagnostics
    | ChangeImpact
    | Indexer
    | IndexJobs
    | IndexJobRunner
    | QueryLanguage
    | Analytics
    | FileSystem.FileSystem
    | Path.Path
    | R,
    unknown
  >
) => {
  const server = new Server(
    {
      name: "codegraph-mcp",
      version: "0.1.0"
    },
    {
      capabilities: {
        tools: {}
      }
    }
  )

  // List tools handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "repo_map",
          description:
            "Generates a compact, ranked overview of exported signatures across files in the codebase.",
          inputSchema: {
            type: "object",
            properties: {
              repoId: {
                type: "string",
                description: "Optional repo ID (defaults to first indexed repo)"
              },
              maxTokens: {
                type: "number",
                description: "Estimated token limit for the map (default 2000)"
              }
            }
          }
        },
        {
          name: "outline_file",
          description:
            "Lists all symbols (functions, classes, interfaces, types) defined in a file in order.",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string", description: "Path to the file" },
              repoId: { type: "string", description: "Optional repo ID" }
            },
            required: ["path"]
          }
        },
        {
          name: "detect_changes",
          description:
            "Maps git changes to affected symbols and their blast radius (reverse references).",
          inputSchema: {
            type: "object",
            properties: {
              repoId: { type: "string", description: "Optional repo ID" },
              base: {
                type: "string",
                description: "Git base ref; omit to diff the working tree against HEAD"
              }
            }
          }
        },
        {
          name: "trace_path",
          description:
            "Traces callers and callees of a symbol by qualified name or ID, with depth and mode.",
          inputSchema: {
            type: "object",
            properties: {
              selector: { type: "string", description: "Symbol ID or qualified name" },
              direction: { type: "string", enum: ["inbound", "outbound", "both"] },
              depth: { type: "number", description: "Hops (default 2, max 6)" },
              mode: { type: "string", enum: ["calls", "references", "data_flow", "cross_file"] }
            },
            required: ["selector"]
          }
        },
        {
          name: "get_architecture",
          description:
            "Summarizes languages, packages, entry points and hotspot symbols for a repository.",
          inputSchema: {
            type: "object",
            properties: {
              repoId: { type: "string", description: "Optional repo ID" }
            }
          }
        },
        {
          name: "index_job_status",
          description: "Returns the status and result summary of an async indexing job.",
          inputSchema: {
            type: "object",
            properties: {
              jobId: {
                type: "string",
                description: "Job ID returned by index_repository(async=true)"
              }
            },
            required: ["jobId"]
          }
        },
        {
          name: "delete_project",
          description: "Deletes an indexed repository and its symbols, edges and import records.",
          inputSchema: {
            type: "object",
            properties: {
              repoId: { type: "string", description: "Repository ID to delete" }
            },
            required: ["repoId"]
          }
        },
        {
          name: "index_repository",
          description:
            "Indexes a local repository path into the current database (incremental unless force=true).",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string", description: "Absolute or relative repository path" },
              name: { type: "string", description: "Optional display name" },
              force: { type: "boolean", description: "Reparse every file even if unchanged" },
              async: {
                type: "boolean",
                description: "Return a job id immediately and index in the background"
              }
            },
            required: ["path"]
          }
        },
        {
          name: "list_projects",
          description: "Lists indexed repositories with their IDs, roots and index counts.",
          inputSchema: { type: "object", properties: {} }
        },
        {
          name: "analyze_graph",
          description:
            "Ranks symbols and packages, finds communities, hotspots, dead-code candidates and cycles.",
          inputSchema: {
            type: "object",
            properties: {
              analysis: {
                type: "string",
                enum: ["pagerank", "in_degree", "complexity", "hotspots", "dead_code", "cycles"]
              },
              repoId: { type: "string", description: "Optional repo ID" },
              level: {
                type: "string",
                enum: ["symbol", "file", "package"],
                description: "Cycle/community level"
              },
              limit: { type: "number", description: "Max results (default varies, max 200)" }
            },
            required: ["analysis"]
          }
        },
        {
          name: "compare_snapshots",
          description:
            "Compares two index runs for a repository and reports total, language, symbol/edge kind and coverage deltas.",
          inputSchema: {
            type: "object",
            properties: {
              repoId: { type: "string", description: "Optional repo ID" },
              from: { type: "string", description: "Older snapshot ID (defaults to previous run)" },
              to: { type: "string", description: "Newer snapshot ID (defaults to latest run)" }
            }
          }
        },
        {
          name: "query_graph",
          description:
            "Runs a safe read-only Cypher subset over indexed Symbols, Files and Repositories.",
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description:
                  'e.g. MATCH (s:Symbol) WHERE s.kind = "function" RETURN s.name, s.filePath LIMIT 20'
              },
              repoId: { type: "string", description: "Optional repo scope" },
              limit: { type: "number", description: "Row cap (max 500)" }
            },
            required: ["query"]
          }
        },
        {
          name: "search_graph",
          description:
            "Searches indexed symbols by name pattern, kind, file scope and degree with paging.",
          inputSchema: {
            type: "object",
            properties: {
              namePattern: {
                type: "string",
                description: "Name substring, or a regex when regex=true"
              },
              regex: { type: "boolean", description: "Treat namePattern as a regular expression" },
              kind: {
                type: "string",
                enum: [
                  "function",
                  "class",
                  "interface",
                  "type",
                  "const",
                  "method",
                  "property",
                  "enum"
                ]
              },
              filePattern: { type: "string", description: "File path substring filter" },
              repoId: { type: "string", description: "Optional repo ID" },
              minDegree: { type: "number", description: "Minimum in-degree" },
              maxDegree: { type: "number", description: "Maximum in-degree" },
              limit: { type: "number", description: "Page size (default 20, max 200)" },
              offset: { type: "number", description: "Result offset for paging" }
            }
          }
        },
        {
          name: "search_symbol",
          description:
            "Performs full-text search (FTS5) for symbols by name or signature with in-degree rankings.",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: "Symbol name or search query" },
              limit: { type: "number", description: "Max results to return (default 20)" },
              repoId: { type: "string", description: "Optional repo ID to filter search" }
            },
            required: ["query"]
          }
        },
        {
          name: "find_references",
          description:
            "Finds all incoming calls, references, and usages of a symbol across the indexed repository.",
          inputSchema: {
            type: "object",
            properties: {
              symbolId: { type: "string", description: "Target symbol ID" }
            },
            required: ["symbolId"]
          }
        },
        {
          name: "neighborhood",
          description:
            "Retrieves the subgraph (callers, callees, extensions) around a symbol up to a given depth.",
          inputSchema: {
            type: "object",
            properties: {
              symbolId: { type: "string", description: "Center symbol ID" },
              depth: {
                type: "number",
                minimum: 1,
                maximum: 8,
                description: "Search depth in hops (default 1, max 8, capped at 500 nodes)"
              }
            },
            required: ["symbolId"]
          }
        },
        {
          name: "get_graph_schema",
          description:
            "Describes node labels, edge kinds and symbol properties, plus current index counts.",
          inputSchema: {
            type: "object",
            properties: {
              repoId: { type: "string", description: "Optional repo ID" }
            }
          }
        },
        {
          name: "get_code_snippet",
          description:
            "Returns the source lines for a symbol selected by qualified name, with file:line context.",
          inputSchema: {
            type: "object",
            properties: {
              qualifiedName: {
                type: "string",
                description:
                  "Qualified name from search_graph, e.g. src.domain.languages.languageForPath"
              },
              repoId: { type: "string", description: "Optional repo ID" }
            },
            required: ["qualifiedName"]
          }
        },
        {
          name: "search_code",
          description: "Searches text inside indexed files and returns compact file:line matches.",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: "Literal text, or a regex when regex=true" },
              repoId: { type: "string", description: "Optional repo ID" },
              limit: { type: "number", description: "Max matches (default 50, max 200)" },
              regex: { type: "boolean", description: "Treat query as a regular expression" },
              caseSensitive: { type: "boolean", description: "Case-sensitive matching" }
            },
            required: ["query"]
          }
        },
        {
          name: "index_status",
          description:
            "Reports parse coverage, language mix and unresolved edge diagnostics for an indexed repository.",
          inputSchema: {
            type: "object",
            properties: {
              repoId: { type: "string", description: "Optional repo ID" }
            }
          }
        },
        {
          name: "read_file_range",
          description: "Reads a specific range of lines from a file with 1-based line numbers.",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string", description: "Relative or absolute file path" },
              startLine: { type: "number", description: "1-based starting line number" },
              endLine: { type: "number", description: "1-based ending line number" },
              repoId: { type: "string", description: "Optional repo ID" }
            },
            required: ["path", "startLine", "endLine"]
          }
        }
      ]
    }
  })

  // Call tool handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params

    const getTargetRepoId = (inputRepoId?: string) =>
      Effect.gen(function* () {
        if (inputRepoId) return inputRepoId
        const store = yield* IndexStore
        const repos = yield* store.listRepos()
        if (repos.length === 0) {
          return yield* Effect.fail(
            new McpError(ErrorCode.InvalidRequest, "No repositories have been indexed yet.")
          )
        }
        return repos[0]?.id ?? ""
      })

    try {
      switch (name) {
        case "repo_map": {
          const args = Schema.decodeUnknownSync(RepoMapInput)(rawArgs ?? {})
          const text = await runtime.runPromise(
            Effect.gen(function* () {
              const query = yield* GraphQuery
              const repoId = yield* getTargetRepoId(args.repoId)
              return yield* query.repoMap(repoId, args.maxTokens ?? 2000)
            })
          )
          return { content: [{ type: "text", text }] }
        }

        case "outline_file": {
          const args = Schema.decodeUnknownSync(OutlineFileInput)(rawArgs ?? {})
          const symbols = await runtime.runPromise(
            Effect.gen(function* () {
              const query = yield* GraphQuery
              const repoId = yield* getTargetRepoId(args.repoId)
              return yield* query.outlineFile(repoId, args.path)
            })
          )
          const lines = symbols.map((s) => {
            const doc = docSnippet(s.doc)
            return `L${s.startLine}-${s.endLine} [${s.kind}] ${s.signature}${doc ? `\n  doc: ${doc}` : ""}`
          })
          return {
            content: [
              {
                type: "text",
                text: lines.length > 0 ? lines.join("\n") : `No symbols found in ${args.path}`
              }
            ]
          }
        }

        case "detect_changes": {
          const args = Schema.decodeUnknownSync(DetectChangesInput)(rawArgs ?? {})
          const report = await runtime.runPromise(
            Effect.gen(function* () {
              const impact = yield* ChangeImpact
              const repoId = yield* getTargetRepoId(args.repoId)
              return yield* impact.detect(repoId, args.base)
            })
          )

          const changed = report.changedFiles.map(
            (filePath) =>
              `  ${filePath}${report.indexedFiles.includes(filePath) ? "" : " (not indexed)"}`
          )
          const affected = report.affectedSymbols.map(
            (symbol) => `  ${symbol.name} (${symbol.kind}) ${symbol.filePath}:${symbol.startLine}`
          )
          const impacted = report.impactedSymbols.map(
            (symbol) =>
              `  ${symbol.name} (${symbol.kind}) ${symbol.filePath}:${symbol.startLine} <- ${symbol.referencedBy.join(", ")}`
          )
          const text = [
            `changed files (${report.changedFiles.length}):`,
            ...(changed.length > 0 ? changed : ["  none"]),
            `affected symbols (${report.affectedSymbols.length}):`,
            ...(affected.length > 0 ? affected : ["  none"]),
            `blast radius (${report.impactedSymbols.length})${report.truncated ? " · truncated=true" : ""}:`,
            ...(impacted.length > 0 ? impacted : ["  none"])
          ].join("\n")
          return { content: [{ type: "text", text }] }
        }

        case "trace_path": {
          const args = Schema.decodeUnknownSync(TracePathInput)(rawArgs ?? {})
          const result = await runtime.runPromise(
            Effect.gen(function* () {
              const query = yield* GraphQuery
              return yield* query.tracePath(args.selector, {
                ...(args.direction !== undefined ? { direction: args.direction } : {}),
                ...(args.depth !== undefined ? { depth: args.depth } : {}),
                ...(args.mode !== undefined ? { mode: args.mode } : {})
              })
            })
          )

          if (!result) {
            return {
              content: [{ type: "text", text: `No symbol matched selector "${args.selector}".` }]
            }
          }

          const names = new Map(result.nodes.map((node) => [node.id, node.name]))
          const nodeLines = result.nodes.map(
            (node) =>
              `[hop ${node.hop}] ${node.name} (${node.kind}) ${node.filePath}:${node.startLine}`
          )
          const edgeLines = result.edges.map((edge) => {
            const from = names.get(edge.srcSymbolId) ?? edge.srcSymbolId
            const to = names.get(edge.dstSymbolId) ?? edge.dstSymbolId
            return `  ${from} --[${edge.kind}]--> ${to}`
          })
          const text = [
            `start: ${result.start.name} (${result.start.kind}) ${result.start.filePath}:${result.start.startLine}`,
            `nodes (${result.nodes.length})${result.truncated ? " · truncated=true" : ""}:`,
            ...nodeLines,
            `edges (${result.edges.length}):`,
            ...(edgeLines.length > 0 ? edgeLines : ["  none"])
          ].join("\n")
          return { content: [{ type: "text", text }] }
        }

        case "get_architecture": {
          const args = Schema.decodeUnknownSync(ArchitectureInput)(rawArgs ?? {})
          const text = await runtime.runPromise(
            Effect.gen(function* () {
              const query = yield* GraphQuery
              const repoId = yield* getTargetRepoId(args.repoId)
              const summary = yield* query.architecture(repoId)
              const languages = Object.entries(summary.languages)
                .map(([language, count]) => `${language}=${count}`)
                .join(", ")
              const packages = summary.packages
                .map((pkg) => `  ${pkg.name}: files=${pkg.files} symbols=${pkg.symbols}`)
                .join("\n")
              const entryPoints = summary.entryPoints
                .map(
                  (symbol) =>
                    `  ${symbol.name} (${symbol.kind}) ${symbol.filePath}:${symbol.startLine}`
                )
                .join("\n")
              const hotspots = summary.hotspots
                .map(
                  (symbol) =>
                    `  ${symbol.name} (${symbol.kind}) ${symbol.filePath}:${symbol.startLine} in=${symbol.inDegree}`
                )
                .join("\n")
              return [
                `Repository: ${summary.repoId} files=${summary.files} symbols=${summary.symbols} edges=${summary.edges}`,
                `languages: ${languages || "none"}`,
                `packages:\n${packages || "  none"}`,
                `entry points:\n${entryPoints || "  none"}`,
                `hotspots:\n${hotspots || "  none"}`
              ].join("\n")
            })
          )
          return { content: [{ type: "text", text }] }
        }

        case "index_job_status": {
          const args = Schema.decodeUnknownSync(IndexJobStatusInput)(rawArgs ?? {})
          const result = await runtime.runPromise(
            Effect.gen(function* () {
              const jobs = yield* IndexJobs
              return yield* jobs.getJob(args.jobId)
            })
          )
          if (!result) {
            return { content: [{ type: "text", text: `Job not found: ${args.jobId}.` }] }
          }
          const report = result.report as
            | { filesIndexed?: number; symbolsCount?: number; edgesCount?: number }
            | undefined
          const text = [
            `job ${result.id} status=${result.status}`,
            `  path: ${result.path}`,
            result.repoId ? `  repoId: ${result.repoId}` : undefined,
            result.startedAt ? `  started: ${result.startedAt}` : undefined,
            result.finishedAt ? `  finished: ${result.finishedAt}` : undefined,
            report
              ? `  filesIndexed: ${report.filesIndexed ?? 0} symbols: ${report.symbolsCount ?? 0} edges: ${report.edgesCount ?? 0}`
              : undefined,
            result.error ? `  error: ${result.error}` : undefined
          ]
            .filter((line): line is string => Boolean(line))
            .join("\n")
          return { content: [{ type: "text", text }] }
        }

        case "delete_project": {
          const args = Schema.decodeUnknownSync(DeleteProjectInput)(rawArgs ?? {})
          const deleted = await runtime.runPromise(
            Effect.gen(function* () {
              const store = yield* IndexStore
              return yield* store.deleteRepo(args.repoId)
            })
          )
          return {
            content: [
              {
                type: "text",
                text: deleted
                  ? `Deleted index ${args.repoId}.`
                  : `Repository not found: ${args.repoId}.`
              }
            ]
          }
        }

        case "index_repository": {
          const args = Schema.decodeUnknownSync(IndexRepositoryInput)(rawArgs ?? {})
          if (args.async) {
            const job = await runtime.runPromise(
              Effect.gen(function* () {
                const runner = yield* IndexJobRunner
                return yield* runner.start({
                  path: args.path,
                  ...(args.name !== undefined ? { name: args.name } : {}),
                  ...(args.force !== undefined ? { force: args.force } : {})
                })
              })
            )
            return {
              content: [
                {
                  type: "text",
                  text: `job ${job.id} status=${job.status} path=${job.path}`
                }
              ]
            }
          }

          const report = await runtime.runPromise(
            Effect.gen(function* () {
              const indexer = yield* Indexer
              return yield* indexer.indexRepo(args.path, {
                ...(args.name !== undefined ? { name: args.name } : {}),
                ...(args.force !== undefined ? { force: args.force } : {})
              })
            })
          )
          const text = [
            `indexed ${report.repoName} (${report.repoId})`,
            `  files indexed=${report.filesIndexed} skipped=${report.filesSkipped} deleted=${report.filesDeleted}`,
            `  symbols=${report.symbolsCount} edges=${report.edgesCount} duration=${report.durationMs}ms`,
            `  coverage: parsed=${report.coverage.parsed} partial=${report.coverage.partial} unsupported=${report.coverage.unsupported} unknown=${report.coverage.unknown}`
          ].join("\n")
          return { content: [{ type: "text", text }] }
        }

        case "list_projects": {
          const text = await runtime.runPromise(
            Effect.gen(function* () {
              const store = yield* IndexStore
              const repos = yield* store.listRepos()
              if (repos.length === 0) return "No repositories indexed yet."
              const lines: string[] = []
              for (const repo of repos) {
                const stats = yield* store.getStats(repo.id)
                lines.push(
                  `${repo.name} — ${repo.id}\n  root: ${repo.rootPath}\n  files=${stats.files} symbols=${stats.symbols} edges=${stats.edges} source=${stats.sourceBytes} bytes\n  indexed=${repo.indexedAt ?? "never"}${repo.indexDurationMs !== undefined ? ` (${repo.indexDurationMs}ms)` : ""}`
                )
              }
              return lines.join("\n")
            })
          )
          return { content: [{ type: "text", text }] }
        }

        case "analyze_graph": {
          const args = Schema.decodeUnknownSync(AnalyzeGraphInput)(rawArgs ?? {})
          const text = await runtime.runPromise(
            Effect.gen(function* () {
              const analytics = yield* Analytics
              const repoId = yield* getTargetRepoId(args.repoId)
              const header = `analysis=${args.analysis} repo=${repoId}`

              if (args.analysis === "cycles") {
                const groups = yield* analytics.cycles(repoId, {
                  level: args.level ?? "symbol",
                  ...(args.limit !== undefined ? { limit: args.limit } : {})
                })
                if (groups.length === 0) return `${header}\nNo cycles found.`
                const body = groups
                  .map((group, index) => {
                    const members = group.members
                      .map(
                        (member) =>
                          `  ${member.name ?? member.id} ${member.filePath}${member.startLine ? `:${member.startLine}` : ""}`
                      )
                      .join("\n")
                    return `cycle ${index + 1} (size=${group.size}, level=${group.level})\n${members}`
                  })
                  .join("\n\n")
                return `${header}\n${groups.length} cycle(s)\n\n${body}`
              }

              if (args.analysis === "communities") {
                const level = args.level === "file" ? "file" : "symbol"
                const groups = yield* analytics.communities(repoId, {
                  level,
                  ...(args.limit !== undefined ? { limit: args.limit } : {})
                })
                if (groups.length === 0) return `${header}\nNo communities found.`
                const body = groups
                  .map((group, index) => {
                    const members = group.members
                      .map(
                        (member) =>
                          `  ${member.name ?? member.id} ${member.filePath}${member.startLine ? `:${member.startLine}` : ""}`
                      )
                      .join("\n")
                    return `community ${index + 1} (label=${group.label}, size=${group.size})\n${members}`
                  })
                  .join("\n\n")
                return `${header}\n${groups.length} community group(s)\n\n${body}`
              }

              if (args.analysis === "packages") {
                const results = yield* analytics.packageRankings(repoId, {
                  ...(args.limit !== undefined ? { limit: args.limit } : {})
                })
                const body = results
                  .map(
                    (pkg) =>
                      `${pkg.name} score=${pkg.score} fanIn=${pkg.fanIn} fanOut=${pkg.fanOut} files=${pkg.files} symbols=${pkg.symbols}`
                  )
                  .join("\n")
                return `${header}\n${results.length} package(s)\n\n${body || "none"}`
              }

              if (args.analysis === "dead_code") {
                const results = yield* analytics.deadCode(repoId, {
                  ...(args.limit !== undefined ? { limit: args.limit } : {})
                })
                if (results.length === 0) return `${header}\nNo dead-code candidates.`
                const body = results
                  .map(
                    (symbol) =>
                      `${symbol.name} (${symbol.kind}) ${symbol.filePath}:${symbol.startLine} [${symbol.language}]`
                  )
                  .join("\n")
                return `${header}\n${results.length} candidate(s)\n\n${body}`
              }

              if (args.analysis === "hotspots") {
                const results = yield* analytics.hotspots(repoId, {
                  ...(args.limit !== undefined ? { limit: args.limit } : {})
                })
                const body = results
                  .map(
                    (symbol, index) =>
                      `${index + 1}. ${symbol.name} (${symbol.kind}) ${symbol.filePath}:${symbol.startLine} score=${symbol.score} fanIn=${symbol.fanIn} fanOut=${symbol.fanOut} cx=${symbol.cyclomatic} cog=${symbol.cognitive}`
                  )
                  .join("\n")
                return `${header}\n${results.length} hotspot(s)\n\n${body || "none"}`
              }

              const algorithm =
                args.analysis === "in_degree"
                  ? "in_degree"
                  : args.analysis === "complexity"
                    ? "complexity"
                    : "pagerank"
              const results = yield* analytics.rank(repoId, {
                algorithm,
                ...(args.limit !== undefined ? { limit: args.limit } : {})
              })
              const body = results
                .map(
                  (symbol, index) =>
                    `${index + 1}. ${symbol.name} (${symbol.kind}) ${symbol.filePath}:${symbol.startLine} score=${symbol.score} in=${symbol.inDegree} out=${symbol.outDegree} cx=${symbol.cyclomatic} cog=${symbol.cognitive}`
                )
                .join("\n")
              return `${header}\n${results.length} result(s)\n\n${body || "none"}`
            })
          )
          return { content: [{ type: "text", text }] }
        }

        case "compare_snapshots": {
          const args = Schema.decodeUnknownSync(CompareSnapshotsInput)(rawArgs ?? {})
          const result = await runtime.runPromise(
            Effect.gen(function* () {
              const store = yield* IndexStore
              const repoId = yield* getTargetRepoId(args.repoId)
              return yield* store.compareSnapshots(repoId, args.from, args.to)
            })
          )
          if (!result) {
            return {
              content: [
                {
                  type: "text",
                  text: "At least two snapshots are required. Re-index to create a new snapshot."
                }
              ]
            }
          }
          const totals = result.totals
            .map(
              (entry) =>
                `  ${entry.name}: ${entry.from} -> ${entry.to} (${entry.delta >= 0 ? "+" : ""}${entry.delta})`
            )
            .join("\n")
          const changes = (label: string, entries: readonly { name: string; delta: number }[]) =>
            entries.length > 0
              ? `${label}: ${entries.map((entry) => `${entry.name} ${entry.delta >= 0 ? "+" : ""}${entry.delta}`).join(", ")}`
              : undefined
          const text = [
            `snapshots ${result.repoId}: ${result.from.createdAt} -> ${result.to.createdAt}`,
            totals,
            changes("languages", result.languages),
            changes("symbol kinds", result.symbolKinds),
            changes("edge kinds", result.edgeKinds),
            changes("coverage", result.coverage)
          ]
            .filter((line): line is string => Boolean(line))
            .join("\n")
          return { content: [{ type: "text", text }] }
        }

        case "query_graph": {
          const args = Schema.decodeUnknownSync(QueryGraphInput)(rawArgs ?? {})
          const result = await runtime.runPromise(
            Effect.gen(function* () {
              const language = yield* QueryLanguage
              return yield* language.execute(args.query, {
                ...(args.repoId !== undefined ? { repoId: args.repoId } : {}),
                ...(args.limit !== undefined ? { limit: args.limit } : {})
              })
            })
          )
          const header = `${result.returned} of ${result.total} rows${result.truncated ? " · truncated=true" : ""}`
          const body = result.rows.map((row) => JSON.stringify(row)).join("\n")
          return {
            content: [
              {
                type: "text",
                text: `columns: ${result.columns.join(", ")}\n${header}\n${body || "(no rows)"}`
              }
            ]
          }
        }

        case "search_graph": {
          const args = Schema.decodeUnknownSync(SearchGraphInput)(rawArgs ?? {})
          const result = await runtime.runPromise(
            Effect.gen(function* () {
              const query = yield* GraphQuery
              return yield* query.searchGraph({
                ...(args.namePattern !== undefined ? { namePattern: args.namePattern } : {}),
                ...(args.regex !== undefined ? { regex: args.regex } : {}),
                ...(args.kind !== undefined ? { kind: args.kind } : {}),
                ...(args.filePattern !== undefined ? { filePattern: args.filePattern } : {}),
                ...(args.repoId !== undefined ? { repoId: args.repoId } : {}),
                ...(args.minDegree !== undefined ? { minDegree: args.minDegree } : {}),
                ...(args.maxDegree !== undefined ? { maxDegree: args.maxDegree } : {}),
                ...(args.limit !== undefined ? { limit: args.limit } : {}),
                ...(args.offset !== undefined ? { offset: args.offset } : {})
              })
            })
          )

          const header = [
            `Showing ${result.results.length} of ${result.total} (offset ${args.offset ?? 0})`,
            result.hasMore ? "has_more=true" : "has_more=false",
            result.truncated ? "truncated=true (candidate cap reached)" : undefined
          ]
            .filter((line): line is string => Boolean(line))
            .join(" · ")

          const body = result.results
            .map(
              (symbol) =>
                `${symbol.name} (${symbol.kind}) at ${symbol.filePath}:${symbol.startLine}\n  ID: ${symbol.id}\n  in-degree: ${symbol.inDegree ?? 0}\n  ${symbol.signature}`
            )
            .join("\n\n")

          return {
            content: [
              {
                type: "text",
                text: body ? `${header}\n\n${body}` : `${header}\n\nNo symbols matched.`
              }
            ]
          }
        }

        case "search_symbol": {
          const args = Schema.decodeUnknownSync(SearchSymbolInput)(rawArgs ?? {})
          const results = await runtime.runPromise(
            Effect.gen(function* () {
              const query = yield* GraphQuery
              return yield* query.searchSymbols(args.query, args.limit ?? 20, args.repoId)
            })
          )
          const lines = results.map((s) => {
            const doc = docSnippet(s.doc)
            return `${s.name} (${s.kind}) in ${s.filePath}:${s.startLine}\n  ID: ${s.id}\n  In-degree: ${s.inDegree ?? 0}\n  ${s.signature}${doc ? `\n  doc: ${doc}` : ""}`
          })
          return {
            content: [
              {
                type: "text",
                text: lines.length > 0 ? lines.join("\n\n") : `No symbols matched "${args.query}"`
              }
            ]
          }
        }

        case "find_references": {
          const args = Schema.decodeUnknownSync(FindReferencesInput)(rawArgs ?? {})
          const references = await runtime.runPromise(
            Effect.gen(function* () {
              const query = yield* GraphQuery
              return yield* query.findReferences(args.symbolId)
            })
          )
          const lines = references.map(
            (r) =>
              `[${r.kind}] from ${r.sourceSymbol.name} (${r.sourceSymbol.kind}) at ${r.sourceSymbol.filePath}:${r.sourceSymbol.startLine}`
          )
          return {
            content: [
              {
                type: "text",
                text:
                  lines.length > 0
                    ? lines.join("\n")
                    : `No incoming references found for ${args.symbolId}`
              }
            ]
          }
        }

        case "neighborhood": {
          const args = Schema.decodeUnknownSync(NeighborhoodInput)(rawArgs ?? {})
          const graph = await runtime.runPromise(
            Effect.gen(function* () {
              const query = yield* GraphQuery
              return yield* query.neighborhood(args.symbolId, args.depth ?? 1)
            })
          )
          const nodesText = graph.nodes
            .map((n) => `- ${n.name} [${n.kind}] (${n.filePath}:${n.startLine})`)
            .join("\n")
          const edgesText = graph.edges
            .map((e) => `  ${e.srcSymbolId} --[${e.kind}]--> ${e.dstSymbolId}`)
            .join("\n")
          const output = `Nodes (${graph.nodes.length}):\n${nodesText}\n\nEdges (${graph.edges.length}):\n${edgesText}`
          return { content: [{ type: "text", text: output }] }
        }

        case "get_graph_schema": {
          const args = Schema.decodeUnknownSync(GraphSchemaInput)(rawArgs ?? {})
          const text = await runtime.runPromise(
            Effect.gen(function* () {
              const store = yield* IndexStore
              const repoId = yield* getTargetRepoId(args.repoId)
              const repo = yield* store.getRepo(repoId)
              const stats = yield* store.getStats(repoId)
              return [
                "Node labels: Repository, File, Symbol (function, class, interface, type, enum, method, property, const), Package",
                "Edge kinds: import, imports (file-level), defines, contains, call, call_reference, usage, reference, extends, implements, throws, raises",
                "Symbol properties: id, name, qualifiedName, kind, language, visibility, containerName, startLine, endLine, signature, doc, exported, inDegree",
                "File edge table: srcFileId -> dstFileId (imports), with unresolved specifiers retained",
                `Repository: ${repo?.name ?? repoId} files=${stats.files} symbols=${stats.symbols} edges=${stats.edges}`
              ].join("\n")
            })
          )
          return { content: [{ type: "text", text }] }
        }

        case "get_code_snippet": {
          const args = Schema.decodeUnknownSync(CodeSnippetInput)(rawArgs ?? {})
          const text = await runtime.runPromise(
            Effect.gen(function* () {
              const query = yield* GraphQuery
              const store = yield* IndexStore
              const fs = yield* FileSystem.FileSystem
              const path = yield* Path.Path
              const repoId = yield* getTargetRepoId(args.repoId)

              const symbol = yield* query.getSymbolByQualifiedName(args.qualifiedName, repoId)
              if (!symbol) {
                return `No symbol matched qualified name "${args.qualifiedName}".`
              }

              const repo = yield* store.getRepo(repoId)
              if (!repo) return `Repository not found: ${repoId}`

              const absolutePath = path.isAbsolute(symbol.filePath)
                ? symbol.filePath
                : path.join(repo.rootPath, symbol.filePath)
              const exists = yield* fs.exists(absolutePath).pipe(Effect.orElseSucceed(() => false))
              if (!exists) return `File not found on disk: ${symbol.filePath}`

              const content = yield* fs.readFileString(absolutePath)
              const lines = content.split("\n")
              const start = Math.max(1, symbol.startLine)
              const end = Math.min(lines.length, symbol.endLine, start + 399)
              const body = lines
                .slice(start - 1, end)
                .map((line, index) => `${start + index} | ${line}`)
                .join("\n")

              const header = [
                `${symbol.kind} ${symbol.name} — ${symbol.filePath}:${symbol.startLine}-${symbol.endLine}`,
                `signature: ${symbol.signature}`,
                symbol.doc ? `doc: ${docSnippet(symbol.doc)}` : undefined
              ]
                .filter((line): line is string => Boolean(line))
                .join("\n")
              return `${header}\n${body}`
            })
          )
          return { content: [{ type: "text", text }] }
        }

        case "search_code": {
          const args = Schema.decodeUnknownSync(SearchCodeInput)(rawArgs ?? {})
          const text = await runtime.runPromise(
            Effect.gen(function* () {
              const store = yield* IndexStore
              const fs = yield* FileSystem.FileSystem
              const path = yield* Path.Path
              const repoId = yield* getTargetRepoId(args.repoId)
              const repo = yield* store.getRepo(repoId)
              if (!repo) return `Repository not found: ${repoId}`

              const limit = Math.max(1, Math.min(200, args.limit ?? 50))
              const files = yield* store.getFiles(repoId)
              const paths = Array.from(files.values())
                .map((file) => file.path)
                .sort()

              const matcher = args.regex
                ? (line: string) => new RegExp(args.query, args.caseSensitive ? "" : "i").test(line)
                : (line: string) =>
                    (args.caseSensitive ? line : line.toLowerCase()).includes(
                      args.caseSensitive ? args.query : args.query.toLowerCase()
                    )

              const matches: string[] = []
              for (const filePath of paths) {
                if (matches.length >= limit) break
                const absolutePath = path.isAbsolute(filePath)
                  ? filePath
                  : path.join(repo.rootPath, filePath)
                const content = yield* fs
                  .readFileString(absolutePath)
                  .pipe(Effect.orElseSucceed(() => undefined))
                if (content === undefined || content.length > 1_000_000) continue

                const lines = content.split("\n")
                for (let index = 0; index < lines.length && matches.length < limit; index++) {
                  const line = lines[index] ?? ""
                  if (!matcher(line)) continue
                  matches.push(`${filePath}:${index + 1}: ${line.trim().slice(0, 240)}`)
                }
              }

              return matches.length > 0
                ? matches.join("\n")
                : `No matches for "${args.query}" in ${repo.name}.`
            })
          )
          return { content: [{ type: "text", text }] }
        }

        case "index_status": {
          const args = Schema.decodeUnknownSync(IndexStatusInput)(rawArgs ?? {})
          const text = await runtime.runPromise(
            Effect.gen(function* () {
              const diagnostics = yield* Diagnostics
              const repoId = yield* getTargetRepoId(args.repoId)
              const status = yield* diagnostics.repoStatus(repoId)
              return formatStatus(status)
            })
          )
          return { content: [{ type: "text", text }] }
        }

        case "read_file_range": {
          const args = Schema.decodeUnknownSync(ReadFileRangeInput)(rawArgs ?? {})
          const text = await runtime.runPromise(
            Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem
              const path = yield* Path.Path
              const store = yield* IndexStore

              let resolvedFilePath = args.path
              if (!path.isAbsolute(args.path)) {
                const repoId = yield* getTargetRepoId(args.repoId)
                const repo = yield* store.getRepo(repoId)
                if (repo) {
                  resolvedFilePath = path.join(repo.rootPath, args.path)
                }
              }

              const exists = yield* fs
                .exists(resolvedFilePath)
                .pipe(Effect.orElseSucceed(() => false))
              if (!exists) {
                return `File not found: ${args.path}`
              }

              const fileContent = yield* fs.readFileString(resolvedFilePath)
              const allLines = fileContent.split("\n")
              const start = Math.max(1, args.startLine)
              const end = Math.min(allLines.length, args.endLine)

              const slice = allLines.slice(start - 1, end)
              return slice.map((line, idx) => `${start + idx} | ${line}`).join("\n")
            })
          )
          return { content: [{ type: "text", text }] }
        }

        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`)
      }
    } catch (err: unknown) {
      if (err instanceof McpError) throw err
      const message = err instanceof Error ? err.message : String(err)
      return {
        content: [{ type: "text", text: `Error executing tool ${name}: ${message}` }],
        isError: true
      }
    }
  })

  return server
}

export const startMcpServer = <R>(
  runtime: ManagedRuntime.ManagedRuntime<
    | IndexStore
    | GraphQuery
    | Diagnostics
    | ChangeImpact
    | Indexer
    | IndexJobs
    | IndexJobRunner
    | QueryLanguage
    | Analytics
    | FileSystem.FileSystem
    | Path.Path
    | R,
    unknown
  >
) => {
  const server = createMcpServer(runtime)
  const transport = new StdioServerTransport()

  // `connect` resolves as soon as the transport starts. Keep the caller's
  // effect alive until the transport closes, otherwise the CLI's scoped
  // SqlClient is finalized while the MCP process is still serving requests.
  return new Promise<void>((resolve, reject) => {
    server.onclose = () => resolve()
    server.connect(transport).catch(reject)
  })
}
