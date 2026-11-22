import { Path } from "@effect/platform"
import { Context, Effect, Layer } from "effect"
import { appConfig } from "../domain/config.js"
import { NotFoundError, type StoreError, type WalkError } from "../domain/errors.js"
import { FileWalker } from "./FileWalker.js"
import { IndexStore } from "./IndexStore.js"

export interface FreshnessSample {
  readonly path: string
}

export interface FreshnessReport {
  readonly repoId: string
  readonly repoName: string
  readonly rootPath: string
  readonly indexedAt?: string
  readonly checkedAt: string
  readonly stale: boolean
  readonly files: {
    readonly indexed: number
    readonly scanned: number
    readonly unchanged: number
    readonly added: number
    readonly modified: number
    readonly deleted: number
  }
  readonly samples: {
    readonly added: readonly FreshnessSample[]
    readonly modified: readonly FreshnessSample[]
    readonly deleted: readonly FreshnessSample[]
  }
}

export interface Freshness {
  readonly check: (
    repoId: string
  ) => Effect.Effect<FreshnessReport, StoreError | WalkError | NotFoundError>
}

export const Freshness = Context.GenericTag<Freshness>("@codegraph/Freshness")

const MAX_SAMPLES = 10

export const FreshnessLive = Layer.effect(
  Freshness,
  Effect.gen(function* () {
    const store = yield* IndexStore
    const walker = yield* FileWalker
    const path = yield* Path.Path
    const config = yield* appConfig

    const check = (
      repoId: string
    ): Effect.Effect<FreshnessReport, StoreError | WalkError | NotFoundError> =>
      Effect.gen(function* () {
        const repo = yield* store.getRepo(repoId)
        if (!repo) {
          return yield* Effect.fail(new NotFoundError({ entity: "Repository", id: repoId }))
        }

        const scanned = yield* walker.walk(path.resolve(repo.rootPath), config.ignoreGlobs)
        const indexed = yield* store.getFiles(repo.id)
        const scannedByPath = new Map(scanned.map((file) => [file.path, file.hash]))

        const added: FreshnessSample[] = []
        const modified: FreshnessSample[] = []
        const deleted: FreshnessSample[] = []
        let unchanged = 0

        for (const [filePath, hash] of scannedByPath) {
          const existing = indexed.get(filePath)
          if (!existing) {
            if (added.length < MAX_SAMPLES) added.push({ path: filePath })
            continue
          }
          if (existing.hash !== hash) {
            if (modified.length < MAX_SAMPLES) modified.push({ path: filePath })
          } else {
            unchanged += 1
          }
        }
        for (const filePath of indexed.keys()) {
          if (!scannedByPath.has(filePath) && deleted.length < MAX_SAMPLES) {
            deleted.push({ path: filePath })
          }
        }

        const addedCount = scanned.filter((file) => !indexed.has(file.path)).length
        const modifiedCount = scanned.filter((file) => {
          const existing = indexed.get(file.path)
          return existing !== undefined && existing.hash !== file.hash
        }).length
        const deletedCount = Array.from(indexed.keys()).filter(
          (filePath) => !scannedByPath.has(filePath)
        ).length

        return {
          repoId: repo.id,
          repoName: repo.name,
          rootPath: repo.rootPath,
          ...(repo.indexedAt ? { indexedAt: repo.indexedAt } : {}),
          checkedAt: new Date().toISOString(),
          stale: addedCount + modifiedCount + deletedCount > 0,
          files: {
            indexed: indexed.size,
            scanned: scanned.length,
            unchanged,
            added: addedCount,
            modified: modifiedCount,
            deleted: deletedCount
          },
          samples: { added, modified, deleted }
        }
      })

    return { check }
  })
)
