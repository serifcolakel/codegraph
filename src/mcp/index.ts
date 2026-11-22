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
import { CrossRepo } from "../services/CrossRepo.js"
import { Diagnostics, formatStatus } from "../services/Diagnostics.js"
import { Freshness } from "../services/Freshness.js"
import { GraphQuery } from "../services/GraphQuery.js"
import { Indexer } from "../services/Indexer.js"
import { IndexJobRunner } from "../services/IndexJobRunner.js"
import { IndexJobs } from "../services/IndexJobs.js"
import { IndexStore } from "../services/IndexStore.js"
import { QueryLanguage } from "../services/QueryLanguage.js"

const docSnippet = (doc?: string): string =>
  doc ? doc.replace(/\s+/g, " ").trim().slice(0, 180) : ""

const optionalRepoId = Schema.optional(Schema.String)

// Tool input schemas. One tool per task; options select the mode.
export const IndexRepositoryInput = Schema.Struct({
  action: Schema.optional(Schema.Literal("index", "status", "list", "delete", "job")),
  path: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  force: Schema.optional(Schema.Boolean),
  async: Schema.optional(Schema.Boolean),
  repoId: optionalRepoId,
  jobId: Schema.optional(Schema.String)
})
export type IndexRepositoryInput = typeof IndexRepositoryInput.Type

export const SearchGraphInput = Schema.Struct({
  query: Schema.optional(Schema.String),
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
      "doc",
      "route",
      "decision",
      "config",
      "channel"
    )
  ),
  filePattern: Schema.optional(Schema.String),
  repoId: optionalRepoId,
  minDegree: Schema.optional(Schema.Number),
  maxDegree: Schema.optional(Schema.Number),
  limit: Schema.optional(Schema.Number),
  offset: Schema.optional(Schema.Number),
  semantic: Schema.optional(Schema.Boolean)
})
export type SearchGraphInput = typeof SearchGraphInput.Type

export const SearchCodeInput = Schema.Struct({
  query: Schema.String,
  mode: Schema.optional(Schema.Literal("compact", "full", "files")),
  context: Schema.optional(Schema.Number),
  regex: Schema.optional(Schema.Boolean),
  caseSensitive: Schema.optional(Schema.Boolean),
  repoId: optionalRepoId,
  limit: Schema.optional(Schema.Number)
})
export type SearchCodeInput = typeof SearchCodeInput.Type

export const CodeSnippetInput = Schema.Struct({
  qualifiedName: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  startLine: Schema.optional(Schema.Number),
  endLine: Schema.optional(Schema.Number),
  repoId: optionalRepoId
})
export type CodeSnippetInput = typeof CodeSnippetInput.Type

export const TracePathInput = Schema.Struct({
  selector: Schema.optional(Schema.String),
  direction: Schema.optional(Schema.Literal("inbound", "outbound", "both")),
  depth: Schema.optional(Schema.Number),
  mode: Schema.optional(
    Schema.Literal("calls", "references", "data_flow", "cross_file", "neighborhood", "cross_repo")
  ),
  repoId: optionalRepoId,
  refresh: Schema.optional(Schema.Boolean)
})
export type TracePathInput = typeof TracePathInput.Type

export const ArchitectureInput = Schema.Struct({
  view: Schema.optional(Schema.Literal("summary", "map", "outline", "schema")),
  repoId: optionalRepoId,
  path: Schema.optional(Schema.String),
  maxTokens: Schema.optional(Schema.Number)
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
    "packages",
    "duplicates",
    "changes",
    "snapshots"
  ),
  repoId: optionalRepoId,
  level: Schema.optional(Schema.Literal("symbol", "file", "package")),
  limit: Schema.optional(Schema.Number),
  threshold: Schema.optional(Schema.Number),
  base: Schema.optional(Schema.String),
  from: Schema.optional(Schema.String),
  to: Schema.optional(Schema.String)
})
export type AnalyzeGraphInput = typeof AnalyzeGraphInput.Type

export const QueryGraphInput = Schema.Struct({
  query: Schema.String,
  repoId: optionalRepoId,
  limit: Schema.optional(Schema.Number)
})
export type QueryGraphInput = typeof QueryGraphInput.Type

const toolDefinitions = [
  {
    name: "index_repository",
    description:
      "Index or manage local repositories. action=index (default) incrementally indexes path; status reports coverage, unresolved edges and freshness; list shows indexed repositories; job polls an async index job; delete removes an index. Use async=true for large repositories.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["index", "status", "list", "delete", "job"],
          default: "index"
        },
        path: { type: "string", description: "Repository path for action=index" },
        name: { type: "string", description: "Optional display name" },
        force: { type: "boolean", description: "Reparse every file even if unchanged" },
        async: {
          type: "boolean",
          description: "Return a job id immediately and index in the background"
        },
        repoId: { type: "string", description: "Repository ID for status/delete" },
        jobId: { type: "string", description: "Job ID for action=job" }
      }
    }
  },
  {
    name: "search_graph",
    description:
      "Find symbols in the code graph. Use query for BM25/camelCase full-text search, namePattern+regex for exact patterns, or semantic=true for intent search. Filter by kind, file path and degree; paginate with limit/offset while has_more=true. Prefer this over grep for definitions, implementations and relationships.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language or keyword query" },
        namePattern: {
          type: "string",
          description: "Name substring, or regex when regex=true"
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
            "enum",
            "doc",
            "route",
            "decision",
            "config",
            "channel"
          ]
        },
        filePattern: { type: "string", description: "File path substring filter" },
        repoId: { type: "string", description: "Optional repo ID" },
        minDegree: { type: "number", description: "Minimum in-degree" },
        maxDegree: { type: "number", description: "Maximum in-degree" },
        limit: { type: "number", description: "Page size (default 20, max 200)" },
        offset: { type: "number", description: "Result offset for paging" },
        semantic: {
          type: "boolean",
          description: "Hybrid BM25 + vector similarity ranking"
        }
      }
    }
  },
  {
    name: "search_code",
    description:
      "Search literal or regex text inside indexed files. mode=compact returns file:line matches, full adds surrounding lines, files returns unique paths. Use only for string literals, config and text; use search_graph for symbols.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Literal text, or regex when regex=true" },
        mode: { type: "string", enum: ["compact", "full", "files"], default: "compact" },
        context: { type: "number", description: "Surrounding lines in full mode" },
        regex: { type: "boolean", description: "Treat query as a regular expression" },
        caseSensitive: { type: "boolean", description: "Case-sensitive matching" },
        repoId: { type: "string", description: "Optional repo ID" },
        limit: { type: "number", description: "Max matches (default 50, max 200)" }
      },
      required: ["query"]
    }
  },
  {
    name: "get_code_snippet",
    description:
      "Read source. Pass qualifiedName from search_graph for a symbol, or path with startLine/endLine for an exact file range. This is a read tool, not a search tool.",
    inputSchema: {
      type: "object",
      properties: {
        qualifiedName: {
          type: "string",
          description: "Qualified name from search_graph, e.g. src.service.UserService"
        },
        path: { type: "string", description: "File path for range reads" },
        startLine: { type: "number", description: "1-based start line for range reads" },
        endLine: { type: "number", description: "1-based end line for range reads" },
        repoId: { type: "string", description: "Optional repo ID" }
      }
    }
  },
  {
    name: "trace_path",
    description:
      "Trace relationships. mode=calls follows callers/callees; data_flow follows values; cross_file follows file imports; references lists incoming references; neighborhood returns the surrounding subgraph with depth; cross_repo lists or refreshes HTTP/async links across indexed repositories.",
    inputSchema: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "Symbol ID or qualified name (not needed for cross_repo)"
        },
        direction: { type: "string", enum: ["inbound", "outbound", "both"], default: "both" },
        depth: { type: "number", description: "Hops (default 2, max 6)" },
        mode: {
          type: "string",
          enum: ["calls", "references", "data_flow", "cross_file", "neighborhood", "cross_repo"],
          default: "calls"
        },
        repoId: { type: "string", description: "Optional repo ID" },
        refresh: { type: "boolean", description: "Recompute cross-repo links first" }
      }
    }
  },
  {
    name: "get_architecture",
    description:
      "Get repository structure. view=summary (default) reports languages, packages, entry points and hotspots; map ranks exported signatures; outline lists symbols in a file (path required); schema describes node labels, edge kinds and symbol properties.",
    inputSchema: {
      type: "object",
      properties: {
        view: { type: "string", enum: ["summary", "map", "outline", "schema"], default: "summary" },
        repoId: { type: "string", description: "Optional repo ID" },
        path: { type: "string", description: "File path for view=outline" },
        maxTokens: { type: "number", description: "Token budget for view=map (default 2000)" }
      }
    }
  },
  {
    name: "analyze_graph",
    description:
      "Analyze the graph. analysis=pagerank|in_degree|complexity|hotspots|dead_code|cycles|communities|packages|duplicates for structure and quality; changes maps git changes to blast radius (base); snapshots compares two index runs (from/to).",
    inputSchema: {
      type: "object",
      properties: {
        analysis: {
          type: "string",
          enum: [
            "pagerank",
            "in_degree",
            "complexity",
            "hotspots",
            "dead_code",
            "cycles",
            "communities",
            "packages",
            "duplicates",
            "changes",
            "snapshots"
          ]
        },
        repoId: { type: "string", description: "Optional repo ID" },
        level: { type: "string", enum: ["symbol", "file", "package"] },
        limit: { type: "number", description: "Max results (default varies, max 200)" },
        threshold: { type: "number", description: "Duplicate similarity threshold (default 0.8)" },
        base: { type: "string", description: "Git base ref for analysis=changes" },
        from: { type: "string", description: "Older snapshot ID for analysis=snapshots" },
        to: { type: "string", description: "Newer snapshot ID for analysis=snapshots" }
      },
      required: ["analysis"]
    }
  },
  {
    name: "query_graph",
    description:
      "Run a safe read-only Cypher subset over Symbol, File and Repository nodes. Use for custom multi-hop patterns and aggregations; use search_graph for plain symbol lookup.",
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
  }
] as const

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
    | CrossRepo
    | Freshness
    | FileSystem.FileSystem
    | Path.Path
    | R,
    unknown
  >
) => {
  const server = new Server(
    { name: "codegraph-mcp", version: "0.2.0" },
    { capabilities: { tools: {} } }
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefinitions }))

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
        case "index_repository": {
          const args = Schema.decodeUnknownSync(IndexRepositoryInput)(rawArgs ?? {})
          const action = args.action ?? "index"

          if (action === "status") {
            const text = await runtime.runPromise(
              Effect.gen(function* () {
                const diagnostics = yield* Diagnostics
                const repoId = yield* getTargetRepoId(args.repoId)
                const status = yield* diagnostics.repoStatus(repoId)
                const freshness = yield* Freshness
                const freshnessLine = yield* freshness.check(repoId).pipe(
                  Effect.map(
                    (report) =>
                      `freshness: stale=${report.stale} added=${report.files.added} modified=${report.files.modified} deleted=${report.files.deleted}`
                  ),
                  Effect.catchAll((error) =>
                    Effect.succeed(`freshness: unavailable (${error._tag})`)
                  )
                )
                return `${formatStatus(status)}\n  ${freshnessLine}`
              })
            )
            return { content: [{ type: "text", text }] }
          }

          if (action === "list") {
            const text = await runtime.runPromise(
              Effect.gen(function* () {
                const store = yield* IndexStore
                const repos = yield* store.listRepos()
                if (repos.length === 0) return "No repositories indexed yet."
                const lines: string[] = []
                for (const repo of repos) {
                  const stats = yield* store.getStats(repo.id)
                  lines.push(
                    `${repo.name} - ${repo.id}\n  root: ${repo.rootPath}\n  files=${stats.files} symbols=${stats.symbols} edges=${stats.edges} source=${stats.sourceBytes} bytes\n  indexed=${repo.indexedAt ?? "never"}${repo.indexDurationMs !== undefined ? ` (${repo.indexDurationMs}ms)` : ""}`
                  )
                }
                return lines.join("\n")
              })
            )
            return { content: [{ type: "text", text }] }
          }

          if (action === "delete") {
            if (!args.repoId) {
              throw new McpError(ErrorCode.InvalidParams, "repoId is required for action=delete.")
            }
            const deleted = await runtime.runPromise(
              Effect.gen(function* () {
                const store = yield* IndexStore
                return yield* store.deleteRepo(args.repoId as string)
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

          if (action === "job") {
            if (!args.jobId) {
              throw new McpError(ErrorCode.InvalidParams, "jobId is required for action=job.")
            }
            const result = await runtime.runPromise(
              Effect.gen(function* () {
                const jobs = yield* IndexJobs
                return yield* jobs.getJob(args.jobId as string)
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

          if (!args.path) {
            throw new McpError(ErrorCode.InvalidParams, "path is required for action=index.")
          }

          if (args.async) {
            const job = await runtime.runPromise(
              Effect.gen(function* () {
                const runner = yield* IndexJobRunner
                return yield* runner.start({
                  path: args.path as string,
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
              return yield* indexer.indexRepo(args.path as string, {
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

        case "search_graph": {
          const args = Schema.decodeUnknownSync(SearchGraphInput)(rawArgs ?? {})
          const limit = Math.max(1, Math.min(200, args.limit ?? 20))

          if (!args.semantic && args.namePattern === undefined) {
            if (!args.query) {
              throw new McpError(
                ErrorCode.InvalidParams,
                "Provide query, namePattern, or semantic=true."
              )
            }
            const results = await runtime.runPromise(
              Effect.gen(function* () {
                const query = yield* GraphQuery
                return yield* query.searchSymbols(args.query as string, limit, args.repoId)
              })
            )
            const lines = results.map((symbol) => {
              const doc = docSnippet(symbol.doc)
              return `${symbol.name} (${symbol.kind}) in ${symbol.filePath}:${symbol.startLine}\n  ID: ${symbol.id}\n  In-degree: ${symbol.inDegree ?? 0}\n  ${symbol.signature}${doc ? `\n  doc: ${doc}` : ""}`
            })
            const text =
              lines.length > 0
                ? `Showing ${lines.length} result(s)\n\n${lines.join("\n\n")}`
                : `No symbols matched "${args.query}"`
            return { content: [{ type: "text", text }] }
          }

          const namePattern = args.namePattern ?? args.query ?? ""
          const result = await runtime.runPromise(
            Effect.gen(function* () {
              const query = yield* GraphQuery
              return yield* query.searchGraph({
                namePattern,
                ...(args.regex !== undefined ? { regex: args.regex } : {}),
                ...(args.kind !== undefined ? { kind: args.kind } : {}),
                ...(args.filePattern !== undefined ? { filePattern: args.filePattern } : {}),
                ...(args.repoId !== undefined ? { repoId: args.repoId } : {}),
                ...(args.minDegree !== undefined ? { minDegree: args.minDegree } : {}),
                ...(args.maxDegree !== undefined ? { maxDegree: args.maxDegree } : {}),
                ...(args.limit !== undefined ? { limit } : { limit }),
                ...(args.offset !== undefined ? { offset: args.offset } : {}),
                ...(args.semantic !== undefined ? { semantic: args.semantic } : {})
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
                `${symbol.name} (${symbol.kind}) at ${symbol.filePath}:${symbol.startLine}\n  ID: ${symbol.id}\n  in-degree: ${symbol.inDegree ?? 0}${symbol.score !== undefined ? ` · relevance: ${symbol.score}` : ""}\n  ${symbol.signature}`
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

        case "search_code": {
          const args = Schema.decodeUnknownSync(SearchCodeInput)(rawArgs ?? {})
          const mode = args.mode ?? "compact"
          const text = await runtime.runPromise(
            Effect.gen(function* () {
              const store = yield* IndexStore
              const fs = yield* FileSystem.FileSystem
              const path = yield* Path.Path
              const repoId = yield* getTargetRepoId(args.repoId)
              const repo = yield* store.getRepo(repoId)
              if (!repo) return `Repository not found: ${repoId}`

              const limit = Math.max(1, Math.min(200, args.limit ?? 50))
              const context = Math.max(0, Math.min(20, args.context ?? 0))
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

              if (mode === "files") {
                const matched: string[] = []
                for (const filePath of paths) {
                  if (matched.length >= limit) break
                  const absolutePath = path.isAbsolute(filePath)
                    ? filePath
                    : path.join(repo.rootPath, filePath)
                  const content = yield* fs
                    .readFileString(absolutePath)
                    .pipe(Effect.orElseSucceed(() => undefined))
                  if (content === undefined || content.length > 1_000_000) continue
                  if (content.split("\n").some(matcher)) matched.push(filePath)
                }
                return matched.length > 0
                  ? `files=${matched.length}\n${matched.join("\n")}`
                  : `No matches for "${args.query}" in ${repo.name}.`
              }

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
                  const lineNumber = index + 1
                  matches.push(`${filePath}:${lineNumber}: ${line.trim().slice(0, 240)}`)
                  if (mode === "full" && context > 0) {
                    const start = Math.max(0, index - context)
                    const end = Math.min(lines.length - 1, index + context)
                    for (let cursor = start; cursor <= end; cursor++) {
                      if (cursor === index) continue
                      const marker = cursor < index ? "-" : "+"
                      matches.push(
                        `  ${filePath}:${cursor + 1} ${marker}${(lines[cursor] ?? "").trim().slice(0, 200)}`
                      )
                    }
                  }
                }
              }

              return matches.length > 0
                ? `mode=${mode} matches=${matches.length}\n${matches.join("\n")}`
                : `No matches for "${args.query}" in ${repo.name}.`
            })
          )
          return { content: [{ type: "text", text }] }
        }

        case "get_code_snippet": {
          const args = Schema.decodeUnknownSync(CodeSnippetInput)(rawArgs ?? {})
          if (args.path !== undefined) {
            if (args.startLine === undefined || args.endLine === undefined) {
              throw new McpError(
                ErrorCode.InvalidParams,
                "startLine and endLine are required when path is provided."
              )
            }
            const text = await runtime.runPromise(
              Effect.gen(function* () {
                const fs = yield* FileSystem.FileSystem
                const path = yield* Path.Path
                const store = yield* IndexStore
                const repoId = yield* getTargetRepoId(args.repoId)
                const repo = yield* store.getRepo(repoId)
                if (!repo) return `Repository not found: ${repoId}`

                let resolvedFilePath = args.path as string
                if (!path.isAbsolute(resolvedFilePath)) {
                  resolvedFilePath = path.join(repo.rootPath, resolvedFilePath)
                }
                const exists = yield* fs
                  .exists(resolvedFilePath)
                  .pipe(Effect.orElseSucceed(() => false))
                if (!exists) return `File not found: ${args.path}`

                const content = yield* fs.readFileString(resolvedFilePath)
                const lines = content.split("\n")
                const start = Math.max(1, args.startLine as number)
                const end = Math.min(lines.length, args.endLine as number)
                return lines
                  .slice(start - 1, end)
                  .map((line, index) => `${start + index} | ${line}`)
                  .join("\n")
              })
            )
            return { content: [{ type: "text", text }] }
          }

          if (!args.qualifiedName) {
            throw new McpError(
              ErrorCode.InvalidParams,
              "Provide qualifiedName, or path with startLine and endLine."
            )
          }

          const text = await runtime.runPromise(
            Effect.gen(function* () {
              const query = yield* GraphQuery
              const store = yield* IndexStore
              const fs = yield* FileSystem.FileSystem
              const path = yield* Path.Path
              const repoId = yield* getTargetRepoId(args.repoId)

              const symbol = yield* query.getSymbolByQualifiedName(
                args.qualifiedName as string,
                repoId
              )
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
                `${symbol.kind} ${symbol.name} - ${symbol.filePath}:${symbol.startLine}-${symbol.endLine}`,
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

        case "trace_path": {
          const args = Schema.decodeUnknownSync(TracePathInput)(rawArgs ?? {})
          const mode = args.mode ?? "calls"

          if (mode === "cross_repo") {
            const text = await runtime.runPromise(
              Effect.gen(function* () {
                const crossRepo = yield* CrossRepo
                if (args.refresh) yield* crossRepo.link()
                const links = yield* crossRepo.list(args.repoId)
                if (links.length === 0) return "No cross-repo links."
                const body = links
                  .map(
                    (link) =>
                      `${link.kind} ${link.source.name}: ${link.source.repoName} ${link.source.filePath} -> ${link.target.repoName} ${link.target.filePath} (${link.confidence})`
                  )
                  .join("\n")
                return `${links.length} cross-repo link(s)\n\n${body}`
              })
            )
            return { content: [{ type: "text", text }] }
          }

          if (!args.selector) {
            throw new McpError(ErrorCode.InvalidParams, `selector is required for mode=${mode}.`)
          }

          if (mode === "references" || mode === "neighborhood") {
            const result = await runtime.runPromise(
              Effect.gen(function* () {
                const query = yield* GraphQuery
                const repoId = yield* getTargetRepoId(args.repoId)
                let symbolId = args.selector as string
                if (!symbolId.includes("#")) {
                  const symbol = yield* query.getSymbolByQualifiedName(symbolId, repoId)
                  if (!symbol) return { kind: "missing" as const }
                  symbolId = symbol.id
                }

                if (mode === "references") {
                  const references = yield* query.findReferences(symbolId)
                  return { kind: "references" as const, references }
                }
                const graph = yield* query.neighborhood(symbolId, args.depth ?? 1)
                return { kind: "neighborhood" as const, graph }
              })
            )

            if (result.kind === "missing") {
              return {
                content: [{ type: "text", text: `No symbol matched selector "${args.selector}".` }]
              }
            }

            if (result.kind === "references") {
              const lines = result.references.map(
                (reference) =>
                  `[${reference.kind}] from ${reference.sourceSymbol.name} (${reference.sourceSymbol.kind}) at ${reference.sourceSymbol.filePath}:${reference.sourceSymbol.startLine}`
              )
              return {
                content: [
                  {
                    type: "text",
                    text:
                      lines.length > 0
                        ? lines.join("\n")
                        : `No incoming references found for ${args.selector}`
                  }
                ]
              }
            }

            const nodesText = result.graph.nodes
              .map((node) => `- ${node.name} [${node.kind}] (${node.filePath}:${node.startLine})`)
              .join("\n")
            const edgesText = result.graph.edges
              .map((edge) => `  ${edge.srcSymbolId} --[${edge.kind}]--> ${edge.dstSymbolId}`)
              .join("\n")
            const output = `Nodes (${result.graph.nodes.length}):\n${nodesText}\n\nEdges (${result.graph.edges.length}):\n${edgesText}`
            return { content: [{ type: "text", text: output }] }
          }

          const result = await runtime.runPromise(
            Effect.gen(function* () {
              const query = yield* GraphQuery
              return yield* query.tracePath(args.selector as string, {
                ...(args.direction !== undefined ? { direction: args.direction } : {}),
                ...(args.depth !== undefined ? { depth: args.depth } : {}),
                ...(mode !== undefined ? { mode } : {})
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
          const view = args.view ?? "summary"
          const text = await runtime.runPromise(
            Effect.gen(function* () {
              const query = yield* GraphQuery
              const store = yield* IndexStore
              const repoId = yield* getTargetRepoId(args.repoId)

              if (view === "map") {
                return yield* query.repoMap(repoId, args.maxTokens ?? 2000)
              }

              if (view === "outline") {
                if (!args.path) {
                  return yield* Effect.fail(
                    new McpError(ErrorCode.InvalidParams, "path is required for view=outline.")
                  )
                }
                const symbols = yield* query.outlineFile(repoId, args.path)
                const lines = symbols.map((symbol) => {
                  const doc = docSnippet(symbol.doc)
                  return `L${symbol.startLine}-${symbol.endLine} [${symbol.kind}] ${symbol.signature}${doc ? `\n  doc: ${doc}` : ""}`
                })
                return lines.length > 0 ? lines.join("\n") : `No symbols found in ${args.path}`
              }

              if (view === "schema") {
                const repo = yield* store.getRepo(repoId)
                const stats = yield* store.getStats(repoId)
                return [
                  "Node labels: Repository, File, Symbol (function, class, interface, type, enum, method, property, const), Package",
                  "Edge kinds: import, imports (file-level), defines, contains, call, call_reference, usage, reference, extends, implements, throws, raises",
                  "Symbol properties: id, name, qualifiedName, kind, language, visibility, containerName, startLine, endLine, signature, doc, exported, inDegree",
                  "File edge table: srcFileId -> dstFileId (imports), with unresolved specifiers retained",
                  `Repository: ${repo?.name ?? repoId} files=${stats.files} symbols=${stats.symbols} edges=${stats.edges}`
                ].join("\n")
              }

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

        case "analyze_graph": {
          const args = Schema.decodeUnknownSync(AnalyzeGraphInput)(rawArgs ?? {})

          if (args.analysis === "changes") {
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

          if (args.analysis === "snapshots") {
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

              if (args.analysis === "duplicates") {
                const pairs = yield* analytics.duplicates(repoId, {
                  ...(args.threshold !== undefined ? { threshold: args.threshold } : {}),
                  ...(args.limit !== undefined ? { limit: args.limit } : {})
                })
                if (pairs.length === 0) return `${header}\nNo near-duplicates found.`
                const body = pairs
                  .map(
                    (pair) =>
                      `${pair.similarity} ${pair.left.name} (${pair.left.filePath}:${pair.left.startLine}) ~ ${pair.right.name} (${pair.right.filePath}:${pair.right.startLine})`
                  )
                  .join("\n")
                return `${header}\n${pairs.length} pair(s)\n\n${body}`
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
    | CrossRepo
    | Freshness
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
