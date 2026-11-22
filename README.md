# codegraph

Local code indexer and graph explorer for large TypeScript/JavaScript codebases.
It indexes a repository into a symbol/reference graph stored in SQLite, serves a
single-page graph visualization, and exposes the index to AI agents through an
MCP server.

## Features

- Incremental indexing: files are hashed and only changed files are re-parsed.
- Multi-language parsing: tree-sitter ASTs for Python, Go, Rust, Java, Kotlin
  and C#, `ts-morph` for TypeScript/JavaScript, and a regex fallback for Swift,
  C/C++, Ruby, PHP and Scala.
- Symbol graph: files, symbols (functions, classes, interfaces, types, enums,
  methods, properties, consts) with language, qualified name and visibility,
  plus import, call, call_reference, usage, reference, extends, implements,
  contains, throws and raises edges. File-level imports are stored separately so
  type-only imports stay visible.
- Markdown documentation: headings become `doc` symbols and inline code spans
  resolve to `mentions` edges pointing at code.
- Route nodes for Next.js app/pages routes, Express-style declarations and
  FastAPI decorators, linked to their handler symbols.
- ADR headings indexed as `decision` nodes; Dockerfile stages, Compose services,
  Kubernetes resources and Helm charts indexed as `config` nodes.
- Parse coverage and unresolved-edge diagnostics (`coverage` CLI command and
  the `index_status` MCP tool).
- Graph analytics: PageRank/in-degree/complexity ranking, package rankings,
  hotspots, communities, dead-code candidates, symbol/file/package cycle
  detection (`analyze_graph`) and index snapshot comparison.
- Complexity metrics: cyclomatic, cognitive, loop depth/count, scan/allocation
  inside loops, recursion and parameter count for TS/JS and tree-sitter
  languages.
- Documentation indexing: JSDoc, `///` / `/** */` block docs and Python
  docstrings are stored with symbols and included in full-text search.
- Module-aware cross-file edge resolution using relative paths and workspace
  manifests (`package.json`, `go.mod`, `Cargo.toml`, `pyproject.toml`) with
  ambiguity protection and explicit unresolved edges.
- FTS5 symbol search plus a ranked repository map.
- Static HTML/Cytoscape.js visualization (no frontend build step) with a soft,
  graph-overlaid left icon dock (tooltips), compact repo/search/depth overlay,
  dark and light themes, deep links, callers/callees, type filters and history.
- Repository metadata stat cards in the UI: last index time, index duration,
  source size, file/symbol/edge counts. An **Index details** dialog shows
  languages, parse coverage, import resolution and recent indexing jobs. An
  **Insights** dialog surfaces architecture, hotspots, complexity, communities,
  packages, dead code, cycles, change impact and snapshot deltas, with
  click-through to the graph.
- HTTP JSON API and an MCP stdio server.
- Optional watch mode that re-indexes on change (debounced).

## Requirements

- Node.js 20+ and npm. Run the CLI with Node; Bun is not supported because the
  SQLite driver (`better-sqlite3`) is a native Node module.
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

# Show parse coverage and unresolved edges (all repos or one)
npm run codegraph -- coverage
npm run codegraph -- coverage <repoId>

# Map git changes to affected symbols and their blast radius
npm run codegraph -- changes <repoId> --base main

# Serve the HTTP API and graph UI (default port 4310)
npm run codegraph -- serve --port 4310

# Run the MCP server over stdio
npm run codegraph -- mcp
```

Rebuild after source changes, then run the compiled entry point:

```bash
npm run build
node dist/cli/index.js index ./some-repo
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

| Endpoint                                        | Description                                 |
| ----------------------------------------------- | ------------------------------------------- |
| `GET /api/repos`                                | Repos with index time, size and counts      |
| `GET /api/coverage?repo=`                       | Parse coverage and import diagnostics       |
| `GET /api/architecture?repo=`                   | Languages, packages, entry points, hotspots |
| `GET /api/analytics?repo=&analysis=`            | Ranking, hotspots, communities, dead code   |
| `GET /api/changes?repo=&base=`                  | Git change impact and blast radius          |
| `GET /api/snapshots?repo=&limit=`               | Recent index snapshots                      |
| `GET /api/snapshots/compare?repo=&from=&to=`    | Delta between two index runs                |
| `GET /api/graph?repo=&level=file`               | File-level import/call graph                |
| `GET /api/graph?repo=&level=symbol`             | Ranked symbol graph (seed view)             |
| `GET /api/graph?repo=&focus=<symbolId>&depth=1` | Symbol neighborhood                         |
| `GET /api/search?q=&repo=`                      | FTS symbol search                           |
| `GET /api/symbol/:id`                           | Symbol details, callers and callees         |
| `POST /api/index`                               | Index a folder (`{ path, name?, force? }`)  |
| `POST /api/reindex`                             | Refresh a repo (`{ repoId, force? }`)       |
| `GET /`                                         | Single-page graph UI                        |

The web UI has **Index a repository** and **Re-index current repository** actions,
so a new folder can be indexed without restarting the server. The index request
runs against the same `CODEGRAPH_DB_PATH` as the server.

## MCP server

The MCP server exposes these tools: `repo_map`, `outline_file`, `search_symbol`,
`search_graph`, `get_architecture`, `trace_path`, `detect_changes`, `index_repository`,
`index_job_status`, `delete_project`, `list_projects`, `find_references`, `neighborhood`,
`index_status`, `get_graph_schema`, `get_code_snippet`, `search_code`, `query_graph`,
`analyze_graph`, `compare_snapshots`, and `read_file_range`.

`query_graph` accepts a safe, read-only Cypher subset:

```cypher
MATCH (s:Symbol)
WHERE s.kind = "function" AND s.name CONTAINS "Fund"
RETURN s.name AS name, s.filePath AS file, s.startLine AS line
ORDER BY s.name
LIMIT 20
```

```cypher
MATCH (a:Symbol)-[e:CALLS]->(b:Symbol)
WHERE a.name = "handler"
RETURN a.name AS caller, b.name AS callee
LIMIT 50
```

Symbol properties include `cyclomatic`, `cognitive`, `loopDepth`, `loopCount`,
`linearScanInLoop`, `allocInLoop`, `recursive` and `paramCount`.

Supported node labels are `Symbol`, `File` and `Repository`; relationship
patterns support Symbol-to-Symbol edges (`CALLS`, `CALL_REFERENCE`, `USAGE`,
`REFERENCES`, `EXTENDS`, `IMPLEMENTS`, `CONTAINS`, `THROWS`, `RAISES`). Writes
(`CREATE`, `SET`, `DELETE`, `MERGE`, `CALL`) are rejected. Inputs are validated
with Effect `Schema`, and results are compact text with `file:line` references.

### 1. Index the repository

The MCP server reads a SQLite file, so index once with the same
`CODEGRAPH_DB_PATH` you will give the client:

```bash
CODEGRAPH_DB_PATH="$HOME/.codegraph/my-repo.sqlite" \
  node /absolute/path/to/codegraph/dist/cli/index.js index /path/to/my-repo --force
```

### 2. Register the server

#### Claude Code / Claude Desktop

```json
{
  "mcpServers": {
    "codegraph-my-repo": {
      "command": "node",
      "args": ["/absolute/path/to/codegraph/dist/cli/index.js", "mcp"],
      "env": {
        "CODEGRAPH_DB_PATH": "/Users/you/.codegraph/my-repo.sqlite"
      }
    }
  }
}
```

#### Claude Code CLI

```bash
claude mcp add codegraph-my-repo \
  --env CODEGRAPH_DB_PATH=/Users/you/.codegraph/my-repo.sqlite \
  -- node /absolute/path/to/codegraph/dist/cli/index.js mcp
```

#### VS Code (`.vscode/mcp.json`)

```json
{
  "servers": {
    "codegraph-my-repo": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/codegraph/dist/cli/index.js", "mcp"],
      "env": {
        "CODEGRAPH_DB_PATH": "/Users/you/.codegraph/my-repo.sqlite"
      }
    }
  }
}
```

#### opencode (`opencode.json` or `opencode.jsonc`)

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "codegraph-my-repo": {
        "type": "local",
        "command": ["node", "/absolute/path/to/codegraph/dist/cli/index.js", "mcp"],
        "environment": {
          "CODEGRAPH_DB_PATH": "/Users/you/.codegraph/my-repo.sqlite"
        }
      }
    }
  }
}
```

Or let opencode write it:

```bash
opencode mcp add codegraph-my-repo \
  --env CODEGRAPH_DB_PATH=/Users/you/.codegraph/my-repo.sqlite \
  -- node /absolute/path/to/codegraph/dist/cli/index.js mcp
```

Use one server entry per database if you index several repositories (for example
`codegraph-my-repo` and `codegraph-self`). The CLI resolves `web/index.html`
relative to its own package, so neither `serve` nor `mcp` depends on the
current working directory.

## Project layout

```
src/
  cli/        @effect/cli commands
  db/         SQLite schema and FTS5 setup
  domain/     Schema models, typed errors, configuration
  http/       HTTP API and static UI serving
  mcp/        MCP tool definitions and handlers
  parsers/    tree-sitter and ts-morph language parsers
  services/   FileWalker, Parser, IndexStore, Indexer, GraphQuery, Diagnostics
web/          Single-page Cytoscape.js visualization
tests/        @effect/vitest service and integration tests
e2e/          Playwright E2E tests and fixture repository
playwright.config.ts
```

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run test:watch  # vitest watch mode
npm run test:e2e    # Playwright E2E (builds, indexes e2e fixture, serves :4321)
```

The first E2E run needs a browser: `npx playwright install chromium`. E2E
artifacts (traces, screenshots, HTML report) are written to `test-results/` and
`playwright-report/`. UI controls used by the tests expose stable `data-testid`
attributes.

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
