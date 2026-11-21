# codegraph

Local code indexer and graph explorer for large TypeScript/JavaScript codebases.
It indexes a repository into a symbol/reference graph stored in SQLite, serves a
single-page graph visualization, and exposes the index to AI agents through an
MCP server.

## Features

- Incremental indexing: files are hashed and only changed files are re-parsed.
- Symbol graph: files, symbols (functions, classes, interfaces, types, enums,
  methods, properties, consts) and edges (import, call, reference, extends,
  implements, contains).
- Module-aware cross-file edge resolution with ambiguity protection.
- FTS5 symbol search plus a ranked repository map.
- Static HTML/Cytoscape.js visualization (no frontend build step).
- HTTP JSON API and an MCP stdio server.
- Optional watch mode that re-indexes on change (debounced).

## Requirements

- Node.js 20+ (or Bun) and npm.
- No external services; everything runs locally.

## Install and build

```bash
npm install
npm run build
```

## CLI

```bash
# Index a repository (incremental)
npm run codegraph -- index /path/to/repo

# Force a full re-index even when file hashes are unchanged
npm run codegraph -- index /path/to/repo --force

# Index and watch for changes
npm run codegraph -- index /path/to/repo --watch

# Show global or per-repo statistics
npm run codegraph -- stats

# Serve the HTTP API and graph UI (default port 4310)
npm run codegraph -- serve --port 4310

# Run the MCP server over stdio
npm run codegraph -- mcp
```

During development you can run the TypeScript entry point directly:

```bash
bun run src/cli/index.ts index ./some-repo
```

## Configuration

All settings are read from environment variables:

| Variable                 | Default             | Description                  |
| ------------------------ | ------------------- | ---------------------------- |
| `CODEGRAPH_DB_PATH`      | `.codegraph.sqlite` | SQLite database path         |
| `CODEGRAPH_CONCURRENCY`  | `4`                 | Parallel file parsing limit  |
| `CODEGRAPH_IGNORE_GLOBS` | common build dirs   | Comma-separated ignore globs |
| `CODEGRAPH_PORT`         | `4310`              | HTTP server port             |

`.gitignore` files in the indexed repository are respected, in addition to the
configured ignore globs.

## HTTP API

| Endpoint                                        | Description                         |
| ----------------------------------------------- | ----------------------------------- |
| `GET /api/repos`                                | Indexed repositories                |
| `GET /api/graph?repo=&level=file`               | File-level import/call graph        |
| `GET /api/graph?repo=&level=symbol`             | Ranked symbol graph (seed view)     |
| `GET /api/graph?repo=&focus=<symbolId>&depth=1` | Symbol neighborhood                 |
| `GET /api/search?q=&repo=`                      | FTS symbol search                   |
| `GET /api/symbol/:id`                           | Symbol details, callers and callees |
| `GET /`                                         | Single-page graph UI                |

## MCP server

The MCP server exposes these tools: `repo_map`, `outline_file`, `search_symbol`,
`find_references`, `neighborhood`, and `read_file_range`. Inputs are validated
with Effect `Schema`, and results are compact text with `file:line` references.

### Claude Code / Claude Desktop

```json
{
  "mcpServers": {
    "codegraph": {
      "command": "node",
      "args": ["/absolute/path/to/codegraph/dist/cli/index.js", "mcp"],
      "env": {
        "CODEGRAPH_DB_PATH": "/absolute/path/to/.codegraph.sqlite"
      }
    }
  }
}
```

### VS Code (`.vscode/mcp.json`)

```json
{
  "servers": {
    "codegraph": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/codegraph/dist/cli/index.js", "mcp"],
      "env": {
        "CODEGRAPH_DB_PATH": "/absolute/path/to/.codegraph.sqlite"
      }
    }
  }
}
```

Index the repository once with the same `CODEGRAPH_DB_PATH` before starting the
MCP server.

## Project layout

```
src/
  cli/        @effect/cli commands
  db/         SQLite schema and FTS5 setup
  domain/     Schema models, typed errors, configuration
  http/       HTTP API and static UI serving
  mcp/        MCP tool definitions and handlers
  services/   FileWalker, Parser, IndexStore, Indexer, GraphQuery
web/          Single-page Cytoscape.js visualization
tests/        @effect/vitest service and integration tests
```

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run test:watch  # vitest watch mode
```

## Design notes

- Every capability is an Effect service wired through `Layer`s; there is no
  module-level mutable state.
- Errors are typed with `Data.TaggedError` (`WalkError`, `ParseError`,
  `StoreError`, `NotFoundError`, `GraphError`).
- File processing uses bounded concurrency via `Effect.forEach`.
- Cross-file edges are resolved by module path when the import specifier is
  relative; otherwise by a unique symbol name, preferring a sole exported
  candidate. Ambiguous names are left unresolved instead of creating wrong
  edges.
