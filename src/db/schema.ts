import * as SqlClient from "@effect/sql/SqlClient"
import { Effect } from "effect"
import { StoreError } from "../domain/errors.js"

export const initSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`PRAGMA foreign_keys = ON;`.pipe(
    Effect.mapError((e) => new StoreError({ message: "Failed to enable foreign keys", cause: e }))
  )

  yield* sql`
    CREATE TABLE IF NOT EXISTS repos (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root_path TEXT NOT NULL UNIQUE
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
      FOREIGN KEY(repo_id) REFERENCES repos(id) ON DELETE CASCADE
    );
  `.pipe(
    Effect.mapError((e) => new StoreError({ message: "Failed to create files table", cause: e }))
  )

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
      FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE
    );
  `.pipe(
    Effect.mapError((e) => new StoreError({ message: "Failed to create symbols table", cause: e }))
  )

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
    CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
      symbol_id UNINDEXED,
      name,
      signature
    );
  `.pipe(
    Effect.mapError(
      (e) => new StoreError({ message: "Failed to create symbols_fts virtual table", cause: e })
    )
  )
})
