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
import { Diagnostics, formatStatus } from "../services/Diagnostics.js"
import { GraphQuery } from "../services/GraphQuery.js"
import { IndexStore } from "../services/IndexStore.js"

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
    IndexStore | GraphQuery | Diagnostics | FileSystem.FileSystem | Path.Path | R,
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
    IndexStore | GraphQuery | Diagnostics | FileSystem.FileSystem | Path.Path | R,
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
