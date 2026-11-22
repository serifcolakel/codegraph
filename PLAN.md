# codegraph — Implementation Plan

Local-first code intelligence for large repositories. codegraph indexes source code into a
symbol/reference graph, serves a static graph UI, and exposes the index to AI agents over MCP.

## Vision

- Make a very large repository understandable without reading it file by file.
- Keep everything local: SQLite, no hosted service, no API key.
- Give agents compact, high-signal answers with `file:line` evidence.
- Prefer correctness and useful context over raw language-count.

## Current State

Implemented and verified:

- Effect-TS service architecture with `Layer` wiring and typed `Data.TaggedError` errors.
- Incremental indexing: SHA-256 per file, unchanged files skipped, changed/removed files replaced.
- SQLite storage with schema migrations, FTS5 symbol search, batched transactions.
- TypeScript/JavaScript parsing via `ts-morph`, including JSDoc descriptions and tags
  (`@param`, `@returns`, `@throws`).
- Tree-sitter AST parsing for Python, Go, Rust, Java, Kotlin and C#.
- Heuristic parsing for Swift, C/C++, Ruby, PHP and Scala.
- Documentation indexing for JSDoc, `///` / `/** */` comments, Python docstrings
  and throws/raises tags.
- Symbol v2 fields (`language`, `qualifiedName`, `visibility`, `containerName`)
  and FTS camelCase/snake_case tokenization.
- Manifest-based package resolution for `package.json`, `go.mod`, `Cargo.toml`
  and `pyproject.toml`.
- Parse coverage and unresolved-edge diagnostics (`coverage` CLI command,
  `index_status` MCP tool).
- Analytics service: PageRank/in-degree/complexity, package rankings,
  communities, hotspots, dead-code candidates, symbol/file/package cycle
  detection and snapshot comparison.
- Complexity metrics computed for TS/JS and tree-sitter languages and stored on
  symbols.
- Markdown headings indexed as `doc` symbols with resolved `mentions` edges.
- Route nodes for Next.js, Express and FastAPI linked to handler symbols.
- File walker with `.gitignore`, ignore globs, vendor/build-directory exclusions.
- Graph queries: search, symbol details, references, outline, neighborhood, repo map, file graph.
- HTTP API with indexing actions:
  - `POST /api/index`, `POST /api/reindex`.
  - Search, graph, symbol, repo endpoints.
- Static HTML UI:
  - Dark/light themes, folder-grouped file graph, type filters, back/forward view history.
  - Search with keyboard navigation, symbol panel with docs, callers and callees.
  - Soft left icon dock overlaid on the graph for actions and view toggles;
    compact repo/search/depth overlay.
  - Metadata stat cards with last index time, duration, source size and repo counts.
  - Index details dialog with languages, coverage, imports and recent jobs.
  - Insights dialog with architecture, hotspots, complexity, dead code, cycles
    and git change impact; rows jump to the graph.
  - Depth control (1–8 hops, 500-node neighborhood limit), deep links (`#symbol=<id>`).
  - Index and re-index actions from the UI.
- MCP server with 21 tools: `repo_map`, `outline_file`, `search_symbol`, `search_graph`,
  `query_graph`, `analyze_graph`, `compare_snapshots`, `get_architecture`, `trace_path`,
  `detect_changes`, `index_repository`, `index_job_status`, `delete_project`,
  `list_projects`, `find_references`, `neighborhood`, `index_status`, `get_graph_schema`,
  `get_code_snippet`, `search_code`, `read_file_range`.
- CLI: `index [--watch] [--force]`, `serve`, `stats`, `mcp`.
- Tests: parser, generic languages, incremental indexing, query layer, HTTP, MCP.

## Architecture Rules

- Every capability is an Effect service (`Effect.Service` or `Context.Tag` + `Layer`).
- No module-level mutable state and no global singletons.
- Typed errors only; no thrown exceptions across service boundaries.
- Use `@effect/platform` `FileSystem` and `Path`; avoid direct `node:fs`.
- Use `Schema` for models and all HTTP/MCP input/output boundaries.
- Use `Stream` and bounded `Effect.forEach` for parallel file processing.
- Use `Effect.log*` with spans around indexing and query phases.
- Resource safety through `Scope` / `Layer.scoped`.
- Keep HTTP and MCP on the same storage/query services.
- Preserve atomic incremental indexing: FTS and graph edges stay consistent with files.
- Ask before adding a dependency that is not already approved.

## Roadmap

### Phase 1 — Multi-language AST and graph model v2 (P0)

Replace heuristic-only parsing with real syntax trees for the primary languages.

- [x] Add a parser abstraction with per-language modules and shared output types.
- [x] Add tree-sitter-based parsing for Python, Go, Rust, C#, Java and Kotlin.
- [x] Keep `ts-morph` for TypeScript/JS type-aware details.
- [x] Keep a regex fallback for languages without an AST parser.
- [x] Extract `throws` / `raises` from JSDoc tags, C# `<exception>` and language syntax.
- [x] Add `language`, `qualifiedName`, `visibility` and `containerName` to symbol records.
- [x] Emit `THROWS`, `RAISES`, `CALL_REFERENCE`, `USAGE` and file-level
      `IMPORTS` edges. `DEFINES` is represented by `symbols.file_id`.
- [x] Resolve package/module specifiers from `package.json`, `go.mod`,
      `Cargo.toml` and `pyproject.toml`; `pom.xml` and `build.gradle` remain.
- [x] Add camelCase / snake_case tokenization to FTS so `useFundSizes` matches `fund` and `sizes`.
- [x] Add parse coverage reporting: parsed, partial, skipped and unsupported files.

Definition of done: primary languages produce AST-backed symbols; unresolved edges are explicit;
tests cover one representative construct per language.

### Phase 2 — Agent tool surface (P0)

Make the MCP server useful for real repository investigations.

- [x] `index_repository` (index a path into the current database).
- [x] `list_projects` and `delete_project`.
- [x] `index_status` and coverage diagnostics.
- [x] `search_graph` with name regex, kind filters, file scope, degree filters and paging.
- [x] `get_graph_schema` describing node labels, edge kinds and properties.
- [x] `get_file_outline` (exposed as `outline_file`).
- [x] `get_code_snippet` by qualified name.
- [x] `trace_path` with calls, references, data flow (call/usage/reference) and cross-file modes.
- [x] `get_architecture` summary: languages, packages, entry points and hotspots; routes and clusters remain.
- [x] `detect_changes` from git diff to affected symbols and blast radius.
- [x] `query_graph` exposing a safe read-only Cypher-like subset.
- [x] `search_code` restricted to indexed files.
- [ ] Keep outputs compact, paged and token-efficient; always include `file:line`.
- [x] Add async indexing with a job status endpoint for long repositories.

### Phase 3 — Analytics and impact (P1)

- [x] PageRank / in-degree ranking per repository and per package.
- [x] Community detection over call/import edges to surface de facto modules.
- [x] Cycle detection for files, packages and call graphs.
- [x] Dead-code candidates: no indexed callers, excluding entry points and exports.
- [x] Hotspot ranking from fan-in, fan-out and complexity signals.
- [x] Complexity fields: cyclomatic, cognitive, loop depth, allocation/scan-in-loop signals.
- [x] Git-aware change impact: changed files → symbols → reverse dependencies.
- [x] Snapshot comparison between two index runs.
- [x] UI views for architecture, hotspots, complexity, dead code, cycles and change impact (Insights dialog).

### Phase 4 — Search and semantics (P1)

- [ ] Hybrid search: structural filters + BM25 + semantic similarity.
- [ ] Local embedding pipeline (no API keys, runs offline).
- [ ] Vector storage beside SQLite; incremental embedding for changed symbols only.
- [ ] Combine code, signature, docs and graph proximity in ranking.
- [ ] Near-duplicate detection for functions/classes and `SIMILAR_TO` edges.
- [ ] Expose semantic search through the existing `search_graph` surface, not a separate tool.

### Phase 5 — System context (P2)

- [x] Route nodes for Next.js file-based routing, Express-style declarations and FastAPI decorators.
- [ ] Channel edges for event emitters, pub/sub and message queues where statically resolvable.
- [x] Documentation sections: Markdown headings as graph nodes with `MENTIONS` links to code.
- [ ] Architecture decision records stored with the index.
- [ ] OpenAPI and GraphQL schema entities where they add navigable value.
- [ ] Container and deployment configuration nodes (Docker, Compose, Kubernetes, Helm).
- [ ] Cross-repository edges for HTTP, RPC and async channels.

### Phase 6 — Operations and distribution (P2)

- [ ] Background watcher with debounced incremental indexing.
- [ ] Project-scoped databases or an explicit project namespace in one database.
- [ ] Shared compressed graph artifact for team baselines.
- [ ] Artifact import on first index, then incremental local updates.
- [ ] Index freshness metadata and explicit stale/partial reporting.
- [ ] Optional daemon to own long-running watches and async jobs.
- [ ] Configurable neighborhood and search limits.

### Phase 7 — UI (P2)

- [ ] Architecture view with packages, entry points, clusters and dependencies.
- [ ] Hotspot and dead-code views with source evidence.
- [ ] Change-impact view driven by git diff.
- [ ] Project management: add, rename, delete and inspect coverage.
- [ ] Graph minimap and saved views.
- [ ] Keep the frontend static and build-step-free unless explicitly requested.

## Data Model v2 (proposed)

Nodes:

- `Repository`, `File`, `Symbol` (function, class, interface, type, enum, method, property, const),
  `Package`, `Route`, `DocumentSection`, `Decision`, `ExternalPackage`.

Symbol properties:

- `id`, `repoId`, `fileId`, `name`, `qualifiedName`, `kind`, `language`,
  `startLine`, `endLine`, `signature`, `doc`, `exported`, `visibility`,
  `containerName`, `complexity`, `inDegree`.

Edges:

- `IMPORTS`, `DEFINES`, `CONTAINS`, `CALLS`, `CALL_REFERENCE`, `USAGE`,
  `EXTENDS`, `IMPLEMENTS`, `THROWS`, `RAISES`, `REFERENCES`,
  `MENTIONS`, `TESTS`, `SIMILAR_TO`.

Resolution rules:

- Resolve by module path when the specifier is relative.
- Resolve package specifiers through manifests.
- Prefer a unique candidate; if ambiguous, keep the edge unresolved with a reason.
- Never invent a link to make the graph look complete.

## Success Metrics

- Parse coverage per language and per repository.
- Cross-file edge resolution rate, with unresolved edge reasons.
- Incremental re-index work proportional to changed files.
- Query latency targets: search < 50 ms, neighborhood < 100 ms, file graph < 250 ms.
- MCP output measured in tokens per useful answer.
- Zero silent data loss after a failed index run.

## Dependency Approval Queue

These require explicit approval before adding:

- Tree-sitter runtime and language grammars.
- Local embedding runtime and vector index (`sqlite-vec` or equivalent).
- Community-detection or graph-algorithm library (or implement in-house).
- Zstd compression for shared artifacts.

## Delivery Rules

- Test-first: every roadmap item starts with a focused test or fixture, and bug fixes include a regression test. See the Test-Driven Workflow in [AGENTS.md](AGENTS.md).
- Work in phases; each phase must build, test and be runnable before the next.
- Add focused tests for parser, indexing, query, HTTP and MCP changes.
- Run `npm run typecheck`, `npm test`, `npm run check` and `npm run build` after substantive edits.
- Update `README.md` for user-facing changes and `AGENTS.md` only when conventions change.
- Keep unrelated worktree edits untouched.
