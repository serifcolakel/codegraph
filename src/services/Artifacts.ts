import { gunzipSync, gzipSync } from "node:zlib"
import { FileSystem, Path } from "@effect/platform"
import * as SqlClient from "@effect/sql/SqlClient"
import { Context, Effect, Layer } from "effect"
import { StoreError } from "../domain/errors.js"
import { tokenizeIdentifier } from "../domain/naming.js"
import { IndexStore } from "./IndexStore.js"

const ARTIFACT_VERSION = 1

export interface ArtifactFile {
  readonly path: string
  readonly hash: string
  readonly language: string
  readonly parseStatus: string
  readonly sizeBytes: number
}

export interface ArtifactSymbol {
  readonly id: string
  readonly filePath: string
  readonly name: string
  readonly kind: string
  readonly startLine: number
  readonly endLine: number
  readonly signature: string
  readonly exported: number
  readonly doc: string
  readonly language: string
  readonly qualifiedName: string
  readonly visibility: string
  readonly containerName: string
  readonly cyclomatic: number
  readonly cognitive: number
  readonly loopDepth: number
  readonly loopCount: number
  readonly linearScanInLoop: number
  readonly allocInLoop: number
  readonly recursive: number
  readonly paramCount: number
}

export interface ArtifactEdge {
  readonly src: string
  readonly dst: string
  readonly kind: string
}

export interface ArtifactFileEdge {
  readonly srcPath: string
  readonly dstPath?: string
  readonly specifier: string
  readonly kind: string
  readonly srcLine: number
}

export interface GraphArtifact {
  readonly version: number
  readonly createdAt: string
  readonly repoName: string
  readonly files: readonly ArtifactFile[]
  readonly symbols: readonly ArtifactSymbol[]
  readonly edges: readonly ArtifactEdge[]
  readonly fileEdges: readonly ArtifactFileEdge[]
}

export interface ExportResult {
  readonly path: string
  readonly files: number
  readonly symbols: number
  readonly edges: number
  readonly bytes: number
}

export interface ImportResult {
  readonly repoId: string
  readonly files: number
  readonly symbols: number
  readonly edges: number
}

export interface Artifacts {
  readonly exportRepo: (
    repoId: string,
    outputPath: string
  ) => Effect.Effect<ExportResult, StoreError>
  readonly importRepo: (
    inputPath: string,
    targetRoot: string,
    options?: { readonly force?: boolean }
  ) => Effect.Effect<ImportResult, StoreError>
}

export const Artifacts = Context.GenericTag<Artifacts>("@codegraph/Artifacts")

export const ArtifactsLive = Layer.effect(
  Artifacts,
  Effect.gen(function* () {
    const store = yield* IndexStore
    const sql = yield* SqlClient.SqlClient
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    const exportRepo = (
      repoId: string,
      outputPath: string
    ): Effect.Effect<ExportResult, StoreError> =>
      Effect.gen(function* () {
        const repo = yield* store.getRepo(repoId)
        if (!repo) {
          return yield* Effect.fail(new StoreError({ message: `Repository not found: ${repoId}` }))
        }

        const fileRows = yield* sql<{
          path: string
          hash: string
          language: string
          parseStatus: string
          sizeBytes: number
        }>`
          SELECT path, hash, language, parse_status as parseStatus, size_bytes as sizeBytes
          FROM files WHERE repo_id = ${repo.id} ORDER BY path ASC;
        `.pipe(
          Effect.mapError((e) => new StoreError({ message: "Failed to export files", cause: e }))
        )

        const symbolRows = yield* sql<ArtifactSymbol>`
          SELECT s.id, f.path as filePath, s.name, s.kind, s.start_line as startLine,
                 s.end_line as endLine, s.signature, s.exported, s.doc, s.language,
                 s.qualified_name as qualifiedName, s.visibility, s.container_name as containerName,
                 s.cyclomatic, s.cognitive, s.loop_depth as loopDepth, s.loop_count as loopCount,
                 s.linear_scan_in_loop as linearScanInLoop, s.alloc_in_loop as allocInLoop,
                 s.recursive, s.param_count as paramCount
          FROM symbols s
          JOIN files f ON s.file_id = f.id
          WHERE f.repo_id = ${repo.id};
        `.pipe(
          Effect.mapError((e) => new StoreError({ message: "Failed to export symbols", cause: e }))
        )

        const edgeRows = yield* sql<ArtifactEdge>`
          SELECT e.src_symbol_id as src, e.dst_symbol_id as dst, e.kind
          FROM edges e
          JOIN symbols s ON e.src_symbol_id = s.id
          JOIN files f ON s.file_id = f.id
          WHERE f.repo_id = ${repo.id};
        `.pipe(
          Effect.mapError((e) => new StoreError({ message: "Failed to export edges", cause: e }))
        )

        const fileEdgeRows = yield* sql<ArtifactFileEdge>`
          SELECT sf.path as srcPath, df.path as dstPath, fe.specifier, fe.kind,
                 fe.src_line as srcLine
          FROM file_edges fe
          JOIN files sf ON fe.src_file_id = sf.id
          LEFT JOIN files df ON fe.dst_file_id = df.id
          WHERE fe.repo_id = ${repo.id};
        `.pipe(
          Effect.mapError(
            (e) => new StoreError({ message: "Failed to export file imports", cause: e })
          )
        )

        const artifact: GraphArtifact = {
          version: ARTIFACT_VERSION,
          createdAt: repo.indexedAt ?? new Date().toISOString(),
          repoName: repo.name,
          files: fileRows,
          symbols: symbolRows,
          edges: edgeRows,
          fileEdges: fileEdgeRows.map((row) => ({
            srcPath: row.srcPath,
            ...(row.dstPath ? { dstPath: row.dstPath } : {}),
            specifier: row.specifier,
            kind: row.kind,
            srcLine: row.srcLine
          }))
        }

        const compressed = gzipSync(Buffer.from(JSON.stringify(artifact)), { level: 9 })
        const resolved = path.resolve(outputPath)
        yield* fs
          .makeDirectory(path.dirname(resolved), { recursive: true })
          .pipe(
            Effect.mapError(
              (e) => new StoreError({ message: "Failed to create artifact directory", cause: e })
            )
          )
        yield* fs
          .writeFile(resolved, compressed)
          .pipe(
            Effect.mapError(
              (e) => new StoreError({ message: "Failed to write artifact", cause: e })
            )
          )

        return {
          path: resolved,
          files: artifact.files.length,
          symbols: artifact.symbols.length,
          edges: artifact.edges.length,
          bytes: compressed.byteLength
        }
      })

    const importRepo = (
      inputPath: string,
      targetRoot: string,
      options: { readonly force?: boolean } = {}
    ): Effect.Effect<ImportResult, StoreError> =>
      Effect.gen(function* () {
        const resolved = path.resolve(inputPath)
        const bytes = yield* fs
          .readFile(resolved)
          .pipe(
            Effect.mapError((e) => new StoreError({ message: "Failed to read artifact", cause: e }))
          )

        let artifact: GraphArtifact
        try {
          artifact = JSON.parse(gunzipSync(bytes).toString("utf8")) as GraphArtifact
        } catch (error) {
          return yield* Effect.fail(
            new StoreError({ message: "Invalid artifact file", cause: error })
          )
        }
        if (artifact.version !== ARTIFACT_VERSION) {
          return yield* Effect.fail(
            new StoreError({
              message: `Unsupported artifact version ${artifact.version}; expected ${ARTIFACT_VERSION}`
            })
          )
        }

        const repo = yield* store.getOrCreateRepo(path.resolve(targetRoot), artifact.repoName)
        const existing = yield* store.getFiles(repo.id)
        if (existing.size > 0) {
          if (!options.force) {
            return yield* Effect.fail(
              new StoreError({
                message: `Repository already indexed (${repo.name}); re-run with force to replace it`
              })
            )
          }
          yield* store.deleteFiles(Array.from(existing.values()).map((file) => file.id))
        }

        const fileMap = new Map<string, string>()
        const symbolMap = new Map<string, string>()

        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              for (const file of artifact.files) {
                const fileId = `${repo.id}:${file.path}`
                fileMap.set(file.path, fileId)
                yield* sql`
                  INSERT OR REPLACE INTO files (
                    id, path, hash, repo_id, language, parse_status, size_bytes
                  )
                  VALUES (
                    ${fileId}, ${file.path}, ${file.hash}, ${repo.id}, ${file.language},
                    ${file.parseStatus}, ${file.sizeBytes}
                  );
                `
              }

              for (const symbol of artifact.symbols) {
                const fileId = fileMap.get(symbol.filePath)
                if (!fileId) continue
                const symbolId = `${fileId}#${symbol.name}:${symbol.startLine}`
                symbolMap.set(symbol.id, symbolId)
                yield* sql`
                  INSERT OR REPLACE INTO symbols (
                    id, name, kind, file_id, start_line, end_line, signature, exported, doc,
                    language, qualified_name, visibility, container_name, cyclomatic, cognitive,
                    loop_depth, loop_count, linear_scan_in_loop, alloc_in_loop, recursive, param_count
                  )
                  VALUES (
                    ${symbolId}, ${symbol.name}, ${symbol.kind}, ${fileId}, ${symbol.startLine},
                    ${symbol.endLine}, ${symbol.signature}, ${symbol.exported}, ${symbol.doc},
                    ${symbol.language}, ${symbol.qualifiedName}, ${symbol.visibility},
                    ${symbol.containerName}, ${symbol.cyclomatic}, ${symbol.cognitive},
                    ${symbol.loopDepth}, ${symbol.loopCount}, ${symbol.linearScanInLoop},
                    ${symbol.allocInLoop}, ${symbol.recursive}, ${symbol.paramCount}
                  );
                `
                yield* sql`
                  INSERT OR REPLACE INTO symbols_fts (symbol_id, name, signature, doc, tokens)
                  VALUES (
                    ${symbolId}, ${symbol.name}, ${symbol.signature}, ${symbol.doc},
                    ${tokenizeIdentifier(`${symbol.name} ${symbol.qualifiedName}`)}
                  );
                `
              }

              for (const edge of artifact.edges) {
                const src = symbolMap.get(edge.src) ?? edge.src
                const dst = symbolMap.get(edge.dst) ?? edge.dst
                if (!src || src.startsWith("symbol:") || src.startsWith("module:")) continue
                yield* sql`
                  INSERT OR IGNORE INTO edges (id, src_symbol_id, dst_symbol_id, kind)
                  VALUES (${`edge_${src}->${dst}:${edge.kind}`}, ${src}, ${dst}, ${edge.kind});
                `
              }

              for (const fileEdge of artifact.fileEdges) {
                const srcFileId = fileMap.get(fileEdge.srcPath)
                if (!srcFileId) continue
                const dstFileId = fileEdge.dstPath ? fileMap.get(fileEdge.dstPath) : undefined
                const id = dstFileId
                  ? `fileimport_${srcFileId}->${dstFileId}:${fileEdge.srcLine}`
                  : `import_${srcFileId}->${fileEdge.specifier}:${fileEdge.srcLine}`
                yield* sql`
                  INSERT OR IGNORE INTO file_edges (
                    id, repo_id, src_file_id, dst_file_id, specifier, kind, src_line
                  )
                  VALUES (
                    ${id}, ${repo.id}, ${srcFileId}, ${dstFileId ?? null}, ${fileEdge.specifier},
                    ${fileEdge.kind}, ${fileEdge.srcLine}
                  );
                `
              }
            })
          )
          .pipe(
            Effect.mapError(
              (e) => new StoreError({ message: "Failed to import artifact data", cause: e })
            )
          )

        yield* store.markRepoIndexed(repo.id, artifact.createdAt, 0)
        yield* store.ensureVectors(repo.id)

        return {
          repoId: repo.id,
          files: artifact.files.length,
          symbols: artifact.symbols.length,
          edges: artifact.edges.length
        }
      })

    return { exportRepo, importRepo }
  })
)
