import * as SqlClient from "@effect/sql/SqlClient"
import { Context, Effect, Layer } from "effect"
import { NotFoundError, StoreError } from "../domain/errors.js"
import type {
  EdgeKind,
  EdgeRecord,
  FileGraph,
  NeighborhoodGraph,
  ReferenceResult,
  SymbolDetails,
  SymbolKind,
  SymbolRecord,
  SymbolWithFile
} from "../domain/models.js"

export interface SearchGraphOptions {
  readonly namePattern?: string
  readonly regex?: boolean
  readonly kind?: SymbolKind
  readonly filePattern?: string
  readonly repoId?: string
  readonly minDegree?: number
  readonly maxDegree?: number
  readonly limit?: number
  readonly offset?: number
}

export interface SearchGraphResult {
  readonly results: readonly SymbolWithFile[]
  readonly total: number
  readonly hasMore: boolean
  readonly truncated: boolean
}

export interface ArchitectureSymbol {
  readonly id: string
  readonly name: string
  readonly kind: SymbolKind
  readonly filePath: string
  readonly startLine: number
  readonly inDegree: number
}

export interface ArchitecturePackage {
  readonly name: string
  readonly files: number
  readonly symbols: number
}

export interface ArchitectureSummary {
  readonly repoId: string
  readonly files: number
  readonly symbols: number
  readonly edges: number
  readonly languages: Readonly<Record<string, number>>
  readonly packages: readonly ArchitecturePackage[]
  readonly entryPoints: readonly ArchitectureSymbol[]
  readonly hotspots: readonly ArchitectureSymbol[]
}

export type TraceDirection = "inbound" | "outbound" | "both"
export type TraceMode = "calls" | "references" | "data_flow" | "cross_file"

export interface TracePathOptions {
  readonly direction?: TraceDirection
  readonly depth?: number
  readonly mode?: TraceMode
}

export interface TraceNode extends ArchitectureSymbol {
  readonly hop: number
}

export interface TracePathResult {
  readonly start: ArchitectureSymbol
  readonly nodes: readonly TraceNode[]
  readonly edges: readonly EdgeRecord[]
  readonly truncated: boolean
}

export interface GraphQuery {
  readonly searchSymbols: (
    query: string,
    limit?: number,
    repoId?: string
  ) => Effect.Effect<readonly SymbolWithFile[], StoreError>

  readonly getSymbol: (symbolId: string) => Effect.Effect<SymbolDetails, StoreError | NotFoundError>

  readonly getSymbolByQualifiedName: (
    qualifiedName: string,
    repoId?: string
  ) => Effect.Effect<SymbolWithFile | null, StoreError>

  readonly searchGraph: (
    options: SearchGraphOptions
  ) => Effect.Effect<SearchGraphResult, StoreError>

  readonly architecture: (repoId: string) => Effect.Effect<ArchitectureSummary, StoreError>

  readonly tracePath: (
    selector: string,
    options?: TracePathOptions
  ) => Effect.Effect<TracePathResult | null, StoreError>

  readonly findReferences: (
    symbolId: string
  ) => Effect.Effect<readonly ReferenceResult[], StoreError>

  readonly outlineFile: (
    repoIdOrPath: string,
    filePath: string
  ) => Effect.Effect<readonly SymbolRecord[], StoreError | NotFoundError>

  readonly neighborhood: (
    symbolId: string,
    depth?: number
  ) => Effect.Effect<NeighborhoodGraph, StoreError | NotFoundError>

  readonly repoMap: (
    repoId: string,
    maxTokens?: number
  ) => Effect.Effect<string, StoreError | NotFoundError>

  readonly fileGraph: (repoId: string) => Effect.Effect<FileGraph, StoreError | NotFoundError>
}

export const GraphQuery = Context.GenericTag<GraphQuery>("@codegraph/GraphQuery")

export const GraphQueryLive = Layer.effect(
  GraphQuery,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const searchSymbols = (
      query: string,
      limit: number = 20,
      repoId?: string
    ): Effect.Effect<readonly SymbolWithFile[], StoreError> =>
      Effect.gen(function* () {
        const cleanQuery = query
          .trim()
          .replace(/[^\p{L}\p{N}_.]+/gu, " ")
          .trim()

        // An empty query is used by the UI to seed the symbol-level view:
        // return the most referenced symbols instead of nothing.
        if (!cleanQuery) {
          const rows = yield* (
            repoId
              ? sql<{
                  id: string
                  name: string
                  kind: SymbolKind
                  fileId: string
                  filePath: string
                  startLine: number
                  endLine: number
                  signature: string
                  exported: number
                  doc: string
                  inDegree: number
                }>`
                  SELECT s.id, s.name, s.kind, s.file_id as fileId, f.path as filePath,
                         s.start_line as startLine, s.end_line as endLine, s.signature, s.exported, s.doc,
                         (SELECT COUNT(*) FROM edges e WHERE e.dst_symbol_id = s.id) as inDegree
                  FROM symbols s
                  JOIN files f ON s.file_id = f.id
                  WHERE f.repo_id = ${repoId}
                  ORDER BY inDegree DESC, s.name ASC
                  LIMIT ${limit};
                `
              : sql<{
                  id: string
                  name: string
                  kind: SymbolKind
                  fileId: string
                  filePath: string
                  startLine: number
                  endLine: number
                  signature: string
                  exported: number
                  doc: string
                  inDegree: number
                }>`
                  SELECT s.id, s.name, s.kind, s.file_id as fileId, f.path as filePath,
                         s.start_line as startLine, s.end_line as endLine, s.signature, s.exported, s.doc,
                         (SELECT COUNT(*) FROM edges e WHERE e.dst_symbol_id = s.id) as inDegree
                  FROM symbols s
                  JOIN files f ON s.file_id = f.id
                  ORDER BY inDegree DESC, s.name ASC
                  LIMIT ${limit};
                `
          ).pipe(
            Effect.mapError((e) => new StoreError({ message: "Failed to list symbols", cause: e }))
          )

          return rows.map((r) => ({
            id: r.id,
            name: r.name,
            kind: r.kind,
            fileId: r.fileId,
            filePath: r.filePath,
            startLine: r.startLine,
            endLine: r.endLine,
            signature: r.signature,
            doc: r.doc,
            exported: r.exported === 1,
            inDegree: r.inDegree
          }))
        }

        const ftsMatch = `${cleanQuery}*`

        // Try FTS search first
        const ftsResults = yield* (
          repoId
            ? sql<{
                id: string
                name: string
                kind: SymbolKind
                fileId: string
                filePath: string
                startLine: number
                endLine: number
                signature: string
                exported: number
                doc: string
                inDegree: number
              }>`
                SELECT s.id, s.name, s.kind, s.file_id as fileId, f.path as filePath,
                       s.start_line as startLine, s.end_line as endLine, s.signature, s.exported, s.doc,
                       (SELECT COUNT(*) FROM edges e WHERE e.dst_symbol_id = s.id) as inDegree
                FROM symbols_fts fts
                JOIN symbols s ON fts.symbol_id = s.id
                JOIN files f ON s.file_id = f.id
                WHERE f.repo_id = ${repoId} AND symbols_fts MATCH ${ftsMatch}
                ORDER BY rank
                LIMIT ${limit};
              `
            : sql<{
                id: string
                name: string
                kind: SymbolKind
                fileId: string
                filePath: string
                startLine: number
                endLine: number
                signature: string
                exported: number
                doc: string
                inDegree: number
              }>`
                SELECT s.id, s.name, s.kind, s.file_id as fileId, f.path as filePath,
                       s.start_line as startLine, s.end_line as endLine, s.signature, s.exported, s.doc,
                       (SELECT COUNT(*) FROM edges e WHERE e.dst_symbol_id = s.id) as inDegree
                FROM symbols_fts fts
                JOIN symbols s ON fts.symbol_id = s.id
                JOIN files f ON s.file_id = f.id
                WHERE symbols_fts MATCH ${ftsMatch}
                ORDER BY rank
                LIMIT ${limit};
              `
        ).pipe(
          Effect.catchAll(() =>
            // Fallback to LIKE if FTS expression has syntax peculiarities
            repoId
              ? sql<{
                  id: string
                  name: string
                  kind: SymbolKind
                  fileId: string
                  filePath: string
                  startLine: number
                  endLine: number
                  signature: string
                  exported: number
                  doc: string
                  inDegree: number
                }>`
                  SELECT s.id, s.name, s.kind, s.file_id as fileId, f.path as filePath,
                         s.start_line as startLine, s.end_line as endLine, s.signature, s.exported, s.doc,
                         (SELECT COUNT(*) FROM edges e WHERE e.dst_symbol_id = s.id) as inDegree
                  FROM symbols s
                  JOIN files f ON s.file_id = f.id
                  WHERE f.repo_id = ${repoId} AND (s.name LIKE ${`%${cleanQuery}%`} OR s.signature LIKE ${`%${cleanQuery}%`} OR s.doc LIKE ${`%${cleanQuery}%`})
                  LIMIT ${limit};
                `
              : sql<{
                  id: string
                  name: string
                  kind: SymbolKind
                  fileId: string
                  filePath: string
                  startLine: number
                  endLine: number
                  signature: string
                  exported: number
                  doc: string
                  inDegree: number
                }>`
                  SELECT s.id, s.name, s.kind, s.file_id as fileId, f.path as filePath,
                         s.start_line as startLine, s.end_line as endLine, s.signature, s.exported, s.doc,
                         (SELECT COUNT(*) FROM edges e WHERE e.dst_symbol_id = s.id) as inDegree
                  FROM symbols s
                  JOIN files f ON s.file_id = f.id
                  WHERE s.name LIKE ${`%${cleanQuery}%`} OR s.signature LIKE ${`%${cleanQuery}%`} OR s.doc LIKE ${`%${cleanQuery}%`}
                  LIMIT ${limit};
                `
          ),
          Effect.mapError(
            (e) => new StoreError({ message: "Search symbols query failed", cause: e })
          )
        )

        return ftsResults.map((r) => ({
          id: r.id,
          name: r.name,
          kind: r.kind,
          fileId: r.fileId,
          filePath: r.filePath,
          startLine: r.startLine,
          endLine: r.endLine,
          signature: r.signature,
          doc: r.doc,
          exported: r.exported === 1,
          inDegree: r.inDegree
        }))
      })

    const MAX_SEARCH_GRAPH_CANDIDATES = 20000

    const searchGraph = (
      options: SearchGraphOptions
    ): Effect.Effect<SearchGraphResult, StoreError> =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          id: string
          name: string
          kind: SymbolKind
          fileId: string
          filePath: string
          startLine: number
          endLine: number
          signature: string
          exported: number
          doc: string
          inDegree: number
        }>`
          SELECT s.id, s.name, s.kind, s.file_id as fileId, f.path as filePath,
                 s.start_line as startLine, s.end_line as endLine, s.signature, s.exported, s.doc,
                 (SELECT COUNT(*) FROM edges e WHERE e.dst_symbol_id = s.id) as inDegree
          FROM symbols s
          JOIN files f ON s.file_id = f.id
          WHERE 1 = 1
            ${options.repoId ? sql`AND f.repo_id = ${options.repoId}` : sql``}
            ${options.kind ? sql`AND s.kind = ${options.kind}` : sql``}
          ORDER BY inDegree DESC, s.name ASC
          LIMIT ${MAX_SEARCH_GRAPH_CANDIDATES};
        `.pipe(
          Effect.mapError((e) => new StoreError({ message: "Search graph query failed", cause: e }))
        )

        let nameMatcher: ((name: string) => boolean) | undefined
        if (options.namePattern) {
          if (options.regex) {
            try {
              const pattern = new RegExp(options.namePattern, "i")
              nameMatcher = (name) => pattern.test(name)
            } catch {
              nameMatcher = undefined
            }
          }
          if (!nameMatcher) {
            const needle = options.namePattern.toLowerCase()
            nameMatcher = (name) => name.toLowerCase().includes(needle)
          }
        }

        const fileNeedle = options.filePattern?.toLowerCase()
        const minDegree = options.minDegree ?? 0
        const maxDegree = options.maxDegree ?? Number.MAX_SAFE_INTEGER

        const filtered = rows.filter((row) => {
          if (nameMatcher && !nameMatcher(row.name)) return false
          if (fileNeedle && !row.filePath.toLowerCase().includes(fileNeedle)) return false
          if (row.inDegree < minDegree || row.inDegree > maxDegree) return false
          return true
        })

        const offset = Math.max(0, options.offset ?? 0)
        const limit = Math.max(1, Math.min(200, options.limit ?? 20))
        const total = filtered.length
        const page = filtered.slice(offset, offset + limit)

        return {
          results: page.map((row) => ({
            id: row.id,
            name: row.name,
            kind: row.kind,
            fileId: row.fileId,
            filePath: row.filePath,
            startLine: row.startLine,
            endLine: row.endLine,
            signature: row.signature,
            doc: row.doc,
            exported: row.exported === 1,
            inDegree: row.inDegree
          })),
          total,
          hasMore: offset + page.length < total,
          truncated: rows.length === MAX_SEARCH_GRAPH_CANDIDATES
        }
      })

    const architecture = (repoId: string): Effect.Effect<ArchitectureSummary, StoreError> =>
      Effect.gen(function* () {
        const languageRows = yield* sql<{ language: string; count: number }>`
          SELECT CASE WHEN language = '' THEN 'unknown' ELSE language END as language,
                 COUNT(*) as count
          FROM files WHERE repo_id = ${repoId}
          GROUP BY language ORDER BY count DESC;
        `.pipe(
          Effect.mapError(
            (e) => new StoreError({ message: "Architecture languages query failed", cause: e })
          )
        )

        const packageRows = yield* sql<{
          name: string
          files: number
          symbols: number
        }>`
          SELECT CASE WHEN instr(f.path, '/') = 0 THEN '.'
                      ELSE substr(f.path, 1, instr(f.path, '/') - 1) END as name,
                 COUNT(DISTINCT f.id) as files,
                 COUNT(s.id) as symbols
          FROM files f
          LEFT JOIN symbols s ON s.file_id = f.id
          WHERE f.repo_id = ${repoId}
          GROUP BY name
          ORDER BY symbols DESC, name ASC
          LIMIT 20;
        `.pipe(
          Effect.mapError(
            (e) => new StoreError({ message: "Architecture packages query failed", cause: e })
          )
        )

        const symbolRows = yield* sql<{
          id: string
          name: string
          kind: SymbolKind
          filePath: string
          startLine: number
          inDegree: number
        }>`
          SELECT s.id, s.name, s.kind, f.path as filePath, s.start_line as startLine,
                 (SELECT COUNT(*) FROM edges e WHERE e.dst_symbol_id = s.id) as inDegree
          FROM symbols s
          JOIN files f ON s.file_id = f.id
          WHERE f.repo_id = ${repoId}
          ORDER BY inDegree DESC, s.name ASC
          LIMIT 15;
        `.pipe(
          Effect.mapError(
            (e) => new StoreError({ message: "Architecture hotspots query failed", cause: e })
          )
        )

        const entryRows = yield* sql<{
          id: string
          name: string
          kind: SymbolKind
          filePath: string
          startLine: number
          inDegree: number
        }>`
          SELECT s.id, s.name, s.kind, f.path as filePath, s.start_line as startLine,
                 (SELECT COUNT(*) FROM edges e WHERE e.dst_symbol_id = s.id) as inDegree
          FROM symbols s
          JOIN files f ON s.file_id = f.id
          WHERE f.repo_id = ${repoId}
            AND s.exported = 1
            AND s.kind IN ('function', 'method')
            AND NOT EXISTS (
              SELECT 1 FROM edges e
              WHERE e.dst_symbol_id = s.id AND e.kind IN ('call', 'call_reference')
            )
          ORDER BY s.name ASC
          LIMIT 15;
        `.pipe(
          Effect.mapError(
            (e) => new StoreError({ message: "Architecture entry points query failed", cause: e })
          )
        )

        const totals = yield* sql<{ files: number; symbols: number; edges: number }>`
          SELECT
            (SELECT COUNT(*) FROM files WHERE repo_id = ${repoId}) as files,
            (SELECT COUNT(*) FROM symbols s JOIN files f ON s.file_id = f.id
              WHERE f.repo_id = ${repoId}) as symbols,
            (SELECT COUNT(*) FROM edges e JOIN symbols s ON e.src_symbol_id = s.id
              JOIN files f ON s.file_id = f.id WHERE f.repo_id = ${repoId}) as edges;
        `.pipe(
          Effect.mapError(
            (e) => new StoreError({ message: "Architecture totals query failed", cause: e })
          )
        )

        const languages: Record<string, number> = {}
        for (const row of languageRows) languages[row.language] = row.count

        return {
          repoId,
          files: totals[0]?.files ?? 0,
          symbols: totals[0]?.symbols ?? 0,
          edges: totals[0]?.edges ?? 0,
          languages,
          packages: packageRows,
          entryPoints: entryRows,
          hotspots: symbolRows
        }
      })

    const EDGE_KINDS_BY_MODE: Readonly<Record<TraceMode, readonly EdgeKind[] | undefined>> = {
      calls: ["call", "call_reference"],
      references: undefined,
      data_flow: ["call", "call_reference", "usage", "reference"],
      cross_file: undefined
    }

    const tracePath = (
      selector: string,
      options: TracePathOptions = {}
    ): Effect.Effect<TracePathResult | null, StoreError> =>
      Effect.gen(function* () {
        const startRows = yield* (
          selector.includes("#")
            ? sql<{
                id: string
                name: string
                kind: SymbolKind
                filePath: string
                startLine: number
                inDegree: number
              }>`
              SELECT s.id, s.name, s.kind, f.path as filePath, s.start_line as startLine,
                     (SELECT COUNT(*) FROM edges e WHERE e.dst_symbol_id = s.id) as inDegree
              FROM symbols s JOIN files f ON s.file_id = f.id
              WHERE s.id = ${selector} LIMIT 1;
            `
            : sql<{
                id: string
                name: string
                kind: SymbolKind
                filePath: string
                startLine: number
                inDegree: number
              }>`
              SELECT s.id, s.name, s.kind, f.path as filePath, s.start_line as startLine,
                     (SELECT COUNT(*) FROM edges e WHERE e.dst_symbol_id = s.id) as inDegree
              FROM symbols s JOIN files f ON s.file_id = f.id
              WHERE s.qualified_name = ${selector} OR s.name = ${selector}
              ORDER BY CASE WHEN s.qualified_name = ${selector} THEN 0 ELSE 1 END
              LIMIT 1;
            `
        ).pipe(
          Effect.mapError((e) => new StoreError({ message: "Trace path lookup failed", cause: e }))
        )

        const start = startRows[0]
        if (!start) return null

        const direction = options.direction ?? "both"
        const depth = Math.max(1, Math.min(6, Math.floor(options.depth ?? 2)))
        const mode = options.mode ?? "calls"
        const kinds = EDGE_KINDS_BY_MODE[mode]
        const kindClause = kinds ? sql`AND e.kind IN ${sql.in(kinds)}` : sql``
        const isSentinel = (id: string) => id.startsWith("symbol:") || id.startsWith("module:")

        const MAX_NODES = 300
        const visited = new Map<string, number>([[start.id, 0]])
        const collectedEdges = new Map<string, EdgeRecord>()
        let frontier = new Set<string>([start.id])
        let truncated = false

        for (let hop = 1; hop <= depth; hop++) {
          if (frontier.size === 0) break
          const ids = Array.from(frontier)
          const rows = yield* sql<EdgeRecord>`
            SELECT e.id, e.src_symbol_id as srcSymbolId, e.dst_symbol_id as dstSymbolId, e.kind
            FROM edges e
            WHERE (e.src_symbol_id IN ${sql.in(ids)} OR e.dst_symbol_id IN ${sql.in(ids)})
              ${kindClause};
          `.pipe(
            Effect.mapError((e) => new StoreError({ message: "Trace path edges failed", cause: e }))
          )

          const next = new Set<string>()
          const consider = (id: string) => {
            if (isSentinel(id) || visited.has(id)) return
            if (visited.size >= MAX_NODES) {
              truncated = true
              return
            }
            visited.set(id, hop)
            next.add(id)
          }

          for (const edge of rows) {
            const outMatches =
              (direction === "outbound" || direction === "both") && frontier.has(edge.srcSymbolId)
            const inMatches =
              (direction === "inbound" || direction === "both") && frontier.has(edge.dstSymbolId)
            if (!outMatches && !inMatches) continue
            collectedEdges.set(edge.id, edge)
            if (outMatches) consider(edge.dstSymbolId)
            if (inMatches) consider(edge.srcSymbolId)
          }

          frontier = next
        }

        const nodeIds = Array.from(visited.keys())
        const nodeRows = yield* sql<{
          id: string
          name: string
          kind: SymbolKind
          filePath: string
          startLine: number
          inDegree: number
        }>`
          SELECT s.id, s.name, s.kind, f.path as filePath, s.start_line as startLine,
                 (SELECT COUNT(*) FROM edges e WHERE e.dst_symbol_id = s.id) as inDegree
          FROM symbols s JOIN files f ON s.file_id = f.id
          WHERE s.id IN ${sql.in(nodeIds)};
        `.pipe(
          Effect.mapError((e) => new StoreError({ message: "Trace path nodes failed", cause: e }))
        )

        const nodes = nodeRows
          .map((row) => ({ ...row, hop: visited.get(row.id) ?? 0 }))
          .sort((a, b) => a.hop - b.hop || a.name.localeCompare(b.name))

        return {
          start,
          nodes,
          edges: Array.from(collectedEdges.values()).filter(
            (edge) => visited.has(edge.srcSymbolId) && visited.has(edge.dstSymbolId)
          ),
          truncated
        }
      })

    const getSymbolByQualifiedName = (
      qualifiedName: string,
      repoId?: string
    ): Effect.Effect<SymbolWithFile | null, StoreError> =>
      Effect.gen(function* () {
        const rows = yield* (
          repoId
            ? sql<{
                id: string
                name: string
                kind: SymbolKind
                fileId: string
                filePath: string
                startLine: number
                endLine: number
                signature: string
                exported: number
                doc: string
                inDegree: number
              }>`
                SELECT s.id, s.name, s.kind, s.file_id as fileId, f.path as filePath,
                       s.start_line as startLine, s.end_line as endLine, s.signature, s.exported, s.doc,
                       (SELECT COUNT(*) FROM edges e WHERE e.dst_symbol_id = s.id) as inDegree
                FROM symbols s
                JOIN files f ON s.file_id = f.id
                WHERE f.repo_id = ${repoId}
                  AND (s.qualified_name = ${qualifiedName} OR s.name = ${qualifiedName})
                ORDER BY CASE WHEN s.qualified_name = ${qualifiedName} THEN 0 ELSE 1 END
                LIMIT 1;
              `
            : sql<{
                id: string
                name: string
                kind: SymbolKind
                fileId: string
                filePath: string
                startLine: number
                endLine: number
                signature: string
                exported: number
                doc: string
                inDegree: number
              }>`
                SELECT s.id, s.name, s.kind, s.file_id as fileId, f.path as filePath,
                       s.start_line as startLine, s.end_line as endLine, s.signature, s.exported, s.doc,
                       (SELECT COUNT(*) FROM edges e WHERE e.dst_symbol_id = s.id) as inDegree
                FROM symbols s
                JOIN files f ON s.file_id = f.id
                WHERE s.qualified_name = ${qualifiedName} OR s.name = ${qualifiedName}
                ORDER BY CASE WHEN s.qualified_name = ${qualifiedName} THEN 0 ELSE 1 END
                LIMIT 1;
              `
        ).pipe(
          Effect.mapError(
            (e) => new StoreError({ message: "Qualified name lookup failed", cause: e })
          )
        )

        const row = rows[0]
        if (!row) return null
        return {
          id: row.id,
          name: row.name,
          kind: row.kind,
          fileId: row.fileId,
          filePath: row.filePath,
          startLine: row.startLine,
          endLine: row.endLine,
          signature: row.signature,
          doc: row.doc,
          exported: row.exported === 1,
          inDegree: row.inDegree
        }
      })

    const getSymbol = (
      symbolId: string
    ): Effect.Effect<SymbolDetails, StoreError | NotFoundError> =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          id: string
          name: string
          kind: SymbolKind
          fileId: string
          filePath: string
          startLine: number
          endLine: number
          signature: string
          exported: number
          doc: string
          inDegree: number
        }>`
          SELECT s.id, s.name, s.kind, s.file_id as fileId, f.path as filePath,
                 s.start_line as startLine, s.end_line as endLine, s.signature, s.exported, s.doc,
                 (SELECT COUNT(*) FROM edges e WHERE e.dst_symbol_id = s.id) as inDegree
          FROM symbols s
          JOIN files f ON s.file_id = f.id
          WHERE s.id = ${symbolId}
          LIMIT 1;
        `.pipe(
          Effect.mapError((e) => new StoreError({ message: "Failed to get symbol", cause: e }))
        )

        const sym = rows[0]
        if (!sym) {
          return yield* Effect.fail(new NotFoundError({ entity: "Symbol", id: symbolId }))
        }

        const outgoing = yield* sql<{
          id: string
          src_symbol_id: string
          dst_symbol_id: string
          kind: EdgeKind
          targetName?: string
          targetKind: SymbolKind
          targetFileId?: string
          targetFilePath?: string
          targetStartLine?: number
          targetEndLine?: number
          targetSignature?: string
          targetExported?: number
          targetDoc?: string
        }>`
          SELECT e.id, e.src_symbol_id, e.dst_symbol_id, e.kind,
                 ts.name as targetName, ts.kind as targetKind, ts.file_id as targetFileId,
                 tf.path as targetFilePath, ts.start_line as targetStartLine,
                 ts.end_line as targetEndLine, ts.signature as targetSignature, ts.doc as targetDoc,
                 ts.exported as targetExported
          FROM edges e
          LEFT JOIN symbols ts ON e.dst_symbol_id = ts.id
          LEFT JOIN files tf ON ts.file_id = tf.id
          WHERE e.src_symbol_id = ${symbolId};
        `.pipe(
          Effect.mapError(
            (e) => new StoreError({ message: "Failed to get outgoing edges", cause: e })
          )
        )

        const incoming = yield* sql<{
          id: string
          src_symbol_id: string
          dst_symbol_id: string
          kind: EdgeKind
          sourceName?: string
          sourceKind: SymbolKind
          sourceFileId?: string
          sourceFilePath?: string
          sourceStartLine?: number
          sourceEndLine?: number
          sourceSignature?: string
          sourceExported?: number
          sourceDoc?: string
        }>`
          SELECT e.id, e.src_symbol_id, e.dst_symbol_id, e.kind,
                 ss.name as sourceName, ss.kind as sourceKind, ss.file_id as sourceFileId,
                 sf.path as sourceFilePath, ss.start_line as sourceStartLine,
                 ss.end_line as sourceEndLine, ss.signature as sourceSignature, ss.doc as sourceDoc,
                 ss.exported as sourceExported
          FROM edges e
          LEFT JOIN symbols ss ON e.src_symbol_id = ss.id
          LEFT JOIN files sf ON ss.file_id = sf.id
          WHERE e.dst_symbol_id = ${symbolId};
        `.pipe(
          Effect.mapError(
            (e) => new StoreError({ message: "Failed to get incoming edges", cause: e })
          )
        )

        return {
          symbol: {
            id: sym.id,
            name: sym.name,
            kind: sym.kind,
            fileId: sym.fileId,
            filePath: sym.filePath,
            startLine: sym.startLine,
            endLine: sym.endLine,
            signature: sym.signature,
            doc: sym.doc,
            exported: sym.exported === 1,
            inDegree: sym.inDegree
          },
          outgoingEdges: outgoing.map((e) => ({
            id: e.id,
            srcSymbolId: e.src_symbol_id,
            dstSymbolId: e.dst_symbol_id,
            kind: e.kind,
            targetSymbol: e.targetName
              ? {
                  id: e.dst_symbol_id,
                  name: e.targetName,
                  kind: e.targetKind,
                  fileId: e.targetFileId ?? "",
                  filePath: e.targetFilePath ?? "",
                  startLine: e.targetStartLine ?? 0,
                  endLine: e.targetEndLine ?? 0,
                  signature: e.targetSignature ?? "",
                  doc: e.targetDoc ?? "",
                  exported: e.targetExported === 1
                }
              : undefined
          })),
          incomingEdges: incoming.map((e) => ({
            id: e.id,
            srcSymbolId: e.src_symbol_id,
            dstSymbolId: e.dst_symbol_id,
            kind: e.kind,
            sourceSymbol: e.sourceName
              ? {
                  id: e.src_symbol_id,
                  name: e.sourceName,
                  kind: e.sourceKind,
                  fileId: e.sourceFileId ?? "",
                  filePath: e.sourceFilePath ?? "",
                  startLine: e.sourceStartLine ?? 0,
                  endLine: e.sourceEndLine ?? 0,
                  signature: e.sourceSignature ?? "",
                  doc: e.sourceDoc ?? "",
                  exported: e.sourceExported === 1
                }
              : undefined
          }))
        }
      })

    const findReferences = (
      symbolId: string
    ): Effect.Effect<readonly ReferenceResult[], StoreError> =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          edgeId: string
          kind: EdgeKind
          sourceId: string
          sourceName: string
          sourceKind: SymbolKind
          sourceFileId: string
          sourceFilePath: string
          sourceStartLine: number
          sourceEndLine: number
          sourceSignature: string
          sourceExported: number
          sourceDoc: string
        }>`
          SELECT e.id as edgeId, e.kind,
                 s.id as sourceId, s.name as sourceName, s.kind as sourceKind,
                 s.file_id as sourceFileId, f.path as sourceFilePath,
                 s.start_line as sourceStartLine, s.end_line as sourceEndLine,
                 s.signature as sourceSignature, s.exported as sourceExported, s.doc as sourceDoc
          FROM edges e
          JOIN symbols s ON e.src_symbol_id = s.id
          JOIN files f ON s.file_id = f.id
          WHERE e.dst_symbol_id = ${symbolId};
        `.pipe(
          Effect.mapError(
            (e) => new StoreError({ message: "Find references query failed", cause: e })
          )
        )

        return rows.map((r) => ({
          edgeId: r.edgeId,
          kind: r.kind,
          sourceSymbol: {
            id: r.sourceId,
            name: r.sourceName,
            kind: r.sourceKind,
            fileId: r.sourceFileId,
            filePath: r.sourceFilePath,
            startLine: r.sourceStartLine,
            endLine: r.sourceEndLine,
            signature: r.sourceSignature,
            doc: r.sourceDoc,
            exported: r.sourceExported === 1
          }
        }))
      })

    const outlineFile = (
      repoIdOrPath: string,
      filePath: string
    ): Effect.Effect<readonly SymbolRecord[], StoreError | NotFoundError> =>
      Effect.gen(function* () {
        const normalizedPath = filePath.replace(/\\/g, "/").replace(/^\.\//, "")
        const rows = yield* sql<
          Omit<SymbolRecord, "exported" | "visibility" | "containerName"> & {
            exported: number
            visibility: string
            containerName: string
          }
        >`
          SELECT s.id, s.name, s.kind, s.file_id as fileId,
                 s.start_line as startLine, s.end_line as endLine,
                 s.signature, s.exported as exported, s.doc,
                 s.language, s.qualified_name as qualifiedName,
                 s.visibility, s.container_name as containerName
          FROM symbols s
          JOIN files f ON s.file_id = f.id
          JOIN repos r ON f.repo_id = r.id
          WHERE (f.path = ${normalizedPath} OR f.path LIKE ${`%/${normalizedPath}`})
            AND (r.id = ${repoIdOrPath} OR r.root_path = ${repoIdOrPath})
          ORDER BY s.start_line ASC;
        `.pipe(
          Effect.mapError((e) => new StoreError({ message: "Outline file query failed", cause: e }))
        )

        return rows.map((row) => ({
          ...row,
          exported: row.exported === 1,
          visibility:
            row.visibility === "public" ||
            row.visibility === "private" ||
            row.visibility === "protected" ||
            row.visibility === "internal" ||
            row.visibility === "package"
              ? row.visibility
              : undefined,
          containerName: row.containerName === "" ? undefined : row.containerName
        }))
      })

    const neighborhood = (
      symbolId: string,
      depth: number = 1
    ): Effect.Effect<NeighborhoodGraph, StoreError | NotFoundError> =>
      Effect.gen(function* () {
        const root = yield* sql<{ id: string }>`
          SELECT id FROM symbols WHERE id = ${symbolId} LIMIT 1;
        `.pipe(
          Effect.mapError((e) => new StoreError({ message: "Failed to look up symbol", cause: e }))
        )

        if (root.length === 0) {
          return yield* Effect.fail(new NotFoundError({ entity: "Symbol", id: symbolId }))
        }

        const MAX_NEIGHBORHOOD_DEPTH = 8
        const MAX_NEIGHBORHOOD_NODES = 500
        const safeDepth = Math.max(0, Math.min(MAX_NEIGHBORHOOD_DEPTH, Math.floor(depth)))

        // BFS to collect nodes and edges up to depth
        let currentFrontier = new Set<string>([symbolId])
        const visitedNodes = new Set<string>([symbolId])
        const collectedEdges = new Map<string, EdgeRecord>()
        let truncated = false

        for (let d = 0; d < safeDepth; d++) {
          if (currentFrontier.size === 0) break
          const frontierArray = Array.from(currentFrontier)

          // Find outgoing and incoming edges for frontier nodes
          const edges = yield* sql<EdgeRecord>`
            SELECT id, src_symbol_id as srcSymbolId, dst_symbol_id as dstSymbolId, kind
            FROM edges
            WHERE src_symbol_id IN ${sql.in(frontierArray)} OR dst_symbol_id IN ${sql.in(frontierArray)};
          `.pipe(
            Effect.mapError(
              (e) => new StoreError({ message: "Neighborhood edges query failed", cause: e })
            )
          )

          const nextFrontier = new Set<string>()
          for (const edge of edges) {
            collectedEdges.set(edge.id, edge)
            if (
              !visitedNodes.has(edge.srcSymbolId) &&
              !edge.srcSymbolId.startsWith("module:") &&
              !edge.srcSymbolId.startsWith("symbol:")
            ) {
              if (visitedNodes.size >= MAX_NEIGHBORHOOD_NODES) {
                truncated = true
              } else {
                visitedNodes.add(edge.srcSymbolId)
                nextFrontier.add(edge.srcSymbolId)
              }
            }
            if (
              !visitedNodes.has(edge.dstSymbolId) &&
              !edge.dstSymbolId.startsWith("module:") &&
              !edge.dstSymbolId.startsWith("symbol:")
            ) {
              if (visitedNodes.size >= MAX_NEIGHBORHOOD_NODES) {
                truncated = true
              } else {
                visitedNodes.add(edge.dstSymbolId)
                nextFrontier.add(edge.dstSymbolId)
              }
            }
          }
          currentFrontier = nextFrontier
        }

        const nodeIds = Array.from(visitedNodes)
        if (nodeIds.length === 0) {
          return { nodes: [], edges: [] }
        }

        const nodes = yield* sql<{
          id: string
          name: string
          kind: SymbolKind
          fileId: string
          filePath: string
          startLine: number
          endLine: number
          signature: string
          exported: number
          doc: string
          inDegree: number
        }>`
          SELECT s.id, s.name, s.kind, s.file_id as fileId, f.path as filePath,
                 s.start_line as startLine, s.end_line as endLine, s.signature, s.exported, s.doc,
                 (SELECT COUNT(*) FROM edges e WHERE e.dst_symbol_id = s.id) as inDegree
          FROM symbols s
          JOIN files f ON s.file_id = f.id
          WHERE s.id IN ${sql.in(nodeIds)};
        `.pipe(
          Effect.mapError(
            (e) => new StoreError({ message: "Failed to fetch neighborhood nodes", cause: e })
          )
        )

        return {
          nodes: nodes.map((n) => ({
            id: n.id,
            name: n.name,
            kind: n.kind,
            fileId: n.fileId,
            filePath: n.filePath,
            startLine: n.startLine,
            endLine: n.endLine,
            signature: n.signature,
            doc: n.doc,
            exported: n.exported === 1,
            inDegree: n.inDegree
          })),
          // Only return edges whose endpoints are part of the returned graph.
          edges: Array.from(collectedEdges.values()).filter(
            (edge) => visitedNodes.has(edge.srcSymbolId) && visitedNodes.has(edge.dstSymbolId)
          ),
          ...(truncated ? { truncated: true } : {})
        }
      })

    const repoMap = (
      repoId: string,
      maxTokens: number = 2000
    ): Effect.Effect<string, StoreError | NotFoundError> =>
      Effect.gen(function* () {
        const symbols = yield* sql<{
          id: string
          name: string
          kind: SymbolKind
          signature: string
          startLine: number
          filePath: string
          inDegree: number
        }>`
          SELECT s.id, s.name, s.kind, s.signature, s.start_line as startLine,
                 f.path as filePath,
                 (SELECT COUNT(*) FROM edges e WHERE e.dst_symbol_id = s.id) as inDegree
          FROM symbols s
          JOIN files f ON s.file_id = f.id
          WHERE f.repo_id = ${repoId} AND s.exported = 1
          ORDER BY inDegree DESC, s.start_line ASC;
        `.pipe(
          Effect.mapError((e) => new StoreError({ message: "Repo map query failed", cause: e }))
        )

        if (symbols.length === 0) {
          return "# Repository has no exported symbols indexed yet."
        }

        // Group by file and rank files by sum of inDegree
        type SymType = (typeof symbols)[number]
        const filesMap = new Map<string, { totalRank: number; symbols: SymType[] }>()
        for (const sym of symbols) {
          const entry = filesMap.get(sym.filePath) ?? { totalRank: 0, symbols: [] }
          entry.totalRank += Math.max(1, sym.inDegree)
          entry.symbols.push(sym)
          filesMap.set(sym.filePath, entry)
        }

        const sortedFiles = Array.from(filesMap.entries()).sort(
          (a, b) => b[1].totalRank - a[1].totalRank
        )

        const lines: string[] = []
        let estimatedTokens = 0

        for (const [filePath, { symbols: fileSymbols }] of sortedFiles) {
          const header = `${filePath}:`
          const fileLines = [header]

          for (const s of fileSymbols) {
            fileLines.push(`  ${s.signature}`)
          }

          const fileBlock = fileLines.join("\n")
          const blockTokens = Math.ceil(fileBlock.length / 4)

          if (estimatedTokens + blockTokens > maxTokens && lines.length > 0) {
            break
          }

          lines.push(fileBlock)
          estimatedTokens += blockTokens
        }

        return lines.join("\n\n")
      })

    type MutableFileEdge = {
      srcFileId: string
      srcPath: string
      dstFileId: string
      dstPath: string
      weight: number
      kinds: string[]
    }

    const fileGraph = (repoId: string): Effect.Effect<FileGraph, StoreError | NotFoundError> =>
      Effect.gen(function* () {
        const fileRows = yield* sql<{
          id: string
          path: string
          symbolCount: number
          inDegree: number
        }>`
          SELECT f.id, f.path,
                 COUNT(s.id) as symbolCount,
                 (SELECT COUNT(DISTINCT e.id)
                  FROM edges e
                  JOIN symbols ds ON e.dst_symbol_id = ds.id
                  JOIN symbols ss ON e.src_symbol_id = ss.id
                  WHERE ds.file_id = f.id AND ss.file_id != f.id) as inDegree
          FROM files f
          LEFT JOIN symbols s ON s.file_id = f.id
          WHERE f.repo_id = ${repoId}
          GROUP BY f.id, f.path;
        `.pipe(
          Effect.mapError(
            (e) => new StoreError({ message: "File graph nodes query failed", cause: e })
          )
        )

        const edgeRows = yield* sql<{
          srcFileId: string
          srcPath: string
          dstFileId: string
          dstPath: string
          weight: number
          kindsStr: string
        }>`
          SELECT sf.id as srcFileId, sf.path as srcPath,
                 df.id as dstFileId, df.path as dstPath,
                 COUNT(e.id) as weight,
                 GROUP_CONCAT(DISTINCT e.kind) as kindsStr
          FROM edges e
          JOIN symbols src_s ON e.src_symbol_id = src_s.id
          JOIN files sf ON src_s.file_id = sf.id
          JOIN symbols dst_s ON e.dst_symbol_id = dst_s.id
          JOIN files df ON dst_s.file_id = df.id
          WHERE sf.repo_id = ${repoId} AND df.repo_id = ${repoId} AND sf.id != df.id
          GROUP BY sf.id, df.id;
        `.pipe(
          Effect.mapError(
            (e) => new StoreError({ message: "File graph edges query failed", cause: e })
          )
        )

        const importRows = yield* sql<{
          srcFileId: string
          srcPath: string
          dstFileId: string
          dstPath: string
          weight: number
        }>`
          SELECT fe.src_file_id as srcFileId, sf.path as srcPath,
                 fe.dst_file_id as dstFileId, df.path as dstPath,
                 COUNT(*) as weight
          FROM file_edges fe
          JOIN files sf ON fe.src_file_id = sf.id
          JOIN files df ON fe.dst_file_id = df.id
          WHERE fe.repo_id = ${repoId} AND fe.kind = 'imports' AND fe.dst_file_id IS NOT NULL
          GROUP BY fe.src_file_id, fe.dst_file_id;
        `.pipe(
          Effect.mapError(
            (e) => new StoreError({ message: "File graph imports query failed", cause: e })
          )
        )

        const edgesByPair = new Map<string, MutableFileEdge>()
        for (const row of edgeRows) {
          edgesByPair.set(`${row.srcFileId}->${row.dstFileId}`, {
            srcFileId: row.srcFileId,
            srcPath: row.srcPath,
            dstFileId: row.dstFileId,
            dstPath: row.dstPath,
            weight: row.weight,
            kinds: (row.kindsStr ?? "").split(",").filter(Boolean)
          })
        }
        for (const row of importRows) {
          const key = `${row.srcFileId}->${row.dstFileId}`
          const existing = edgesByPair.get(key)
          if (existing) {
            existing.weight += row.weight
            if (!existing.kinds.includes("imports")) existing.kinds.push("imports")
          } else {
            edgesByPair.set(key, {
              srcFileId: row.srcFileId,
              srcPath: row.srcPath,
              dstFileId: row.dstFileId,
              dstPath: row.dstPath,
              weight: row.weight,
              kinds: ["imports"]
            })
          }
        }

        return {
          nodes: fileRows.map((r) => ({
            id: r.id,
            path: r.path,
            symbolCount: r.symbolCount,
            inDegree: r.inDegree
          })),
          edges: Array.from(edgesByPair.values())
        }
      })

    return {
      searchSymbols,
      getSymbol,
      getSymbolByQualifiedName,
      searchGraph,
      architecture,
      tracePath,
      findReferences,
      outlineFile,
      neighborhood,
      repoMap,
      fileGraph
    }
  })
)
