import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError
} from "@modelcontextprotocol/sdk/types.js"
import { Schema, ManagedRuntime, Effect } from "effect"
import { FileSystem, Path } from "@effect/platform"
import { IndexStore } from "../services/IndexStore.js"
import { GraphQuery } from "../services/GraphQuery.js"

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

export const createMcpServer = <R>(runtime: ManagedRuntime.ManagedRuntime<IndexStore | GraphQuery | FileSystem.FileSystem | Path.Path | R, any>) => {
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
          description: "Generates a compact, ranked overview of exported signatures across files in the codebase.",
          inputSchema: {
            type: "object",
            properties: {
              repoId: { type: "string", description: "Optional repo ID (defaults to first indexed repo)" },
              maxTokens: { type: "number", description: "Estimated token limit for the map (default 2000)" }
            }
          }
        },
        {
          name: "outline_file",
          description: "Lists all symbols (functions, classes, interfaces, types) defined in a file in order.",
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
          description: "Performs full-text search (FTS5) for symbols by name or signature with in-degree rankings.",
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
          description: "Finds all incoming calls, references, and usages of a symbol across the indexed repository.",
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
          description: "Retrieves the subgraph (callers, callees, extensions) around a symbol up to a given depth.",
          inputSchema: {
            type: "object",
            properties: {
              symbolId: { type: "string", description: "Center symbol ID" },
              depth: { type: "number", description: "Search depth (default 1, max 4)" }
            },
            required: ["symbolId"]
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
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: rawArgs } = request.params

    const getTargetRepoId = (inputRepoId?: string) =>
      Effect.gen(function* () {
        if (inputRepoId) return inputRepoId
        const store = yield* IndexStore
        const repos = yield* store.listRepos()
        if (repos.length === 0) {
          return yield* Effect.fail(new McpError(ErrorCode.InvalidRequest, "No repositories have been indexed yet."))
        }
        return repos[0]!.id
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
          const lines = symbols.map(
            s => `L${s.startLine}-${s.endLine} [${s.kind}] ${s.signature}`
          )
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
          const lines = results.map(
            s => `${s.name} (${s.kind}) in ${s.filePath}:${s.startLine}\n  ID: ${s.id}\n  In-degree: ${s.inDegree ?? 0}\n  ${s.signature}`
          )
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
            r => `[${r.kind}] from ${r.sourceSymbol.name} (${r.sourceSymbol.kind}) at ${r.sourceSymbol.filePath}:${r.sourceSymbol.startLine}`
          )
          return {
            content: [
              {
                type: "text",
                text: lines.length > 0 ? lines.join("\n") : `No incoming references found for ${args.symbolId}`
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
            .map(n => `- ${n.name} [${n.kind}] (${n.filePath}:${n.startLine})`)
            .join("\n")
          const edgesText = graph.edges
            .map(e => `  ${e.srcSymbolId} --[${e.kind}]--> ${e.dstSymbolId}`)
            .join("\n")
          const output = `Nodes (${graph.nodes.length}):\n${nodesText}\n\nEdges (${graph.edges.length}):\n${edgesText}`
          return { content: [{ type: "text", text: output }] }
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

              const exists = yield* fs.exists(resolvedFilePath).pipe(Effect.orElseSucceed(() => false))
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
    } catch (err: any) {
      if (err instanceof McpError) throw err
      return {
        content: [{ type: "text", text: `Error executing tool ${name}: ${err?.message ?? String(err)}` }],
        isError: true
      }
    }
  })

  return server
}

export const startMcpServer = <R>(
  runtime: ManagedRuntime.ManagedRuntime<IndexStore | GraphQuery | FileSystem.FileSystem | Path.Path | R, any>
) => {
  const server = createMcpServer(runtime)
  const transport = new StdioServerTransport()
  return server.connect(transport)
}
