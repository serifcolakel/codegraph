import { FileSystem, Path } from "@effect/platform"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import * as SqlClient from "@effect/sql/SqlClient"
import * as Sqlite from "@effect/sql-sqlite-node"
import { it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { describe, expect } from "vitest"
import { FileWalkerLive } from "../src/services/FileWalker.js"
import { GraphQuery, GraphQueryLive } from "../src/services/GraphQuery.js"
import { Indexer, IndexerLive } from "../src/services/Indexer.js"
import { IndexStore, IndexStoreLive } from "../src/services/IndexStore.js"
import { ParserLive } from "../src/services/Parser.js"

describe("Symbol model v2", () => {
  it.effect("persists language, qualified name and visibility, and tokenizes FTS names", () =>
    Effect.gen(function* () {
      const indexer = yield* Indexer
      const query = yield* GraphQuery
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const tmpDir = path.resolve(`./.test-tmp-model-v2-${Date.now()}`)
      yield* fs.makeDirectory(tmpDir, { recursive: true })

      try {
        yield* fs.writeFileString(
          path.join(tmpDir, "hooks.ts"),
          `
/** Tracks fund sizes for the dashboard. */
export function useFundSizes(): number[] {
  return [];
}

export class FundStore {
  private readonly sizes: number[] = [];

  public load(): void {
    this.sizes.length = 0;
  }
}
`
        )
        yield* fs.writeFileString(
          path.join(tmpDir, "service.py"),
          `
class FundService:
    """Fund service docs."""

    def compare(self, codes):
        """Compare funds."""
        return codes
`
        )

        const report = yield* indexer.indexRepo(tmpDir, { name: "model-v2" })

        // Both TypeScript and Python now produce AST-backed symbols.
        expect(report.coverage.parsed).toBe(2)
        expect(report.coverage.partial).toBe(0)
        expect(report.coverage.unknown).toBe(0)
        expect(report.coverage.languages.typescript).toBe(1)
        expect(report.coverage.languages.python).toBe(1)

        // camelCase identifiers are reachable by their parts and whole name.
        for (const term of ["fund", "sizes", "useFundSizes"]) {
          const results = yield* query.searchSymbols(term, 10, report.repoId)
          expect(
            results.some((s) => s.name === "useFundSizes"),
            `expected FTS term ${term} to match useFundSizes`
          ).toBe(true)
        }

        const outline = yield* query.outlineFile(report.repoId, "hooks.ts")
        const fn = outline.find((s) => s.name === "useFundSizes")
        expect(fn?.language).toBe("typescript")
        expect(fn?.qualifiedName).toBe("hooks.useFundSizes")
        expect(fn?.visibility).toBe("public")
        expect(fn?.containerName).toBeUndefined()

        const method = outline.find((s) => s.name === "FundStore.load")
        expect(method?.visibility).toBe("public")
        expect(method?.containerName).toBe("FundStore")
        expect(method?.qualifiedName).toBe("hooks.FundStore.load")

        const privateField = outline.find((s) => s.name === "FundStore.sizes")
        expect(privateField?.visibility).toBe("private")

        const pythonOutline = yield* query.outlineFile(report.repoId, "service.py")
        const pythonMethod = pythonOutline.find((s) => s.name === "FundService.compare")
        expect(pythonMethod?.language).toBe("python")
        expect(pythonMethod?.qualifiedName).toBe("service.FundService.compare")
        expect(pythonMethod?.visibility).toBe("public")
      } finally {
        yield* fs.remove(tmpDir, { recursive: true }).pipe(Effect.ignore)
      }
    }).pipe(
      Effect.provide(
        (() => {
          const SqlLive = Sqlite.SqliteClient.layer({ filename: ":memory:" })
          const StoreLive = IndexStoreLive.pipe(Layer.provide(SqlLive))
          const QueryLive = GraphQueryLive.pipe(Layer.provide(SqlLive))
          const PlatformLive = Layer.merge(NodeFileSystem.layer, NodePath.layer)
          const WalkerLive = FileWalkerLive.pipe(Layer.provide(PlatformLive))
          const IndexerTestLive = IndexerLive.pipe(
            Layer.provide(Layer.mergeAll(StoreLive, WalkerLive, ParserLive, PlatformLive))
          )
          return Layer.mergeAll(IndexerTestLive, StoreLive, QueryLive, PlatformLive)
        })()
      )
    )
  )

  it.effect("migrates a legacy schema and rebuilds FTS with tokens", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const store = yield* IndexStore

      // Minimal pre-v2 schema: no doc/language/qualified_name columns and an
      // FTS table without the tokens column.
      yield* sql`CREATE TABLE repos (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL UNIQUE
      );`
      yield* sql`CREATE TABLE files (
        id TEXT PRIMARY KEY, path TEXT NOT NULL, hash TEXT NOT NULL,
        repo_id TEXT NOT NULL, FOREIGN KEY(repo_id) REFERENCES repos(id) ON DELETE CASCADE
      );`
      yield* sql`CREATE TABLE symbols (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, file_id TEXT NOT NULL,
        start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, signature TEXT NOT NULL,
        exported INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE
      );`
      yield* sql`CREATE VIRTUAL TABLE symbols_fts USING fts5(
        symbol_id UNINDEXED, name, signature
      );`
      yield* sql`INSERT INTO repos (id, name, root_path) VALUES ('r1', 'legacy', '/legacy');`
      yield* sql`INSERT INTO files (id, path, hash, repo_id) VALUES ('r1:hooks.ts', 'hooks.ts', 'h', 'r1');`
      yield* sql`INSERT INTO symbols (id, name, kind, file_id, start_line, end_line, signature)
        VALUES ('r1:hooks.ts#useFundSizes:1', 'useFundSizes', 'function', 'r1:hooks.ts', 1, 3,
                'export function useFundSizes()');`
      yield* sql`INSERT INTO symbols_fts (symbol_id, name, signature)
        VALUES ('r1:hooks.ts#useFundSizes:1', 'useFundSizes', 'export function useFundSizes()');`

      yield* store.initSchema()

      const symbolColumns = yield* sql<{ name: string }>`PRAGMA table_info(symbols);`
      const symbolColumnNames = symbolColumns.map((column) => column.name)
      expect(symbolColumnNames).toEqual(
        expect.arrayContaining([
          "doc",
          "language",
          "qualified_name",
          "visibility",
          "container_name"
        ])
      )

      const fileColumns = yield* sql<{ name: string }>`PRAGMA table_info(files);`
      const fileColumnNames = fileColumns.map((column) => column.name)
      expect(fileColumnNames).toEqual(expect.arrayContaining(["language", "parse_status"]))

      const ftsColumns = yield* sql<{ name: string }>`PRAGMA table_info(symbols_fts);`
      expect(ftsColumns.map((column) => column.name)).toContain("tokens")

      const ftsCount = yield* sql<{ count: number }>`SELECT COUNT(*) as count FROM symbols_fts;`
      expect(ftsCount[0]?.count).toBe(1)

      const byPart = yield* sql<{ symbol_id: string }>`
        SELECT symbol_id FROM symbols_fts WHERE symbols_fts MATCH 'fund';
      `
      expect(byPart.map((row) => row.symbol_id)).toContain("r1:hooks.ts#useFundSizes:1")

      const byWholeName = yield* sql<{ symbol_id: string }>`
        SELECT symbol_id FROM symbols_fts WHERE symbols_fts MATCH 'useFundSizes';
      `
      expect(byWholeName.map((row) => row.symbol_id)).toContain("r1:hooks.ts#useFundSizes:1")
    }).pipe(
      Effect.provide(
        (() => {
          const SqlLive = Sqlite.SqliteClient.layer({ filename: ":memory:" })
          return Layer.merge(SqlLive, IndexStoreLive.pipe(Layer.provide(SqlLive)))
        })()
      )
    )
  )
})
