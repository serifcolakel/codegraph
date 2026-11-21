import { Context, Effect, Layer } from "effect"
import * as SqlClient from "@effect/sql/SqlClient"
import { StoreError } from "../domain/errors.js"
import { initSchema } from "../db/schema.js"
import type {
  RepoRecord,
  FileRecord,
  SymbolRecord,
  EdgeRecord,
  ParsedFile,
  StatsReport
} from "../domain/models.js"

export interface StoredRawEdge {
  readonly id: string
  readonly fileId: string
  readonly srcName: string
  readonly dstName: string
  readonly kind: string
  readonly srcLine?: number
  readonly importPath?: string
}

export interface IndexStore {
  readonly initSchema: () => Effect.Effect<void, StoreError>
  readonly getOrCreateRepo: (rootPath: string, name?: string) => Effect.Effect<RepoRecord, StoreError>
  readonly getRepo: (idOrPath: string) => Effect.Effect<RepoRecord | null, StoreError>
  readonly listRepos: () => Effect.Effect<readonly RepoRecord[], StoreError>
  readonly getFiles: (repoId: string) => Effect.Effect<Map<string, FileRecord>, StoreError>
  readonly saveFileIndex: (
    repoId: string,
    filePath: string,
    hash: string,
    parsed: ParsedFile
  ) => Effect.Effect<void, StoreError>
  readonly deleteFiles: (fileIds: readonly string[]) => Effect.Effect<void, StoreError>
  readonly resolveEdges: (repoId: string) => Effect.Effect<number, StoreError>
  readonly getStats: (repoId?: string) => Effect.Effect<StatsReport, StoreError>
}

export const IndexStore = Context.GenericTag<IndexStore>("@codegraph/IndexStore")

export const IndexStoreLive = Layer.effect(
  IndexStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const init = () => initSchema.pipe(Effect.provideService(SqlClient.SqlClient, sql))

    const getOrCreateRepo = (
      rootPath: string,
      name?: string
    ): Effect.Effect<RepoRecord, StoreError> =>
      Effect.gen(function* () {
        const repoName = name ?? rootPath.split("/").filter(Boolean).pop() ?? "repo"
        const existing = yield* sql<RepoRecord>`
          SELECT id, name, root_path as rootPath FROM repos WHERE root_path = ${rootPath} LIMIT 1;
        `.pipe(Effect.mapError(e => new StoreError({ message: "Failed to find repo", cause: e })))

        if (existing.length > 0 && existing[0]) {
          return existing[0]
        }

        const id = `repo_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`
        yield* sql`
          INSERT INTO repos (id, name, root_path) VALUES (${id}, ${repoName}, ${rootPath});
        `.pipe(Effect.mapError(e => new StoreError({ message: "Failed to insert repo", cause: e })))

        return { id, name: repoName, rootPath }
      })

    const getRepo = (idOrPath: string): Effect.Effect<RepoRecord | null, StoreError> =>
      Effect.gen(function* () {
        const rows = yield* sql<RepoRecord>`
          SELECT id, name, root_path as rootPath FROM repos WHERE id = ${idOrPath} OR root_path = ${idOrPath} LIMIT 1;
        `.pipe(Effect.mapError(e => new StoreError({ message: "Failed to query repo", cause: e })))
        return rows[0] ?? null
      })

    const listRepos = (): Effect.Effect<readonly RepoRecord[], StoreError> =>
      sql<RepoRecord>`
        SELECT id, name, root_path as rootPath FROM repos ORDER BY name ASC;
      `.pipe(Effect.mapError(e => new StoreError({ message: "Failed to list repos", cause: e })))

    const getFiles = (repoId: string): Effect.Effect<Map<string, FileRecord>, StoreError> =>
      Effect.gen(function* () {
        const rows = yield* sql<{ id: string; path: string; hash: string; repo_id: string }>`
          SELECT id, path, hash, repo_id FROM files WHERE repo_id = ${repoId};
        `.pipe(Effect.mapError(e => new StoreError({ message: "Failed to query files", cause: e })))

        const map = new Map<string, FileRecord>()
        for (const row of rows) {
          map.set(row.path, {
            id: row.id,
            path: row.path,
            hash: row.hash,
            repoId: row.repo_id
          })
        }
        return map
      })

    const deleteFiles = (fileIds: readonly string[]): Effect.Effect<void, StoreError> =>
      Effect.gen(function* () {
        if (fileIds.length === 0) return

        yield* sql.withTransaction(
          Effect.gen(function* () {
            for (const fileId of fileIds) {
              // Delete symbols from FTS
              yield* sql`
                DELETE FROM symbols_fts WHERE symbol_id IN (
                  SELECT id FROM symbols WHERE file_id = ${fileId}
                );
              `
              // Delete edges connected to symbols of this file
              yield* sql`
                DELETE FROM edges WHERE src_symbol_id IN (
                  SELECT id FROM symbols WHERE file_id = ${fileId}
                ) OR dst_symbol_id IN (
                  SELECT id FROM symbols WHERE file_id = ${fileId}
                );
              `
              // Delete file (cascades to symbols)
              yield* sql`
                DELETE FROM files WHERE id = ${fileId};
              `
            }
          })
        ).pipe(Effect.mapError(e => new StoreError({ message: "Failed to delete files", cause: e })))
      })

    const saveFileIndex = (
      repoId: string,
      filePath: string,
      hash: string,
      parsed: ParsedFile
    ): Effect.Effect<void, StoreError> =>
      Effect.gen(function* () {
        const fileId = `${repoId}:${filePath}`

        yield* sql.withTransaction(
          Effect.gen(function* () {
            // Delete existing records for this file if present
            yield* sql`
              DELETE FROM symbols_fts WHERE symbol_id IN (
                SELECT id FROM symbols WHERE file_id = ${fileId}
              );
            `
            yield* sql`
              DELETE FROM edges WHERE src_symbol_id IN (
                SELECT id FROM symbols WHERE file_id = ${fileId}
              ) OR dst_symbol_id IN (
                SELECT id FROM symbols WHERE file_id = ${fileId}
              );
            `
            yield* sql`
              DELETE FROM files WHERE id = ${fileId};
            `

            // Insert file
            yield* sql`
              INSERT INTO files (id, path, hash, repo_id)
              VALUES (${fileId}, ${filePath}, ${hash}, ${repoId});
            `

            // Insert symbols
            const nameToSymbolId = new Map<string, string>()

            for (const sym of parsed.symbols) {
              const symbolId = `${fileId}#${sym.name}:${sym.startLine}`
              nameToSymbolId.set(sym.name, symbolId)

              yield* sql`
                INSERT INTO symbols (id, name, kind, file_id, start_line, end_line, signature, exported)
                VALUES (${symbolId}, ${sym.name}, ${sym.kind}, ${fileId}, ${sym.startLine}, ${sym.endLine}, ${sym.signature}, ${sym.exported ? 1 : 0});
              `

              yield* sql`
                INSERT INTO symbols_fts (symbol_id, name, signature)
                VALUES (${symbolId}, ${sym.name}, ${sym.signature});
              `
            }

            // Insert direct intradocument edges (e.g. contains, local calls, local extends)
            for (const edge of parsed.edges) {
              const srcId = nameToSymbolId.get(edge.srcName)
              const dstId = nameToSymbolId.get(edge.dstName)

              if (srcId && dstId) {
                const edgeId = `edge_${srcId}->${dstId}:${edge.kind}`
                yield* sql`
                  INSERT OR IGNORE INTO edges (id, src_symbol_id, dst_symbol_id, kind)
                  VALUES (${edgeId}, ${srcId}, ${dstId}, ${edge.kind});
                `
              } else if (srcId) {
                // If destination is not local, record placeholder or unresolved edge with target symbol name
                const dstTargetId = edge.importPath
                  ? `module:${edge.importPath}#${edge.dstName}`
                  : `symbol:${edge.dstName}`
                const edgeId = `edge_${srcId}->${dstTargetId}:${edge.kind}`
                yield* sql`
                  INSERT OR IGNORE INTO edges (id, src_symbol_id, dst_symbol_id, kind)
                  VALUES (${edgeId}, ${srcId}, ${dstTargetId}, ${edge.kind});
                `
              }
            }
          })
        ).pipe(Effect.mapError(e => new StoreError({ message: `Failed to save file index for ${filePath}`, cause: e })))
      })

    const resolveEdges = (repoId: string): Effect.Effect<number, StoreError> =>
      Effect.gen(function* () {
        // Query unresolved edges: dst_symbol_id LIKE 'symbol:%' or 'module:%'
        const unresolved = yield* sql<{ id: string; src_symbol_id: string; dst_symbol_id: string; kind: string }>`
          SELECT e.id, e.src_symbol_id, e.dst_symbol_id, e.kind
          FROM edges e
          JOIN symbols s ON e.src_symbol_id = s.id
          JOIN files f ON s.file_id = f.id
          WHERE f.repo_id = ${repoId} AND (e.dst_symbol_id LIKE 'symbol:%' OR e.dst_symbol_id LIKE 'module:%');
        `.pipe(Effect.mapError(e => new StoreError({ message: "Failed to query unresolved edges", cause: e })))

        if (unresolved.length === 0) return 0

        // Get all symbols in this repo for quick lookup by name
        const repoSymbols = yield* sql<{ id: string; name: string; exported: number }>`
          SELECT s.id, s.name, s.exported
          FROM symbols s
          JOIN files f ON s.file_id = f.id
          WHERE f.repo_id = ${repoId};
        `.pipe(Effect.mapError(e => new StoreError({ message: "Failed to fetch repo symbols for resolution", cause: e })))

        const exportedSymbolMap = new Map<string, string>()
        const anySymbolMap = new Map<string, string>()
        for (const s of repoSymbols) {
          if (!anySymbolMap.has(s.name)) {
            anySymbolMap.set(s.name, s.id)
          }
          if (s.exported === 1 && !exportedSymbolMap.has(s.name)) {
            exportedSymbolMap.set(s.name, s.id)
          }
        }

        let resolvedCount = 0
        yield* sql.withTransaction(
          Effect.gen(function* () {
            for (const edge of unresolved) {
              let targetName = ""
              if (edge.dst_symbol_id.startsWith("symbol:")) {
                targetName = edge.dst_symbol_id.slice("symbol:".length)
              } else if (edge.dst_symbol_id.startsWith("module:")) {
                const parts = edge.dst_symbol_id.split("#")
                targetName = parts[1] ?? ""
              }

              if (!targetName) continue

              const targetId = exportedSymbolMap.get(targetName) ?? anySymbolMap.get(targetName)
              if (targetId) {
                const newEdgeId = `edge_${edge.src_symbol_id}->${targetId}:${edge.kind}`
                yield* sql`DELETE FROM edges WHERE id = ${edge.id};`
                yield* sql`
                  INSERT OR IGNORE INTO edges (id, src_symbol_id, dst_symbol_id, kind)
                  VALUES (${newEdgeId}, ${edge.src_symbol_id}, ${targetId}, ${edge.kind});
                `
                resolvedCount++
              }
            }
          })
        ).pipe(Effect.mapError(e => new StoreError({ message: "Failed to resolve edges", cause: e })))

        return resolvedCount
      })

    const getStats = (repoId?: string): Effect.Effect<StatsReport, StoreError> =>
      Effect.gen(function* () {
        const reposCount = yield* sql<{ count: number }>`SELECT COUNT(*) as count FROM repos;`
        const filesCount = repoId
          ? yield* sql<{ count: number }>`SELECT COUNT(*) as count FROM files WHERE repo_id = ${repoId};`
          : yield* sql<{ count: number }>`SELECT COUNT(*) as count FROM files;`
        const symbolsCount = repoId
          ? yield* sql<{ count: number }>`
              SELECT COUNT(*) as count FROM symbols s
              JOIN files f ON s.file_id = f.id
              WHERE f.repo_id = ${repoId};
            `
          : yield* sql<{ count: number }>`SELECT COUNT(*) as count FROM symbols;`
        const edgesCount = repoId
          ? yield* sql<{ count: number }>`
              SELECT COUNT(*) as count FROM edges e
              JOIN symbols s ON e.src_symbol_id = s.id
              JOIN files f ON s.file_id = f.id
              WHERE f.repo_id = ${repoId};
            `
          : yield* sql<{ count: number }>`SELECT COUNT(*) as count FROM edges;`

        return {
          repos: reposCount[0]?.count ?? 0,
          files: filesCount[0]?.count ?? 0,
          symbols: symbolsCount[0]?.count ?? 0,
          edges: edgesCount[0]?.count ?? 0
        }
      }).pipe(Effect.mapError(e => new StoreError({ message: "Failed to get stats", cause: e })))

    return {
      initSchema: init,
      getOrCreateRepo,
      getRepo,
      listRepos,
      getFiles,
      saveFileIndex,
      deleteFiles,
      resolveEdges,
      getStats
    }
  })
)
