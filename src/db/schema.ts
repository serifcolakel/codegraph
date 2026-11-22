import * as SqlClient from "@effect/sql/SqlClient"
import { Effect } from "effect"
import { StoreError } from "../domain/errors.js"
import { tokenizeIdentifier } from "../domain/naming.js"

export const initSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`PRAGMA foreign_keys = ON;`.pipe(
    Effect.mapError((e) => new StoreError({ message: "Failed to enable foreign keys", cause: e }))
  )

  yield* sql`
    CREATE TABLE IF NOT EXISTS repos (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root_path TEXT NOT NULL UNIQUE,
      indexed_at TEXT NOT NULL DEFAULT '',
      index_duration_ms INTEGER NOT NULL DEFAULT 0
    );
  `.pipe(
    Effect.mapError((e) => new StoreError({ message: "Failed to create repos table", cause: e }))
  )

  yield* sql`
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      hash TEXT NOT NULL,
      repo_id TEXT NOT NULL,
      language TEXT NOT NULL DEFAULT '',
      parse_status TEXT NOT NULL DEFAULT '',
      size_bytes INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(repo_id) REFERENCES repos(id) ON DELETE CASCADE
    );
  `.pipe(
    Effect.mapError((e) => new StoreError({ message: "Failed to create files table", cause: e }))
  )

  const repoColumns = yield* sql<{ name: string }>`PRAGMA table_info(repos);`.pipe(
    Effect.mapError((e) => new StoreError({ message: "Failed to inspect repos table", cause: e }))
  )
  const repoColumnNames = new Set(repoColumns.map((column) => column.name))
  if (!repoColumnNames.has("indexed_at")) {
    yield* sql`ALTER TABLE repos ADD COLUMN indexed_at TEXT NOT NULL DEFAULT '';`.pipe(
      Effect.mapError(
        (e) => new StoreError({ message: "Failed to add repos.indexed_at column", cause: e })
      )
    )
  }
  if (!repoColumnNames.has("index_duration_ms")) {
    yield* sql`ALTER TABLE repos ADD COLUMN index_duration_ms INTEGER NOT NULL DEFAULT 0;`.pipe(
      Effect.mapError(
        (e) => new StoreError({ message: "Failed to add repos.index_duration_ms column", cause: e })
      )
    )
  }

  const fileColumns = yield* sql<{ name: string }>`PRAGMA table_info(files);`.pipe(
    Effect.mapError((e) => new StoreError({ message: "Failed to inspect files table", cause: e }))
  )
  const fileColumnNames = new Set(fileColumns.map((column) => column.name))
  if (!fileColumnNames.has("language")) {
    yield* sql`ALTER TABLE files ADD COLUMN language TEXT NOT NULL DEFAULT '';`.pipe(
      Effect.mapError(
        (e) => new StoreError({ message: "Failed to add files.language column", cause: e })
      )
    )
  }
  if (!fileColumnNames.has("parse_status")) {
    yield* sql`ALTER TABLE files ADD COLUMN parse_status TEXT NOT NULL DEFAULT '';`.pipe(
      Effect.mapError(
        (e) => new StoreError({ message: "Failed to add files.parse_status column", cause: e })
      )
    )
  }
  if (!fileColumnNames.has("size_bytes")) {
    yield* sql`ALTER TABLE files ADD COLUMN size_bytes INTEGER NOT NULL DEFAULT 0;`.pipe(
      Effect.mapError(
        (e) => new StoreError({ message: "Failed to add files.size_bytes column", cause: e })
      )
    )
  }

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_files_repo_path ON files(repo_id, path);
  `.pipe(
    Effect.mapError(
      (e) => new StoreError({ message: "Failed to create idx_files_repo_path", cause: e })
    )
  )

  yield* sql`
    CREATE TABLE IF NOT EXISTS symbols (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      file_id TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      signature TEXT NOT NULL,
      exported INTEGER NOT NULL DEFAULT 0,
      doc TEXT NOT NULL DEFAULT '',
      language TEXT NOT NULL DEFAULT '',
      qualified_name TEXT NOT NULL DEFAULT '',
      visibility TEXT NOT NULL DEFAULT '',
      container_name TEXT NOT NULL DEFAULT '',
      cyclomatic INTEGER NOT NULL DEFAULT 1,
      cognitive INTEGER NOT NULL DEFAULT 1,
      loop_depth INTEGER NOT NULL DEFAULT 0,
      loop_count INTEGER NOT NULL DEFAULT 0,
      linear_scan_in_loop INTEGER NOT NULL DEFAULT 0,
      alloc_in_loop INTEGER NOT NULL DEFAULT 0,
      recursive INTEGER NOT NULL DEFAULT 0,
      param_count INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE
    );
  `.pipe(
    Effect.mapError((e) => new StoreError({ message: "Failed to create symbols table", cause: e }))
  )

  // Lightweight forward migrations for databases created before symbol v2.
  const symbolColumns = yield* sql<{ name: string }>`PRAGMA table_info(symbols);`.pipe(
    Effect.mapError((e) => new StoreError({ message: "Failed to inspect symbols table", cause: e }))
  )
  const symbolColumnNames = new Set(symbolColumns.map((column) => column.name))
  const symbolMigrations: ReadonlyArray<readonly [string, string, string]> = [
    ["doc", "TEXT NOT NULL DEFAULT ''", "Failed to add symbols.doc column"],
    ["language", "TEXT NOT NULL DEFAULT ''", "Failed to add symbols.language column"],
    ["qualified_name", "TEXT NOT NULL DEFAULT ''", "Failed to add symbols.qualified_name column"],
    ["visibility", "TEXT NOT NULL DEFAULT ''", "Failed to add symbols.visibility column"],
    ["container_name", "TEXT NOT NULL DEFAULT ''", "Failed to add symbols.container_name column"]
  ]
  for (const [name, definition, message] of symbolMigrations) {
    if (symbolColumnNames.has(name)) continue
    yield* sql
      .unsafe(`ALTER TABLE symbols ADD COLUMN ${name} ${definition};`)
      .pipe(Effect.mapError((e) => new StoreError({ message, cause: e })))
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_symbols_file_id ON symbols(file_id);
  `.pipe(
    Effect.mapError(
      (e) => new StoreError({ message: "Failed to create idx_symbols_file_id", cause: e })
    )
  )

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
  `.pipe(
    Effect.mapError(
      (e) => new StoreError({ message: "Failed to create idx_symbols_name", cause: e })
    )
  )

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_symbols_qualified_name ON symbols(qualified_name);
  `.pipe(
    Effect.mapError(
      (e) => new StoreError({ message: "Failed to create idx_symbols_qualified_name", cause: e })
    )
  )

  yield* sql`
    CREATE TABLE IF NOT EXISTS edges (
      id TEXT PRIMARY KEY,
      src_symbol_id TEXT NOT NULL,
      dst_symbol_id TEXT NOT NULL,
      kind TEXT NOT NULL
    );
  `.pipe(
    Effect.mapError((e) => new StoreError({ message: "Failed to create edges table", cause: e }))
  )

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src_symbol_id);
  `.pipe(
    Effect.mapError((e) => new StoreError({ message: "Failed to create idx_edges_src", cause: e }))
  )

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst_symbol_id);
  `.pipe(
    Effect.mapError((e) => new StoreError({ message: "Failed to create idx_edges_dst", cause: e }))
  )

  yield* sql`
    CREATE TABLE IF NOT EXISTS file_edges (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      src_file_id TEXT NOT NULL,
      dst_file_id TEXT,
      specifier TEXT NOT NULL,
      kind TEXT NOT NULL,
      src_line INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(repo_id) REFERENCES repos(id) ON DELETE CASCADE
    );
  `.pipe(
    Effect.mapError(
      (e) => new StoreError({ message: "Failed to create file_edges table", cause: e })
    )
  )

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_file_edges_repo ON file_edges(repo_id);
  `.pipe(
    Effect.mapError(
      (e) => new StoreError({ message: "Failed to create idx_file_edges_repo", cause: e })
    )
  )

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_file_edges_src ON file_edges(src_file_id);
  `.pipe(
    Effect.mapError(
      (e) => new StoreError({ message: "Failed to create idx_file_edges_src", cause: e })
    )
  )

  yield* sql`
    CREATE TABLE IF NOT EXISTS index_jobs (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      name TEXT,
      force INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      error TEXT,
      repo_id TEXT,
      report_json TEXT
    );
  `.pipe(
    Effect.mapError(
      (e) => new StoreError({ message: "Failed to create index_jobs table", cause: e })
    )
  )

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_index_jobs_status ON index_jobs(status);
  `.pipe(
    Effect.mapError(
      (e) => new StoreError({ message: "Failed to create idx_index_jobs_status", cause: e })
    )
  )

  yield* sql`
    CREATE TABLE IF NOT EXISTS index_snapshots (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      files INTEGER NOT NULL,
      symbols INTEGER NOT NULL,
      edges INTEGER NOT NULL,
      source_bytes INTEGER NOT NULL,
      languages_json TEXT NOT NULL,
      symbol_kinds_json TEXT NOT NULL,
      edge_kinds_json TEXT NOT NULL,
      coverage_json TEXT NOT NULL,
      FOREIGN KEY(repo_id) REFERENCES repos(id) ON DELETE CASCADE
    );
  `.pipe(
    Effect.mapError(
      (e) => new StoreError({ message: "Failed to create index_snapshots table", cause: e })
    )
  )

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_index_snapshots_repo ON index_snapshots(repo_id, created_at);
  `.pipe(
    Effect.mapError(
      (e) => new StoreError({ message: "Failed to create idx_index_snapshots_repo", cause: e })
    )
  )

  yield* sql`
    CREATE TABLE IF NOT EXISTS cross_repo_edges (
      id TEXT PRIMARY KEY,
      src_symbol_id TEXT NOT NULL,
      dst_symbol_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      confidence REAL NOT NULL,
      created_at TEXT NOT NULL
    );
  `.pipe(
    Effect.mapError(
      (e) => new StoreError({ message: "Failed to create cross_repo_edges table", cause: e })
    )
  )

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_cross_repo_src ON cross_repo_edges(src_symbol_id);
  `.pipe(
    Effect.mapError(
      (e) => new StoreError({ message: "Failed to create idx_cross_repo_src", cause: e })
    )
  )

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_cross_repo_dst ON cross_repo_edges(dst_symbol_id);
  `.pipe(
    Effect.mapError(
      (e) => new StoreError({ message: "Failed to create idx_cross_repo_dst", cause: e })
    )
  )

  const ftsTables = yield* sql<{ name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'symbols_fts';
  `.pipe(
    Effect.mapError((e) => new StoreError({ message: "Failed to inspect symbols_fts", cause: e }))
  )

  let repopulateFts = false
  if (ftsTables.length > 0) {
    const ftsColumns = yield* sql<{ name: string }>`PRAGMA table_info(symbols_fts);`.pipe(
      Effect.mapError(
        (e) => new StoreError({ message: "Failed to inspect symbols_fts columns", cause: e })
      )
    )
    const ftsColumnNames = new Set(ftsColumns.map((column) => column.name))
    if (!ftsColumnNames.has("doc") || !ftsColumnNames.has("tokens")) {
      yield* sql`DROP TABLE symbols_fts;`.pipe(
        Effect.mapError(
          (e) => new StoreError({ message: "Failed to migrate symbols_fts", cause: e })
        )
      )
      repopulateFts = true
    }
  }

  yield* sql`
    CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
      symbol_id UNINDEXED,
      name,
      signature,
      doc,
      tokens
    );
  `.pipe(
    Effect.mapError(
      (e) => new StoreError({ message: "Failed to create symbols_fts virtual table", cause: e })
    )
  )

  if (repopulateFts) {
    const rows = yield* sql<{
      id: string
      name: string
      qualifiedName: string
      signature: string
      doc: string
    }>`
      SELECT id, name, qualified_name as qualifiedName, signature, doc FROM symbols;
    `.pipe(
      Effect.mapError(
        (e) => new StoreError({ message: "Failed to read symbols for FTS rebuild", cause: e })
      )
    )

    yield* Effect.forEach(
      rows,
      (row) =>
        sql`
          INSERT INTO symbols_fts (symbol_id, name, signature, doc, tokens)
          VALUES (
            ${row.id},
            ${row.name},
            ${row.signature},
            ${row.doc},
            ${tokenizeIdentifier(`${row.name} ${row.qualifiedName}`)}
          );
        `.pipe(
          Effect.mapError(
            (e) => new StoreError({ message: "Failed to repopulate symbols_fts", cause: e })
          )
        ),
      { concurrency: 1 }
    )
  }
})
