import * as SqlClient from "@effect/sql/SqlClient"
import { Context, Effect, Layer } from "effect"
import { StoreError } from "../domain/errors.js"

export interface CrossRepoEndpoint {
  readonly repoId: string
  readonly repoName: string
  readonly symbolId: string
  readonly name: string
  readonly filePath: string
}

export interface CrossRepoLink {
  readonly id: string
  readonly kind: "http" | "async"
  readonly confidence: number
  readonly source: CrossRepoEndpoint
  readonly target: CrossRepoEndpoint
}

export interface CrossRepoLinkResult {
  readonly http: number
  readonly async: number
  readonly total: number
}

export interface CrossRepo {
  readonly link: () => Effect.Effect<CrossRepoLinkResult, StoreError>
  readonly list: (repoId?: string) => Effect.Effect<readonly CrossRepoLink[], StoreError>
}

export const CrossRepo = Context.GenericTag<CrossRepo>("@codegraph/CrossRepo")

interface EndpointRow {
  readonly symbolId: string
  readonly name: string
  readonly kind: string
  readonly repoId: string
  readonly repoName: string
  readonly filePath: string
}

const normalizeRoute = (name: string): string => {
  const [method, ...rest] = name.split(" ")
  const path = rest.join(" ")
  const normalized = path
    .replace(/\{[^}]+\}/g, ":param")
    .replace(/:[A-Za-z_]\w*/g, ":param")
    .replace(/\/+$/, "")
  return `${method ?? ""} ${normalized || "/"}`
}

export const CrossRepoLive = Layer.effect(
  CrossRepo,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const link = (): Effect.Effect<CrossRepoLinkResult, StoreError> =>
      Effect.gen(function* () {
        const rows = yield* sql<EndpointRow>`
          SELECT s.id as symbolId, s.name, s.kind, f.repo_id as repoId, r.name as repoName,
                 f.path as filePath
          FROM symbols s
          JOIN files f ON s.file_id = f.id
          JOIN repos r ON f.repo_id = r.id
          WHERE s.kind IN ('route', 'channel');
        `.pipe(
          Effect.mapError(
            (e) => new StoreError({ message: "Failed to load cross-repo endpoints", cause: e })
          )
        )

        const groups = new Map<string, Map<string, EndpointRow>>()
        for (const row of rows) {
          const key =
            row.kind === "route" ? `http:${normalizeRoute(row.name)}` : `async:${row.name}`
          const byRepo = groups.get(key) ?? new Map<string, EndpointRow>()
          if (!byRepo.has(row.repoId)) byRepo.set(row.repoId, row)
          groups.set(key, byRepo)
        }

        const links: Array<{
          id: string
          src: EndpointRow
          dst: EndpointRow
          kind: "http" | "async"
          confidence: number
        }> = []

        for (const [key, byRepo] of groups) {
          if (byRepo.size < 2) continue
          const kind = key.startsWith("http:") ? "http" : "async"
          const confidence = kind === "http" ? 0.6 : 0.8
          const entries = Array.from(byRepo.values())
          for (const src of entries) {
            for (const dst of entries) {
              if (src.repoId === dst.repoId) continue
              links.push({
                id: `cross_${kind}_${src.symbolId}->${dst.symbolId}`,
                src,
                dst,
                kind,
                confidence
              })
            }
          }
        }

        const createdAt = new Date().toISOString()
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`DELETE FROM cross_repo_edges;`
              for (const entry of links) {
                yield* sql`
                  INSERT OR REPLACE INTO cross_repo_edges (
                    id, src_symbol_id, dst_symbol_id, kind, confidence, created_at
                  )
                  VALUES (
                    ${entry.id}, ${entry.src.symbolId}, ${entry.dst.symbolId},
                    ${entry.kind}, ${entry.confidence}, ${createdAt}
                  );
                `
              }
            })
          )
          .pipe(
            Effect.mapError(
              (e) => new StoreError({ message: "Failed to store cross-repo links", cause: e })
            )
          )

        return {
          http: links.filter((entry) => entry.kind === "http").length,
          async: links.filter((entry) => entry.kind === "async").length,
          total: links.length
        }
      })

    const list = (repoId?: string): Effect.Effect<readonly CrossRepoLink[], StoreError> =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          id: string
          kind: "http" | "async"
          confidence: number
          srcSymbolId: string
          srcName: string
          srcPath: string
          srcRepoId: string
          srcRepoName: string
          dstSymbolId: string
          dstName: string
          dstPath: string
          dstRepoId: string
          dstRepoName: string
        }>`
          SELECT c.id, c.kind, c.confidence,
                 ss.id as srcSymbolId, ss.name as srcName, sf.path as srcPath,
                 sr.id as srcRepoId, sr.name as srcRepoName,
                 ds.id as dstSymbolId, ds.name as dstName, df.path as dstPath,
                 dr.id as dstRepoId, dr.name as dstRepoName
          FROM cross_repo_edges c
          JOIN symbols ss ON c.src_symbol_id = ss.id
          JOIN files sf ON ss.file_id = sf.id
          JOIN repos sr ON sf.repo_id = sr.id
          JOIN symbols ds ON c.dst_symbol_id = ds.id
          JOIN files df ON ds.file_id = df.id
          JOIN repos dr ON df.repo_id = dr.id
          ${repoId ? sql`WHERE sr.id = ${repoId} OR dr.id = ${repoId}` : sql``}
          ORDER BY c.kind ASC, srcRepoName ASC, srcName ASC;
        `.pipe(
          Effect.mapError(
            (e) => new StoreError({ message: "Failed to list cross-repo links", cause: e })
          )
        )

        return rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          confidence: row.confidence,
          source: {
            repoId: row.srcRepoId,
            repoName: row.srcRepoName,
            symbolId: row.srcSymbolId,
            name: row.srcName,
            filePath: row.srcPath
          },
          target: {
            repoId: row.dstRepoId,
            repoName: row.dstRepoName,
            symbolId: row.dstSymbolId,
            name: row.dstName,
            filePath: row.dstPath
          }
        }))
      })

    return { link, list }
  })
)
