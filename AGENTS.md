You are building "codegraph": a local code indexer for very large TypeScript/JavaScript codebases,
written in TypeScript using Effect-TS (effect v3.x, @effect/platform, @effect/platform-node,
@effect/sql, @effect/sql-sqlite-node, @effect/cli). It must (1) index repos into a symbol/reference
graph, (2) serve a basic HTML graph visualization, and (3) expose the index to AI agents as an MCP server.

## Goals
- Index multiple large repos incrementally (only changed files are re-processed).
- Build a graph: files, symbols (function/class/interface/type/const), and edges
  (imports, calls/references, extends/implements, contains).
- Visualize the graph in a single static HTML page (no build step for the frontend).
- Let agents query the index through MCP tools.

## Architecture (Effect idioms are required)
- Every capability is a service defined with `Effect.Service` (or `Context.Tag` + `Layer`):
  `FileWalker`, `Parser`, `IndexStore`, `Indexer`, `GraphQuery`, `HttpApi`, `McpServer`.
- Wire everything with `Layer`s; no global singletons, no module-level mutable state.
- Typed errors using `Data.TaggedError` (e.g. ParseError, StoreError, NotFound). No thrown exceptions.
- Use `@effect/platform` `FileSystem` and `Path` instead of node:fs directly.
- Use `Schema` for all data models and for validating HTTP/MCP inputs and outputs.
- Use `Stream` + `Effect.forEach(..., { concurrency })` for parallel file processing with bounded
  concurrency, and `Config` for settings (db path, concurrency, ignore globs, port).
- Use `Effect.log*` with spans (`Effect.withSpan`) around indexing phases.
- Resource safety through `Scope` / `Layer.scoped` (DB connections, watchers).

## Indexing pipeline
1. FileWalker: walk repo root, respect .gitignore plus extra ignore globs, only ts/tsx/js/jsx.
2. Hashing: store sha256 of each file; skip unchanged files on re-index.
3. Parser: use ts-morph (or TypeScript Compiler API) to extract symbols with
   name, kind, file, start/end line, signature, exported flag, and edges
   (import, call/reference, extends, implements).
   Wrap the parser behind a `Parser` service interface so tree-sitter can replace it later.
4. IndexStore: SQLite via @effect/sql-sqlite-node with migrations.
   Tables: repos, files(path, hash, repo_id), symbols(id, name, kind, file_id, start_line,
   end_line, signature, exported), edges(src_symbol_id, dst_symbol_id, kind), plus an FTS5 table on
   symbol names/signatures. Writes in batched transactions.
5. Incremental: delete and re-insert rows only for changed/removed files.
6. Optional watch mode that re-indexes on file change (debounced, via Stream).

## Graph query layer (GraphQuery service)
- searchSymbols(query, limit)  // FTS5
- getSymbol(id) with its edges
- findReferences(symbolId)
- outlineFile(path)
- neighborhood(symbolId, depth)  // subgraph for visualization
- repoMap(repoId, maxTokens)  // compact per-file list of exported signatures, ranked by
  in-degree (PageRank-lite)
- fileGraph(repoId)  // file-level import graph

## HTTP API + visualization
- @effect/platform HttpApi (or HttpRouter) served via @effect/platform-node:
  GET /api/repos, GET /api/graph?repo=&level=file|symbol&focus=&depth=,
  GET /api/search?q=, GET /api/symbol/:id
- Serve one static `index.html` (no bundler) that loads Cytoscape.js (or d3-force) from a CDN and:
  - shows the file-level graph by default, symbol-level graph on node click (expand neighborhood),
  - color-codes nodes by kind and edges by type, node size by in-degree,
  - has a search box, a repo selector, a depth slider, and a side panel with symbol
    details (signature, file:line, callers/callees),
  - supports dark mode and handles 5k+ nodes (hide labels when zoomed out, limit by default).

## MCP server (for agents)
- Use @modelcontextprotocol/sdk over stdio. Tools backed by the same Effect services:
  repo_map, outline_file, search_symbol, find_references, neighborhood, read_file_range.
- Tool inputs validated with Schema; outputs compact (token-efficient), with file:line references.
- Bridge Effect and the MCP handlers with a `ManagedRuntime`.

## CLI (@effect/cli)
- `codegraph index <path> [--watch]`
- `codegraph serve [--port 4310]`
- `codegraph mcp`
- `codegraph stats`

## Deliverables
- Project structure: src/{services,domain,db,http,mcp,cli}, web/index.html, tests.
- Tests with @effect/vitest: parser extraction, incremental re-index, query layer
  (use in-memory SQLite and test Layers).
- README with usage and an example MCP config for Claude Code / VS Code.
- Work in phases: (1) walker+parser+store, (2) query layer+CLI, (3) HTTP+HTML graph,
  (4) MCP server, (5) watch mode. Make each phase runnable and committed before the next.
  Ask before adding any dependency not listed above.