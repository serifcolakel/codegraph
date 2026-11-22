---

name: codegraph
description: Local code intelligence for large repositories. Use when exploring unfamiliar code, finding symbols/callers/callees, tracing impact, reviewing architecture, dead code, cycles, routes, docs or git changes. Prefer the codegraph MCP tools over grep when a repository index exists.
---

# CodeGraph

CodeGraph indexes a repository into a local SQLite symbol/reference graph and
exposes it through MCP, an HTTP API, a CLI and a static graph UI. Everything is
local; no API key or hosted service.

## First: make sure the index is fresh

Prefer the MCP tools:

1. `index_status` — coverage, unresolved edges and freshness (`stale=true` means
   disk has added/modified/deleted files).
2. `index_repository` — incremental index of a path. Use `async=true` for large
   repositories and poll `index_job_status`.
3. `list_projects` — discover already indexed repositories.

CLI equivalents:

```bash
codegraph index .                 # incremental
codegraph index . --watch         # background, debounced
codegraph freshness <repoId>      # stale/added/modified/deleted
codegraph coverage <repoId>       # parsed/partial/unsupported + unresolved edges
```

Automate indexing with `scripts/codegraph-auto-index.mjs` (see
`integrations/README.md`).

## Tool selection order

1. `search_graph` — find symbols by name/regex, kind, file and degree.
2. `get_code_snippet` — read the exact source for a qualified name.
3. `trace_path` — callers/callees, references, data flow, cross-file.
4. `find_references` / `neighborhood` — immediate usage and graph context.
5. `search_code` — literal/regex text inside indexed files.
6. `query_graph` — safe read-only Cypher subset for custom questions.
7. `analyze_graph` — pagerank/in_degree/complexity, hotspots, dead code,
   cycles, communities, package rankings.
8. `get_architecture`, `detect_changes`, `compare_snapshots`,
   `cross_repo_links`.

Use `repo_map`/`outline_file` for orientation; use `read_file_range` only after
a symbol lookup.

## Query examples

```cypher
MATCH (s:Symbol)
WHERE s.kind = "function" AND s.name CONTAINS "Fund"
RETURN s.name AS name, s.filePath AS file, s.startLine AS line
ORDER BY s.name LIMIT 20
```

```cypher
MATCH (a:Symbol)-[e:CALLS]->(b:Symbol)
WHERE a.name = "handler"
RETURN a.name AS caller, b.name AS callee LIMIT 50
```

## Rules

- Always cite `file:line` from tool output.
- Start with the smallest tool; do not dump whole files or the whole graph.
- Treat unresolved edges as unknowns; do not invent links.
- Re-index after large edits; incremental indexing skips unchanged hashes.
- Exclude `node_modules`, `dist`, build output and `.gitignore`d files (default).
- For docs/ADR work, remember Markdown headings are `doc`/`decision` nodes and
  inline code spans become `mentions` edges.
- Routes, channels, configs and OpenAPI/GraphQL entities are searchable like
  symbols.
