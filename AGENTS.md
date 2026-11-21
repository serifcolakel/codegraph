# Project Guidelines

## Architecture

- CodeGraph is a local TypeScript/JavaScript repository indexer built with Effect-TS.
- Keep capabilities behind Effect services: `Context.GenericTag` plus `Layer` implementations.
- Wire dependencies through `Layer`; do not introduce module-level mutable state or global singletons.
- Use typed `Data.TaggedError` classes from `src/domain/errors.ts` for recoverable failures.
- Use `@effect/platform` `FileSystem` and `Path` services for filesystem access.
- Validate external and service boundary data with Effect `Schema` where applicable.
- Keep the SQLite storage, parser, graph query, HTTP, MCP, and CLI responsibilities in their existing modules.

## Build and Test

- Install dependencies with `npm install` or `bun install`.
- Build with `npm run build`.
- Type-check with `npm run typecheck`.
- Run tests with `npm test`.
- Run Biome checks with `npm run check`; apply only safe repository fixes with `npm run check:fix`.
- Vitest tests live in `tests/**/*.test.ts` and use `@effect/vitest` for Effect-based tests.

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
