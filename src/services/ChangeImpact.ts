import { Context, Effect, Layer } from "effect"
import type { GitError, StoreError } from "../domain/errors.js"
import { NotFoundError } from "../domain/errors.js"
import { GitChanges } from "./GitChanges.js"
import { GraphQuery } from "./GraphQuery.js"
import { IndexStore } from "./IndexStore.js"

export interface ChangedSymbol {
  readonly id: string
  readonly name: string
  readonly kind: string
  readonly filePath: string
  readonly startLine: number
}

export interface ImpactedSymbol extends ChangedSymbol {
  readonly referencedBy: readonly string[]
}

export interface ChangeImpactReport {
  readonly repoId: string
  readonly changedFiles: readonly string[]
  readonly indexedFiles: readonly string[]
  readonly affectedSymbols: readonly ChangedSymbol[]
  readonly impactedSymbols: readonly ImpactedSymbol[]
  readonly truncated: boolean
}

export interface ChangeImpact {
  readonly detect: (
    repoId: string,
    base?: string
  ) => Effect.Effect<ChangeImpactReport, GitError | StoreError | NotFoundError>
}

export const ChangeImpact = Context.GenericTag<ChangeImpact>("@codegraph/ChangeImpact")

const MAX_SYMBOLS = 200
const MAX_IMPACTED = 300
const REFERENCE_KINDS = new Set(["call", "call_reference", "usage", "reference"])

export const ChangeImpactLive = Layer.effect(
  ChangeImpact,
  Effect.gen(function* () {
    const store = yield* IndexStore
    const query = yield* GraphQuery
    const git = yield* GitChanges

    const detect = (
      repoId: string,
      base?: string
    ): Effect.Effect<ChangeImpactReport, GitError | StoreError | NotFoundError> =>
      Effect.gen(function* () {
        const repo = yield* store.getRepo(repoId)
        if (!repo) {
          return yield* Effect.fail(new NotFoundError({ entity: "Repository", id: repoId }))
        }

        const changedFiles = yield* git.changedFiles(repo.rootPath, base)
        const indexed = yield* store.getFiles(repo.id)
        const indexedFiles = changedFiles.filter((filePath) => indexed.has(filePath))

        const affected: ChangedSymbol[] = []
        const affectedIds = new Set<string>()
        let truncated = false

        for (const filePath of indexedFiles.slice(0, MAX_SYMBOLS)) {
          const symbols = yield* query
            .outlineFile(repo.id, filePath)
            .pipe(Effect.catchTag("NotFoundError", () => Effect.succeed([])))
          for (const symbol of symbols) {
            if (affectedIds.has(symbol.id)) continue
            if (affected.length >= MAX_SYMBOLS) {
              truncated = true
              break
            }
            affectedIds.add(symbol.id)
            affected.push({
              id: symbol.id,
              name: symbol.name,
              kind: symbol.kind,
              filePath,
              startLine: symbol.startLine
            })
          }
        }

        const impactedById = new Map<string, { symbol: ChangedSymbol; refs: Set<string> }>()
        for (const symbol of affected) {
          const references = yield* query.findReferences(symbol.id)
          for (const reference of references) {
            if (!REFERENCE_KINDS.has(reference.kind)) continue
            const source = reference.sourceSymbol
            if (affectedIds.has(source.id)) continue
            const existing = impactedById.get(source.id)
            const refs = existing?.refs ?? new Set<string>()
            refs.add(symbol.name)
            impactedById.set(source.id, {
              symbol: {
                id: source.id,
                name: source.name,
                kind: source.kind,
                filePath: source.filePath,
                startLine: source.startLine
              },
              refs
            })
            if (impactedById.size >= MAX_IMPACTED) {
              truncated = true
              break
            }
          }
          if (impactedById.size >= MAX_IMPACTED) break
        }

        return {
          repoId: repo.id,
          changedFiles,
          indexedFiles,
          affectedSymbols: affected,
          impactedSymbols: Array.from(impactedById.values()).map((entry) => ({
            ...entry.symbol,
            referencedBy: Array.from(entry.refs)
          })),
          truncated
        }
      })

    return { detect }
  })
)
