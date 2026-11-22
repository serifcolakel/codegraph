import { FileSystem, Path } from "@effect/platform"
import { Context, Effect, Layer } from "effect"
import { appConfig } from "../domain/config.js"
import { type ParseError, type StoreError, WalkError } from "../domain/errors.js"
import type { FileScanResult, IndexReport } from "../domain/models.js"
import { FileWalker } from "./FileWalker.js"
import { IndexStore } from "./IndexStore.js"
import { collectPackageMappings } from "./manifest.js"
import { Parser } from "./Parser.js"

export interface IndexerOptions {
  readonly force?: boolean
  readonly name?: string
}

export interface Indexer {
  readonly indexRepo: (
    repoPath: string,
    options?: IndexerOptions
  ) => Effect.Effect<IndexReport, WalkError | ParseError | StoreError>
}

export const Indexer = Context.GenericTag<Indexer>("@codegraph/Indexer")

export const IndexerLive = Layer.effect(
  Indexer,
  Effect.gen(function* () {
    const walker = yield* FileWalker
    const parser = yield* Parser
    const store = yield* IndexStore
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const config = yield* appConfig

    const indexRepo = (
      repoPath: string,
      options: IndexerOptions = {}
    ): Effect.Effect<IndexReport, WalkError | ParseError | StoreError> =>
      Effect.gen(function* () {
        const startTime = Date.now()
        yield* Effect.logInfo(`Starting indexing for repository at ${repoPath}`)

        // 1. Ensure schema is initialized
        yield* store.initSchema()

        // 2. Get or create repo
        const resolvedPath = path.resolve(repoPath)
        const repo = yield* store.getOrCreateRepo(resolvedPath, options.name)
        yield* Effect.logInfo(`Repository record loaded: ${repo.name} (${repo.id})`)

        // 3. Walk repository files
        const scannedFiles: readonly FileScanResult[] = yield* walker
          .walk(resolvedPath, config.ignoreGlobs)
          .pipe(Effect.withSpan("FileWalker.walk"))

        yield* Effect.logInfo(`Discovered ${scannedFiles.length} candidate files in ${repo.name}`)

        // 4. Retrieve existing file records to calculate diff
        const existingFiles = yield* store.getFiles(repo.id)
        const scannedPathSet = new Set<string>()

        const filesToProcess: FileScanResult[] = []
        const skippedFiles: FileScanResult[] = []
        let filesSkipped = 0

        for (const scanned of scannedFiles) {
          scannedPathSet.add(scanned.path)
          const existing = existingFiles.get(scanned.path)

          if (!options.force && existing && existing.hash === scanned.hash) {
            filesSkipped++
            skippedFiles.push(scanned)
          } else {
            filesToProcess.push(scanned)
          }
        }

        // Identify deleted files
        const deletedFileIds: string[] = []
        for (const [existingPath, record] of existingFiles.entries()) {
          if (!scannedPathSet.has(existingPath)) {
            deletedFileIds.push(record.id)
          }
        }

        if (deletedFileIds.length > 0) {
          yield* store.deleteFiles(deletedFileIds).pipe(Effect.withSpan("IndexStore.deleteFiles"))
          yield* Effect.logInfo(`Removed ${deletedFileIds.length} deleted files from index`)
        }

        yield* Effect.logInfo(
          `Files to process: ${filesToProcess.length}, skipped: ${filesSkipped}, deleted: ${deletedFileIds.length}`
        )

        // 5. Process changed/new files in parallel with bounded concurrency
        yield* Effect.forEach(
          filesToProcess,
          (scanned) =>
            Effect.gen(function* () {
              const content = yield* fs.readFileString(scanned.absolutePath).pipe(
                Effect.mapError(
                  (e) =>
                    new WalkError({
                      message: `Failed to read file ${scanned.absolutePath}`,
                      cause: e
                    })
                )
              )

              const parsed = yield* parser.parse(scanned.path, content)
              yield* store.saveFileIndex(
                repo.id,
                scanned.path,
                scanned.hash,
                scanned.sizeBytes,
                parsed
              )
            }),
          { concurrency: config.concurrency }
        ).pipe(Effect.withSpan("Indexer.parseAndStoreFiles"))

        // Backfill sizes and vectors for unchanged files so migrated databases
        // and incremental re-indexes report accurate totals and semantics.
        yield* store.ensureVectors(repo.id).pipe(Effect.withSpan("IndexStore.ensureVectors"))
        yield* store
          .updateFileSizes(
            repo.id,
            skippedFiles.map((file) => ({ path: file.path, sizeBytes: file.sizeBytes }))
          )
          .pipe(Effect.withSpan("IndexStore.updateFileSizes"))

        // 6. Cross-file edge resolution
        const packageMappings = yield* collectPackageMappings(fs, path, resolvedPath)
        const resolvedEdgesCount = yield* store
          .resolveEdges(repo.id, packageMappings)
          .pipe(Effect.withSpan("IndexStore.resolveEdges"))

        const durationMs = Date.now() - startTime
        const indexedAt = new Date().toISOString()
        yield* store
          .markRepoIndexed(repo.id, indexedAt, durationMs)
          .pipe(Effect.withSpan("IndexStore.markRepoIndexed"))
        const stats = yield* store.getStats(repo.id)
        const coverage = yield* store
          .getCoverage(repo.id)
          .pipe(Effect.withSpan("IndexStore.getCoverage"))
        yield* store
          .saveSnapshot(repo.id, indexedAt, stats, coverage)
          .pipe(Effect.withSpan("IndexStore.saveSnapshot"))

        yield* Effect.logInfo(
          `Indexing completed in ${durationMs}ms: ${stats.files} files, ${stats.symbols} symbols, ${stats.edges} edges (resolved ${resolvedEdgesCount} inter-file edges)`
        )

        return {
          repoId: repo.id,
          repoName: repo.name,
          filesIndexed: filesToProcess.length,
          filesSkipped,
          filesDeleted: deletedFileIds.length,
          symbolsCount: stats.symbols,
          edgesCount: stats.edges,
          durationMs,
          coverage
        }
      }).pipe(Effect.withSpan("Indexer.indexRepo"))

    return { indexRepo }
  })
)
