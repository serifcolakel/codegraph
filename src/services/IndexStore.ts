import * as SqlClient from "@effect/sql/SqlClient"
import { Context, Effect, Layer } from "effect"
import { initSchema } from "../db/schema.js"
import { StoreError } from "../domain/errors.js"
import { languageForPath } from "../domain/languages.js"
import type {
  FileRecord,
  ParseCoverage,
  ParsedFile,
  ParseStatus,
  RepoRecord,
  StatsReport
} from "../domain/models.js"
import { qualifyName, tokenizeIdentifier } from "../domain/naming.js"

const PARSE_STATUSES: ReadonlySet<string> = new Set(["parsed", "partial", "skipped", "unsupported"])

const isParseStatus = (value: string): value is ParseStatus => PARSE_STATUSES.has(value)

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
  readonly getOrCreateRepo: (
    rootPath: string,
    name?: string
  ) => Effect.Effect<RepoRecord, StoreError>
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
  readonly getCoverage: (repoId: string) => Effect.Effect<ParseCoverage, StoreError>
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
        `.pipe(Effect.mapError((e) => new StoreError({ message: "Failed to find repo", cause: e })))

        if (existing.length > 0 && existing[0]) {
          return existing[0]
        }

        const id = `repo_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`
        yield* sql`
          INSERT INTO repos (id, name, root_path) VALUES (${id}, ${repoName}, ${rootPath});
        `.pipe(
          Effect.mapError((e) => new StoreError({ message: "Failed to insert repo", cause: e }))
        )

        return { id, name: repoName, rootPath }
      })

    const getRepo = (idOrPath: string): Effect.Effect<RepoRecord | null, StoreError> =>
      Effect.gen(function* () {
        const rows = yield* sql<RepoRecord>`
          SELECT id, name, root_path as rootPath FROM repos WHERE id = ${idOrPath} OR root_path = ${idOrPath} LIMIT 1;
        `.pipe(
          Effect.mapError((e) => new StoreError({ message: "Failed to query repo", cause: e }))
        )
        return rows[0] ?? null
      })

    const listRepos = (): Effect.Effect<readonly RepoRecord[], StoreError> =>
      sql<RepoRecord>`
        SELECT id, name, root_path as rootPath FROM repos ORDER BY name ASC;
      `.pipe(Effect.mapError((e) => new StoreError({ message: "Failed to list repos", cause: e })))

    const getFiles = (repoId: string): Effect.Effect<Map<string, FileRecord>, StoreError> =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          id: string
          path: string
          hash: string
          repo_id: string
          language: string
          parse_status: string
        }>`
          SELECT id, path, hash, repo_id, language, parse_status
          FROM files WHERE repo_id = ${repoId};
        `.pipe(
          Effect.mapError((e) => new StoreError({ message: "Failed to query files", cause: e }))
        )

        const map = new Map<string, FileRecord>()
        for (const row of rows) {
          map.set(row.path, {
            id: row.id,
            path: row.path,
            hash: row.hash,
            repoId: row.repo_id,
            language: row.language,
            parseStatus: isParseStatus(row.parse_status) ? row.parse_status : undefined
          })
        }
        return map
      })

    // Removes every row belonging to a file. Must run inside a transaction.
    const deleteFileData = (fileId: string): Effect.Effect<void, unknown> =>
      Effect.gen(function* () {
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
        // Cascades to the file's symbols and their FTS rows.
        yield* sql`DELETE FROM files WHERE id = ${fileId};`
      })

    const deleteFiles = (fileIds: readonly string[]): Effect.Effect<void, StoreError> =>
      Effect.gen(function* () {
        if (fileIds.length === 0) return

        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              for (const fileId of fileIds) {
                yield* deleteFileData(fileId)
              }
            })
          )
          .pipe(
            Effect.mapError((e) => new StoreError({ message: "Failed to delete files", cause: e }))
          )
      })

    const saveFileIndex = (
      repoId: string,
      filePath: string,
      hash: string,
      parsed: ParsedFile
    ): Effect.Effect<void, StoreError> =>
      Effect.gen(function* () {
        const fileId = `${repoId}:${filePath}`
        const language = languageForPath(filePath) ?? ""
        const parseStatus: ParseStatus = parsed.parseStatus ?? "parsed"

        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              // Replace an existing version of this file atomically.
              yield* deleteFileData(fileId)

              // Insert file
              yield* sql`
              INSERT INTO files (id, path, hash, repo_id, language, parse_status)
              VALUES (${fileId}, ${filePath}, ${hash}, ${repoId}, ${language}, ${parseStatus});
            `

              // Insert symbols
              const nameToSymbolId = new Map<string, string>()

              for (const sym of parsed.symbols) {
                const symbolId = `${fileId}#${sym.name}:${sym.startLine}`
                nameToSymbolId.set(sym.name, symbolId)
                const qualifiedName = qualifyName(filePath, sym.name, sym.containerName)

                yield* sql`
                INSERT INTO symbols (
                  id, name, kind, file_id, start_line, end_line, signature, exported, doc,
                  language, qualified_name, visibility, container_name
                )
                VALUES (
                  ${symbolId}, ${sym.name}, ${sym.kind}, ${fileId}, ${sym.startLine}, ${sym.endLine},
                  ${sym.signature}, ${sym.exported ? 1 : 0}, ${sym.doc ?? ""},
                  ${language}, ${qualifiedName}, ${sym.visibility ?? ""}, ${sym.containerName ?? ""}
                );
              `

                yield* sql`
                INSERT INTO symbols_fts (symbol_id, name, signature, doc, tokens)
                VALUES (
                  ${symbolId}, ${sym.name}, ${sym.signature}, ${sym.doc ?? ""},
                  ${tokenizeIdentifier(`${sym.name} ${qualifiedName}`)}
                );
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
          )
          .pipe(
            Effect.mapError(
              (e) =>
                new StoreError({ message: `Failed to save file index for ${filePath}`, cause: e })
            )
          )
      })

    const resolveEdges = (repoId: string): Effect.Effect<number, StoreError> =>
      Effect.gen(function* () {
        // Unresolved targets are stored as `symbol:<name>` or `module:<spec>#<name>`.
        const unresolved = yield* sql<{
          id: string
          src_symbol_id: string
          dst_symbol_id: string
          kind: string
          srcFilePath: string
        }>`
          SELECT e.id, e.src_symbol_id, e.dst_symbol_id, e.kind, sf.path as srcFilePath
          FROM edges e
          JOIN symbols s ON e.src_symbol_id = s.id
          JOIN files sf ON s.file_id = sf.id
          WHERE sf.repo_id = ${repoId} AND (e.dst_symbol_id LIKE 'symbol:%' OR e.dst_symbol_id LIKE 'module:%');
        `.pipe(
          Effect.mapError(
            (e) => new StoreError({ message: "Failed to query unresolved edges", cause: e })
          )
        )

        if (unresolved.length === 0) return 0

        const repoSymbols = yield* sql<{
          id: string
          name: string
          exported: number
          filePath: string
        }>`
          SELECT s.id, s.name, s.exported, f.path as filePath
          FROM symbols s
          JOIN files f ON s.file_id = f.id
          WHERE f.repo_id = ${repoId};
        `.pipe(
          Effect.mapError(
            (e) =>
              new StoreError({ message: "Failed to fetch repo symbols for resolution", cause: e })
          )
        )

        type Candidate = {
          readonly id: string
          readonly exported: boolean
          readonly filePath: string
        }
        const symbolsByName = new Map<string, Candidate[]>()
        for (const s of repoSymbols) {
          const list = symbolsByName.get(s.name) ?? []
          list.push({ id: s.id, exported: s.exported === 1, filePath: s.filePath })
          symbolsByName.set(s.name, list)
        }

        const stripKnownExtension = (filePath: string): string =>
          filePath.replace(/\.(?:d\.)?[cm]?[jt]sx?$/, "")

        const dirname = (filePath: string): string => {
          const idx = filePath.lastIndexOf("/")
          return idx === -1 ? "" : filePath.slice(0, idx)
        }

        // Resolve a relative module specifier against the importing file.
        // Package specifiers are intentionally left unresolved by path.
        const resolveRelativeModule = (fromFile: string, specifier: string): string | undefined => {
          if (!specifier.startsWith(".")) return undefined
          const segments = dirname(fromFile).split("/").filter(Boolean)
          for (const part of specifier.split("/")) {
            if (part === "" || part === ".") continue
            if (part === "..") segments.pop()
            else segments.push(part)
          }
          return stripKnownExtension(segments.join("/"))
        }

        const pickTarget = (edge: (typeof unresolved)[number]): string | undefined => {
          let targetName = ""
          let moduleSpecifier: string | undefined

          if (edge.dst_symbol_id.startsWith("symbol:")) {
            targetName = edge.dst_symbol_id.slice("symbol:".length)
          } else if (edge.dst_symbol_id.startsWith("module:")) {
            const rest = edge.dst_symbol_id.slice("module:".length)
            const hashIdx = rest.lastIndexOf("#")
            moduleSpecifier = hashIdx === -1 ? rest : rest.slice(0, hashIdx)
            targetName = hashIdx === -1 ? "" : rest.slice(hashIdx + 1)
          }

          if (!targetName) return undefined

          let candidates = symbolsByName.get(targetName) ?? []

          if (candidates.length > 1 && moduleSpecifier) {
            const resolved = resolveRelativeModule(edge.srcFilePath, moduleSpecifier)
            if (resolved !== undefined) {
              candidates = candidates.filter((c) => {
                const withoutExt = stripKnownExtension(c.filePath)
                return withoutExt === resolved || withoutExt === `${resolved}/index`
              })
            }
          }

          if (candidates.length === 1) return candidates[0]?.id

          // Ambiguous names: only resolve when exactly one candidate is exported.
          const exportedCandidates = candidates.filter((c) => c.exported)
          return exportedCandidates.length === 1 ? exportedCandidates[0]?.id : undefined
        }

        let resolvedCount = 0
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              for (const edge of unresolved) {
                const targetId = pickTarget(edge)
                if (!targetId) continue

                const newEdgeId = `edge_${edge.src_symbol_id}->${targetId}:${edge.kind}`
                yield* sql`DELETE FROM edges WHERE id = ${edge.id};`
                yield* sql`
                INSERT OR IGNORE INTO edges (id, src_symbol_id, dst_symbol_id, kind)
                VALUES (${newEdgeId}, ${edge.src_symbol_id}, ${targetId}, ${edge.kind});
              `
                resolvedCount++
              }
            })
          )
          .pipe(
            Effect.mapError((e) => new StoreError({ message: "Failed to resolve edges", cause: e }))
          )

        return resolvedCount
      })

    const getCoverage = (repoId: string): Effect.Effect<ParseCoverage, StoreError> =>
      Effect.gen(function* () {
        const statusRows = yield* sql<{ status: string; count: number }>`
          SELECT CASE
            WHEN parse_status IN ('parsed', 'partial', 'skipped', 'unsupported') THEN parse_status
            ELSE 'unknown'
          END as status, COUNT(*) as count
          FROM files
          WHERE repo_id = ${repoId}
          GROUP BY status;
        `.pipe(
          Effect.mapError((e) => new StoreError({ message: "Failed to get coverage", cause: e }))
        )

        const languageRows = yield* sql<{ language: string; count: number }>`
          SELECT CASE WHEN language = '' THEN 'unknown' ELSE language END as language,
                 COUNT(*) as count
          FROM files
          WHERE repo_id = ${repoId}
          GROUP BY language;
        `.pipe(
          Effect.mapError(
            (e) => new StoreError({ message: "Failed to get language coverage", cause: e })
          )
        )

        const counts: Record<string, number> = {
          parsed: 0,
          partial: 0,
          skipped: 0,
          unsupported: 0,
          unknown: 0
        }
        for (const row of statusRows) {
          counts[row.status] = row.count
        }

        const languages: Record<string, number> = {}
        for (const row of languageRows) {
          languages[row.language] = row.count
        }

        return {
          parsed: counts.parsed ?? 0,
          partial: counts.partial ?? 0,
          skipped: counts.skipped ?? 0,
          unsupported: counts.unsupported ?? 0,
          unknown: counts.unknown ?? 0,
          languages
        }
      })

    const getStats = (repoId?: string): Effect.Effect<StatsReport, StoreError> =>
      Effect.gen(function* () {
        const reposCount = yield* sql<{ count: number }>`SELECT COUNT(*) as count FROM repos;`
        const filesCount = repoId
          ? yield* sql<{
              count: number
            }>`SELECT COUNT(*) as count FROM files WHERE repo_id = ${repoId};`
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
      }).pipe(Effect.mapError((e) => new StoreError({ message: "Failed to get stats", cause: e })))

    return {
      initSchema: init,
      getOrCreateRepo,
      getRepo,
      listRepos,
      getFiles,
      saveFileIndex,
      deleteFiles,
      resolveEdges,
      getStats,
      getCoverage
    }
  })
)
