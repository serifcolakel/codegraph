# Project Guidelines

## Architecture

- CodeGraph is a local, multi-language repository indexer built with Effect-TS.
- Keep capabilities behind Effect services: `Context.GenericTag` plus `Layer` implementations.
- Wire dependencies through `Layer`; do not introduce module-level mutable state or global singletons.
- Use typed `Data.TaggedError` classes from `src/domain/errors.ts` for recoverable failures.
- Use `@effect/platform` `FileSystem` and `Path` services for filesystem access.
- Validate external and service boundary data with Effect `Schema` where applicable.
- Keep the SQLite storage, parser, graph query, HTTP, MCP, and CLI responsibilities in their existing modules.

## CodeGraph MCP Usage

When a CodeGraph index exists, prefer MCP tools over `grep`/file search:

1. `index_status` — check coverage/freshness; re-index only when `stale=true`.
2. `search_graph` — find symbols by name, kind, file or degree; add `semantic: true` for intent search.
3. `get_code_snippet` — read the exact source for one qualified name.
4. `trace_path` — callers/callees and impact; use `search_code` only for literal text.
5. `query_graph` — read-only Cypher subset for custom graph questions.
6. `analyze_graph` — architecture, hotspots, dead code, cycles, duplicates.
7. `detect_changes` — blast radius before finishing.

- Always cite `file:line` from tool output and treat unresolved edges as unknown.
- For large repositories use `index_repository` with `async=true`, then poll `index_job_status`.
- Do not force a full re-index for normal work; incremental indexing skips unchanged hashes.
- Keep MCP responses compact; prefer narrow filters and explicit limits over dumping the graph.
- MCP, HTTP and CLI must read the same `CODEGRAPH_DB_PATH`.

## Build and Test

- Install dependencies with `npm install` or `bun install`.
- Build with `npm run build`.
- Type-check with `npm run typecheck`.
- Run tests with `npm test`.
- Run Playwright E2E tests with `npm run test:e2e` (first run: `npx playwright install chromium`).
- Run Biome checks with `npm run check`; apply only safe repository fixes with `npm run check:fix`.
- Vitest tests live in `tests/**/*.test.ts` and use `@effect/vitest` for Effect-based tests.
- Playwright E2E tests live in `e2e/**/*.spec.ts` and use the fixture in `e2e/fixtures/`.

## Test-Driven Workflow

- Work test-first for behavior changes: add or update the focused test or fixture, confirm it fails for the right reason, then implement.
- Every bug fix needs a regression test that reproduces the original failure.
- While iterating, run the narrowest test: `npm test -- tests/<file>.test.ts`; run the full `npm test` before finishing.
- Parser changes: add one representative fixture per affected language and cover symbols, docs/tags, full signatures and edges.
- Indexing changes: verify a fresh index, an incremental re-index, a changed file, a deleted file, and FTS/edge consistency.
- Query, HTTP and MCP changes: assert response shapes, limits (`truncated`, depth caps, paging), error paths and `file:line` output.
- Schema changes: test migration from the previous schema, including FTS repopulation.
- UI changes: run `serve`, load `/` and verify the affected controls, empty states and browser console; add stable `data-testid` attributes and extend `e2e/app.spec.ts` when behavior changes.
- Finish only when typecheck, focused tests, full tests, Biome and build pass.

### Manual Smoke Checks

```bash
npm run build
CODEGRAPH_DB_PATH=/tmp/codegraph-test.sqlite node dist/cli/index.js index <path> --force
CODEGRAPH_DB_PATH=/tmp/codegraph-test.sqlite node dist/cli/index.js serve --port 4310
```

Verify `/api/repos`, `/api/graph`, `/api/search`, the MCP tools and the UI before calling a
phase complete.

## Implementation Conventions

- Preserve incremental indexing: unchanged files are skipped by hash and changed/removed files are replaced atomically.
- Run file parsing with bounded concurrency and preserve the existing ignore-glob behavior.
- Keep SQLite writes transactional and keep FTS5 and graph edge updates consistent.
- Resolve cross-file edges conservatively; do not invent ambiguous symbol links.
- The HTTP API and MCP server must use the same storage and query services, not separate data paths.
- MCP tool inputs and outputs must remain compact and include `file:line` context when appropriate.
- The frontend is a static file in `web/index.html`; do not introduce a build step unless explicitly requested.
- Read environment settings through `src/domain/config.ts` instead of scattering process environment access.

## Change Safety

- Make focused changes and preserve unrelated or concurrent worktree edits.
- Add or update focused tests for parser, indexing, query, HTTP, or MCP behavior changes.
- For frontend changes, verify that the static page still loads and key controls remain accessible.
- Run at least the relevant typecheck, test, and Biome check after substantive edits.

## Documentation

- Use [README.md](README.md) for setup and usage.
- Use [PLAN.md](PLAN.md) for the implementation roadmap and architectural goals.
- Keep `AGENTS.md` concise; link detailed documentation rather than duplicating it.
