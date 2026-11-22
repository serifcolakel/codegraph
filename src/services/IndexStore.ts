import * as SqlClient from "@effect/sql/SqlClient"
import { Context, Effect, Layer } from "effect"
import { initSchema } from "../db/schema.js"
import { EMBEDDING_DIMENSIONS, embedSymbol, encodeVector } from "../domain/embeddings.js"
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
import type { PackageMapping } from "./manifest.js"

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

export interface IndexSnapshot {
  readonly id: string
  readonly repoId: string
  readonly createdAt: string
  readonly files: number
  readonly symbols: number
  readonly edges: number
  readonly sourceBytes: number
  readonly languages: Readonly<Record<string, number>>
  readonly symbolKinds: Readonly<Record<string, number>>
  readonly edgeKinds: Readonly<Record<string, number>>
  readonly coverage: ParseCoverage
}

export interface SnapshotMetricDelta {
  readonly name: string
  readonly from: number
  readonly to: number
  readonly delta: number
}

export interface SnapshotComparison {
  readonly repoId: string
  readonly from: IndexSnapshot
  readonly to: IndexSnapshot
  readonly totals: readonly SnapshotMetricDelta[]
  readonly languages: readonly SnapshotMetricDelta[]
  readonly symbolKinds: readonly SnapshotMetricDelta[]
  readonly edgeKinds: readonly SnapshotMetricDelta[]
  readonly coverage: readonly SnapshotMetricDelta[]
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
    sizeBytes: number,
    parsed: ParsedFile
  ) => Effect.Effect<void, StoreError>
  readonly deleteFiles: (fileIds: readonly string[]) => Effect.Effect<void, StoreError>
  readonly updateFileSizes: (
    repoId: string,
    files: readonly { readonly path: string; readonly sizeBytes: number }[]
  ) => Effect.Effect<void, StoreError>
  readonly deleteRepo: (repoId: string) => Effect.Effect<boolean, StoreError>
  readonly resolveEdges: (
    repoId: string,
    packageMappings?: readonly PackageMapping[]
  ) => Effect.Effect<number, StoreError>
  readonly getStats: (repoId?: string) => Effect.Effect<StatsReport, StoreError>
  readonly markRepoIndexed: (
    repoId: string,
    indexedAt: string,
    durationMs: number
  ) => Effect.Effect<void, StoreError>
  readonly getCoverage: (repoId: string) => Effect.Effect<ParseCoverage, StoreError>
  readonly getImportSummary: (
    repoId: string
  ) => Effect.Effect<
    { readonly total: number; readonly resolved: number; readonly unresolved: number },
    StoreError
  >
  readonly saveSnapshot: (
    repoId: string,
    createdAt: string,
    stats: StatsReport,
    coverage: ParseCoverage
  ) => Effect.Effect<void, StoreError>
  readonly listSnapshots: (
    repoId: string,
    limit?: number
  ) => Effect.Effect<readonly IndexSnapshot[], StoreError>
  readonly compareSnapshots: (
    repoId: string,
    fromId?: string,
    toId?: string
  ) => Effect.Effect<SnapshotComparison | null, StoreError>
  readonly ensureVectors: (repoId: string) => Effect.Effect<number, StoreError>
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
        const existing = yield* sql<{
          id: string
          name: string
          rootPath: string
          indexed_at: string
          index_duration_ms: number
        }>`
          SELECT id, name, root_path as rootPath, indexed_at, index_duration_ms
          FROM repos WHERE root_path = ${rootPath} LIMIT 1;
        `.pipe(Effect.mapError((e) => new StoreError({ message: "Failed to find repo", cause: e })))

        if (existing.length > 0 && existing[0]) {
          const row = existing[0]
          return {
            id: row.id,
            name: row.name,
            rootPath: row.rootPath,
            ...(row.indexed_at ? { indexedAt: row.indexed_at } : {}),
            ...(row.index_duration_ms > 0 ? { indexDurationMs: row.index_duration_ms } : {})
          }
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
        const rows = yield* sql<{
          id: string
          name: string
          rootPath: string
          indexed_at: string
          index_duration_ms: number
        }>`
          SELECT id, name, root_path as rootPath, indexed_at, index_duration_ms
          FROM repos WHERE id = ${idOrPath} OR root_path = ${idOrPath} LIMIT 1;
        `.pipe(
          Effect.mapError((e) => new StoreError({ message: "Failed to query repo", cause: e }))
        )
        const row = rows[0]
        if (!row) return null
        return {
          id: row.id,
          name: row.name,
          rootPath: row.rootPath,
          ...(row.indexed_at ? { indexedAt: row.indexed_at } : {}),
          ...(row.index_duration_ms > 0 ? { indexDurationMs: row.index_duration_ms } : {})
        }
      })

    const listRepos = (): Effect.Effect<readonly RepoRecord[], StoreError> =>
      sql<{
        id: string
        name: string
        rootPath: string
        indexed_at: string
        index_duration_ms: number
      }>`
        SELECT id, name, root_path as rootPath, indexed_at, index_duration_ms
        FROM repos ORDER BY name ASC;
      `.pipe(
        Effect.map((rows) =>
          rows.map((row) => ({
            id: row.id,
            name: row.name,
            rootPath: row.rootPath,
            ...(row.indexed_at ? { indexedAt: row.indexed_at } : {}),
            ...(row.index_duration_ms > 0 ? { indexDurationMs: row.index_duration_ms } : {})
          }))
        ),
        Effect.mapError((e) => new StoreError({ message: "Failed to list repos", cause: e }))
      )

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
        yield* sql`
          DELETE FROM file_edges WHERE src_file_id = ${fileId} OR dst_file_id = ${fileId};
        `
        yield* sql`
          DELETE FROM symbol_vectors WHERE symbol_id IN (
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

    const deleteRepo = (repoId: string): Effect.Effect<boolean, StoreError> =>
      Effect.gen(function* () {
        const existing = yield* sql<{ id: string }>`
          SELECT id FROM repos WHERE id = ${repoId} LIMIT 1;
        `.pipe(Effect.mapError((e) => new StoreError({ message: "Failed to find repo", cause: e })))

        if (existing.length === 0) return false

        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`
                DELETE FROM symbols_fts WHERE symbol_id IN (
                  SELECT symbols.id FROM symbols
                  JOIN files ON files.id = symbols.file_id
                  WHERE files.repo_id = ${repoId}
                );
              `
              yield* sql`
                DELETE FROM symbol_vectors WHERE symbol_id IN (
                  SELECT symbols.id FROM symbols
                  JOIN files ON files.id = symbols.file_id
                  WHERE files.repo_id = ${repoId}
                );
              `
              yield* sql`
                DELETE FROM edges WHERE src_symbol_id IN (
                  SELECT symbols.id FROM symbols
                  JOIN files ON files.id = symbols.file_id
                  WHERE files.repo_id = ${repoId}
                ) OR dst_symbol_id IN (
                  SELECT symbols.id FROM symbols
                  JOIN files ON files.id = symbols.file_id
                  WHERE files.repo_id = ${repoId}
                );
              `
              // Cascades to the repo's files and symbols.
              yield* sql`DELETE FROM repos WHERE id = ${repoId};`
            })
          )
          .pipe(
            Effect.mapError((e) => new StoreError({ message: "Failed to delete repo", cause: e }))
          )

        return true
      })

    const saveFileIndex = (
      repoId: string,
      filePath: string,
      hash: string,
      sizeBytes: number,
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
              INSERT INTO files (id, path, hash, repo_id, language, parse_status, size_bytes)
              VALUES (
                ${fileId}, ${filePath}, ${hash}, ${repoId}, ${language}, ${parseStatus},
                ${sizeBytes}
              );
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
                  language, qualified_name, visibility, container_name,
                  cyclomatic, cognitive, loop_depth, loop_count, linear_scan_in_loop,
                  alloc_in_loop, recursive, param_count
                )
                VALUES (
                  ${symbolId}, ${sym.name}, ${sym.kind}, ${fileId}, ${sym.startLine}, ${sym.endLine},
                  ${sym.signature}, ${sym.exported ? 1 : 0}, ${sym.doc ?? ""},
                  ${language}, ${qualifiedName}, ${sym.visibility ?? ""}, ${sym.containerName ?? ""},
                  ${sym.cyclomatic ?? 1}, ${sym.cognitive ?? 1}, ${sym.loopDepth ?? 0},
                  ${sym.loopCount ?? 0}, ${sym.linearScanInLoop ?? 0}, ${sym.allocInLoop ?? 0},
                  ${sym.recursive ? 1 : 0}, ${sym.paramCount ?? 0}
                );
              `

                yield* sql`
                INSERT INTO symbols_fts (symbol_id, name, signature, doc, tokens)
                VALUES (
                  ${symbolId}, ${sym.name}, ${sym.signature}, ${sym.doc ?? ""},
                  ${tokenizeIdentifier(`${sym.name} ${qualifiedName}`)}
                );
              `

                const vector = embedSymbol({
                  name: sym.name,
                  qualifiedName,
                  kind: sym.kind,
                  signature: sym.signature,
                  ...(sym.doc ? { doc: sym.doc } : {})
                })
                yield* sql`
                INSERT OR REPLACE INTO symbol_vectors (symbol_id, dims, vector, updated_at)
                VALUES (${symbolId}, ${EMBEDDING_DIMENSIONS}, ${encodeVector(vector)}, ${new Date().toISOString()});
              `
              }

              // File-level import edges are recorded even when the imported
              // binding is never used, so type-only imports remain visible.
              const importKeys = new Set<string>()
              for (const edge of parsed.edges) {
                if (edge.kind !== "import") continue
                const specifier = edge.dstName.trim()
                if (!specifier) continue
                const srcLine = edge.srcLine ?? 0
                const key = `${specifier}:${srcLine}`
                if (importKeys.has(key)) continue
                importKeys.add(key)
                const fileEdgeId = `import_${fileId}->${specifier}:${srcLine}`
                yield* sql`
                  INSERT OR IGNORE INTO file_edges (
                    id, repo_id, src_file_id, dst_file_id, specifier, kind, src_line
                  )
                  VALUES (
                    ${fileEdgeId}, ${repoId}, ${fileId}, NULL, ${specifier}, 'imports', ${srcLine}
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

    const resolveEdges = (
      repoId: string,
      packageMappings: readonly PackageMapping[] = []
    ): Effect.Effect<number, StoreError> =>
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

        const channelRows = yield* sql<{
          id: string
          name: string
          filePath: string
          startLine: number
        }>`
          SELECT s.id, s.name, f.path as filePath, s.start_line as startLine
          FROM symbols s
          JOIN files f ON s.file_id = f.id
          WHERE f.repo_id = ${repoId} AND s.kind = 'channel'
          ORDER BY f.path ASC, s.start_line ASC, s.id ASC;
        `.pipe(
          Effect.mapError(
            (e) => new StoreError({ message: "Failed to query channel symbols", cause: e })
          )
        )

        const canonicalChannels = new Map<string, string>()
        const duplicateChannels: string[] = []
        for (const row of channelRows) {
          const canonical = canonicalChannels.get(row.name)
          if (canonical) duplicateChannels.push(row.id)
          else canonicalChannels.set(row.name, row.id)
        }

        if (duplicateChannels.length > 0) {
          yield* sql
            .withTransaction(
              Effect.gen(function* () {
                for (const duplicate of duplicateChannels) {
                  const row = channelRows.find((entry) => entry.id === duplicate)
                  if (!row) continue
                  const canonical = canonicalChannels.get(row.name)
                  if (!canonical) continue
                  yield* sql`UPDATE edges SET dst_symbol_id = ${canonical} WHERE dst_symbol_id = ${duplicate};`
                  yield* sql`UPDATE edges SET src_symbol_id = ${canonical} WHERE src_symbol_id = ${duplicate};`
                  yield* sql`DELETE FROM symbols_fts WHERE symbol_id = ${duplicate};`
                  yield* sql`DELETE FROM symbols WHERE id = ${duplicate};`
                }
              })
            )
            .pipe(
              Effect.mapError(
                (e) => new StoreError({ message: "Failed to merge channel symbols", cause: e })
              )
            )
        }

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

        const stripKnownExtension = (filePath: string): string => filePath.replace(/\.[^./]+$/, "")

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

        const sortedMappings = [...packageMappings].sort(
          (a, b) => b.prefix.length - a.prefix.length
        )

        const resolvePackageModule = (specifier: string): string | undefined => {
          const mapping = sortedMappings.find(
            (candidate) =>
              specifier === candidate.prefix ||
              specifier.startsWith(`${candidate.prefix}/`) ||
              specifier.startsWith(`${candidate.prefix}.`)
          )
          if (!mapping) return undefined

          const rest = specifier.slice(mapping.prefix.length)
          const dotted = rest.startsWith(".")
          const normalizedRest = dotted
            ? rest.replace(/^\./, "").replace(/\./g, "/")
            : rest.replace(/^\//, "")
          return stripKnownExtension(
            [mapping.directory, normalizedRest].filter((part) => part.length > 0).join("/")
          )
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
            const resolved = moduleSpecifier.startsWith(".")
              ? resolveRelativeModule(edge.srcFilePath, moduleSpecifier)
              : resolvePackageModule(moduleSpecifier)
            if (resolved !== undefined) {
              candidates = candidates.filter((c) => {
                const withoutExt = stripKnownExtension(c.filePath)
                return (
                  withoutExt === resolved ||
                  withoutExt === `${resolved}/index` ||
                  dirname(c.filePath) === resolved
                )
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

        // Resolve file-level imports (recorded even when the binding is unused).
        const repoFiles = yield* sql<{ id: string; path: string }>`
          SELECT id, path FROM files WHERE repo_id = ${repoId};
        `.pipe(
          Effect.mapError((e) => new StoreError({ message: "Failed to list repo files", cause: e }))
        )

        const unresolvedImports = yield* sql<{
          id: string
          srcFileId: string
          specifier: string
          srcLine: number
          srcFilePath: string
        }>`
          SELECT fe.id, fe.src_file_id as srcFileId, fe.specifier, fe.src_line as srcLine,
                 sf.path as srcFilePath
          FROM file_edges fe
          JOIN files sf ON fe.src_file_id = sf.id
          WHERE fe.repo_id = ${repoId}
            AND fe.kind = 'imports'
            AND fe.dst_file_id IS NULL;
        `.pipe(
          Effect.mapError(
            (e) => new StoreError({ message: "Failed to query unresolved imports", cause: e })
          )
        )

        let resolvedImportCount = 0
        if (unresolvedImports.length > 0) {
          yield* sql
            .withTransaction(
              Effect.gen(function* () {
                for (const row of unresolvedImports) {
                  const resolved = row.specifier.startsWith(".")
                    ? resolveRelativeModule(row.srcFilePath, row.specifier)
                    : resolvePackageModule(row.specifier)
                  if (resolved === undefined) continue

                  const matches = repoFiles.filter((file) => {
                    if (file.id === row.srcFileId) return false
                    const withoutExt = stripKnownExtension(file.path)
                    return (
                      withoutExt === resolved ||
                      withoutExt === `${resolved}/index` ||
                      dirname(file.path) === resolved
                    )
                  })
                  if (matches.length === 0) continue

                  for (const match of matches) {
                    const id = `fileimport_${row.srcFileId}->${match.id}:${row.srcLine}`
                    yield* sql`
                      INSERT OR IGNORE INTO file_edges (
                        id, repo_id, src_file_id, dst_file_id, specifier, kind, src_line
                      )
                      VALUES (
                        ${id}, ${repoId}, ${row.srcFileId}, ${match.id}, ${row.specifier},
                        'imports', ${row.srcLine}
                      );
                    `
                  }
                  yield* sql`DELETE FROM file_edges WHERE id = ${row.id};`
                  resolvedImportCount++
                }
              })
            )
            .pipe(
              Effect.mapError(
                (e) => new StoreError({ message: "Failed to resolve file imports", cause: e })
              )
            )
        }

        return resolvedCount + resolvedImportCount
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

    const snapshotFromRow = (row: {
      id: string
      repo_id: string
      created_at: string
      files: number
      symbols: number
      edges: number
      source_bytes: number
      languages_json: string
      symbol_kinds_json: string
      edge_kinds_json: string
      coverage_json: string
    }): IndexSnapshot => {
      const parse = <T>(value: string, fallback: T): T => {
        try {
          return JSON.parse(value) as T
        } catch {
          return fallback
        }
      }
      return {
        id: row.id,
        repoId: row.repo_id,
        createdAt: row.created_at,
        files: row.files,
        symbols: row.symbols,
        edges: row.edges,
        sourceBytes: row.source_bytes,
        languages: parse<Record<string, number>>(row.languages_json, {}),
        symbolKinds: parse<Record<string, number>>(row.symbol_kinds_json, {}),
        edgeKinds: parse<Record<string, number>>(row.edge_kinds_json, {}),
        coverage: parse<ParseCoverage>(row.coverage_json, {
          parsed: 0,
          partial: 0,
          skipped: 0,
          unsupported: 0,
          unknown: 0,
          languages: {}
        })
      }
    }

    const listSnapshots = (
      repoId: string,
      limit: number = 20
    ): Effect.Effect<readonly IndexSnapshot[], StoreError> =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          id: string
          repo_id: string
          created_at: string
          files: number
          symbols: number
          edges: number
          source_bytes: number
          languages_json: string
          symbol_kinds_json: string
          edge_kinds_json: string
          coverage_json: string
        }>`
          SELECT id, repo_id, created_at, files, symbols, edges, source_bytes,
                 languages_json, symbol_kinds_json, edge_kinds_json, coverage_json
          FROM index_snapshots
          WHERE repo_id = ${repoId}
          ORDER BY created_at DESC, id DESC
          LIMIT ${Math.max(1, Math.min(100, limit))};
        `.pipe(
          Effect.mapError((e) => new StoreError({ message: "Failed to list snapshots", cause: e }))
        )
        return rows.map(snapshotFromRow)
      })

    const saveSnapshot = (
      repoId: string,
      createdAt: string,
      stats: StatsReport,
      coverage: ParseCoverage
    ): Effect.Effect<void, StoreError> =>
      Effect.gen(function* () {
        const symbolKinds = yield* sql<{ kind: string; count: number }>`
          SELECT s.kind, COUNT(*) as count
          FROM symbols s JOIN files f ON s.file_id = f.id
          WHERE f.repo_id = ${repoId}
          GROUP BY s.kind;
        `.pipe(
          Effect.mapError(
            (e) => new StoreError({ message: "Failed to count symbol kinds", cause: e })
          )
        )
        const edgeKinds = yield* sql<{ kind: string; count: number }>`
          SELECT e.kind, COUNT(*) as count
          FROM edges e
          JOIN symbols s ON e.src_symbol_id = s.id
          JOIN files f ON s.file_id = f.id
          WHERE f.repo_id = ${repoId}
          GROUP BY e.kind;
        `.pipe(
          Effect.mapError(
            (e) => new StoreError({ message: "Failed to count edge kinds", cause: e })
          )
        )

        const symbolKindMap: Record<string, number> = {}
        for (const row of symbolKinds) symbolKindMap[row.kind] = row.count
        const edgeKindMap: Record<string, number> = {}
        for (const row of edgeKinds) edgeKindMap[row.kind] = row.count

        const id = `snap_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`
        yield* sql`
          INSERT INTO index_snapshots (
            id, repo_id, created_at, files, symbols, edges, source_bytes,
            languages_json, symbol_kinds_json, edge_kinds_json, coverage_json
          )
          VALUES (
            ${id}, ${repoId}, ${createdAt}, ${stats.files}, ${stats.symbols}, ${stats.edges},
            ${stats.sourceBytes}, ${JSON.stringify(coverage.languages)},
            ${JSON.stringify(symbolKindMap)}, ${JSON.stringify(edgeKindMap)},
            ${JSON.stringify(coverage)}
          );
        `.pipe(
          Effect.mapError((e) => new StoreError({ message: "Failed to save snapshot", cause: e }))
        )
      })

    const compareSnapshots = (
      repoId: string,
      fromId?: string,
      toId?: string
    ): Effect.Effect<SnapshotComparison | null, StoreError> =>
      Effect.gen(function* () {
        const snapshots = yield* listSnapshots(repoId, 50)
        const to = toId ? snapshots.find((s) => s.id === toId) : snapshots[0]
        const from = fromId ? snapshots.find((s) => s.id === fromId) : snapshots[1]
        if (!from || !to || from.id === to.id) return null

        const delta = (name: string, previous: number, current: number): SnapshotMetricDelta => ({
          name,
          from: previous,
          to: current,
          delta: current - previous
        })

        const mapDelta = (
          previous: Readonly<Record<string, number>>,
          current: Readonly<Record<string, number>>
        ): readonly SnapshotMetricDelta[] => {
          const keys = new Set([...Object.keys(previous), ...Object.keys(current)])
          return Array.from(keys)
            .map((key) => delta(key, previous[key] ?? 0, current[key] ?? 0))
            .filter((entry) => entry.delta !== 0)
            .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.name.localeCompare(b.name))
        }

        return {
          repoId,
          from,
          to,
          totals: [
            delta("files", from.files, to.files),
            delta("symbols", from.symbols, to.symbols),
            delta("edges", from.edges, to.edges),
            delta("sourceBytes", from.sourceBytes, to.sourceBytes)
          ],
          languages: mapDelta(from.languages, to.languages),
          symbolKinds: mapDelta(from.symbolKinds, to.symbolKinds),
          edgeKinds: mapDelta(from.edgeKinds, to.edgeKinds),
          coverage: [
            delta("parsed", from.coverage.parsed, to.coverage.parsed),
            delta("partial", from.coverage.partial, to.coverage.partial),
            delta("skipped", from.coverage.skipped, to.coverage.skipped),
            delta("unsupported", from.coverage.unsupported, to.coverage.unsupported),
            delta("unknown", from.coverage.unknown, to.coverage.unknown)
          ].filter((entry) => entry.delta !== 0)
        }
      })

    const ensureVectors = (repoId: string): Effect.Effect<number, StoreError> =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          id: string
          name: string
          qualifiedName: string
          kind: string
          signature: string
          doc: string
        }>`
          SELECT s.id, s.name, s.qualified_name as qualifiedName, s.kind, s.signature, s.doc
          FROM symbols s
          JOIN files f ON s.file_id = f.id
          WHERE f.repo_id = ${repoId}
            AND NOT EXISTS (SELECT 1 FROM symbol_vectors v WHERE v.symbol_id = s.id);
        `.pipe(
          Effect.mapError(
            (e) => new StoreError({ message: "Failed to load symbols for vectors", cause: e })
          )
        )

        if (rows.length === 0) return 0
        const updatedAt = new Date().toISOString()
        yield* sql
          .withTransaction(
            Effect.forEach(
              rows,
              (row) => {
                const vector = embedSymbol({
                  name: row.name,
                  qualifiedName: row.qualifiedName,
                  kind: row.kind,
                  signature: row.signature,
                  ...(row.doc ? { doc: row.doc } : {})
                })
                return sql`
                  INSERT OR REPLACE INTO symbol_vectors (symbol_id, dims, vector, updated_at)
                  VALUES (${row.id}, ${EMBEDDING_DIMENSIONS}, ${encodeVector(vector)}, ${updatedAt});
                `
              },
              { concurrency: 1 }
            )
          )
          .pipe(
            Effect.mapError(
              (e) => new StoreError({ message: "Failed to backfill symbol vectors", cause: e })
            )
          )
        return rows.length
      })

    const getImportSummary = (
      repoId: string
    ): Effect.Effect<
      { readonly total: number; readonly resolved: number; readonly unresolved: number },
      StoreError
    > =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          total: number
          resolved: number
          unresolved: number
        }>`
          SELECT COUNT(*) as total,
                 COALESCE(SUM(CASE WHEN dst_file_id IS NULL THEN 0 ELSE 1 END), 0) as resolved,
                 COALESCE(SUM(CASE WHEN dst_file_id IS NULL THEN 1 ELSE 0 END), 0) as unresolved
          FROM file_edges
          WHERE repo_id = ${repoId} AND kind = 'imports';
        `.pipe(
          Effect.mapError(
            (e) => new StoreError({ message: "Failed to get import summary", cause: e })
          )
        )
        return {
          total: rows[0]?.total ?? 0,
          resolved: rows[0]?.resolved ?? 0,
          unresolved: rows[0]?.unresolved ?? 0
        }
      })

    const updateFileSizes = (
      repoId: string,
      files: readonly { readonly path: string; readonly sizeBytes: number }[]
    ): Effect.Effect<void, StoreError> =>
      files.length === 0
        ? Effect.void
        : sql
            .withTransaction(
              Effect.forEach(
                files,
                (file) =>
                  sql`
                    UPDATE files SET size_bytes = ${file.sizeBytes}
                    WHERE repo_id = ${repoId} AND path = ${file.path};
                  `,
                { concurrency: 1 }
              )
            )
            .pipe(
              Effect.asVoid,
              Effect.mapError(
                (e) => new StoreError({ message: "Failed to update file sizes", cause: e })
              )
            )

    const markRepoIndexed = (
      repoId: string,
      indexedAt: string,
      durationMs: number
    ): Effect.Effect<void, StoreError> =>
      sql`
        UPDATE repos SET indexed_at = ${indexedAt}, index_duration_ms = ${durationMs}
        WHERE id = ${repoId};
      `.pipe(
        Effect.mapError(
          (e) => new StoreError({ message: "Failed to update repo index metadata", cause: e })
        )
      )

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

        const sourceBytes = repoId
          ? yield* sql<{ bytes: number }>`
              SELECT COALESCE(SUM(size_bytes), 0) as bytes FROM files WHERE repo_id = ${repoId};
            `
          : yield* sql<{ bytes: number }>`
              SELECT COALESCE(SUM(size_bytes), 0) as bytes FROM files;
            `

        return {
          repos: reposCount[0]?.count ?? 0,
          files: filesCount[0]?.count ?? 0,
          symbols: symbolsCount[0]?.count ?? 0,
          edges: edgesCount[0]?.count ?? 0,
          sourceBytes: sourceBytes[0]?.bytes ?? 0
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
      deleteRepo,
      updateFileSizes,
      resolveEdges,
      getStats,
      getCoverage,
      getImportSummary,
      markRepoIndexed,
      saveSnapshot,
      listSnapshots,
      compareSnapshots,
      ensureVectors
    }
  })
)
