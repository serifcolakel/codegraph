import { FileSystem, Path } from "@effect/platform"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import * as Sqlite from "@effect/sql-sqlite-node"
import { it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { describe, expect } from "vitest"
import { FileWalkerLive } from "../src/services/FileWalker.js"
import { GraphQuery, GraphQueryLive } from "../src/services/GraphQuery.js"
import { Indexer, IndexerLive } from "../src/services/Indexer.js"
import { IndexStoreLive } from "../src/services/IndexStore.js"
import { ParserLive } from "../src/services/Parser.js"

describe("GraphQuery service", () => {
  it.effect("executes graph queries correctly over an indexed codebase", () =>
    Effect.gen(function* () {
      const indexer = yield* Indexer
      const query = yield* GraphQuery
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const tmpDir = path.resolve(`./.test-tmp-query-${Date.now()}`)
      yield* fs.makeDirectory(tmpDir, { recursive: true })

      try {
        const fileA = path.join(tmpDir, "calculator.ts")
        const fileB = path.join(tmpDir, "app.ts")

        yield* fs.writeFileString(
          fileA,
          `
export interface Operation {
  compute(a: number, b: number): number;
}

/** Adds two numbers together. */
export class AddOperation implements Operation {
  compute(a: number, b: number): number {
    return a + b;
  }
}
`
        )

        yield* fs.writeFileString(
          fileB,
          `
import { AddOperation } from "./calculator";

export function runCalculation(x: number, y: number): number {
  const op = new AddOperation();
  return op.compute(x, y);
}
`
        )

        // 1. Index the repo
        const report = yield* indexer.indexRepo(tmpDir, { name: "calc-repo" })
        expect(report.filesIndexed).toBe(2)

        // 2. Test searchSymbols (FTS5)
        const searchResults = yield* query.searchSymbols("AddOperation")
        expect(searchResults.length).toBeGreaterThan(0)
        expect(searchResults[0]?.name).toBe("AddOperation")
        expect(searchResults[0]?.doc).toContain("Adds two numbers")

        const docResults = yield* query.searchSymbols("numbers", 10, report.repoId)
        expect(docResults.some((s) => s.name === "AddOperation")).toBe(true)

        // Empty query seeds the symbol-level view with ranked symbols
        const seeded = yield* query.searchSymbols("", 10, report.repoId)
        expect(seeded.length).toBeGreaterThan(0)
        expect(seeded.some((s) => s.name === "AddOperation")).toBe(true)

        // 3. Test outlineFile
        const outline = yield* query.outlineFile(report.repoId, "calculator.ts")
        expect(outline.length).toBeGreaterThanOrEqual(2)
        const names = outline.map((s) => s.name)
        expect(names).toContain("Operation")
        expect(names).toContain("AddOperation")
        expect(outline.every((s) => typeof s.exported === "boolean")).toBe(true)

        // 4. Test getSymbol & findReferences
        const addOpSymbol = searchResults[0]
        const details = yield* query.getSymbol(addOpSymbol.id)
        expect(details.symbol.name).toBe("AddOperation")

        // 5. Test neighborhood
        const neighborhood = yield* query.neighborhood(addOpSymbol.id, 2)
        expect(neighborhood.nodes.length).toBeGreaterThan(0)
        const nodeIds = new Set(neighborhood.nodes.map((node) => node.id))
        expect(
          neighborhood.edges.every(
            (edge) => nodeIds.has(edge.srcSymbolId) && nodeIds.has(edge.dstSymbolId)
          )
        ).toBe(true)

        const deep = yield* query.neighborhood(addOpSymbol.id, 100)
        expect(deep.nodes.length).toBeLessThanOrEqual(500)

        const missing = yield* query.neighborhood("does-not-exist").pipe(Effect.flip)
        expect(missing._tag).toBe("NotFoundError")

        // 6. Test repoMap
        const mapText = yield* query.repoMap(report.repoId, 1000)
        expect(mapText).toContain("calculator.ts:")
        expect(mapText).toContain("AddOperation")

        // 7. Test fileGraph. The cross-file `new AddOperation()` call must
        // resolve to calculator.ts instead of being dropped or misattributed.
        const fg = yield* query.fileGraph(report.repoId)
        expect(fg.nodes.length).toBe(2)
        expect(fg.edges.some((e) => e.srcPath === "app.ts" && e.dstPath === "calculator.ts")).toBe(
          true
        )
      } finally {
        yield* fs.remove(tmpDir, { recursive: true }).pipe(Effect.ignore)
      }
    }).pipe(
      Effect.provide(
        (() => {
          const SqlLive = Sqlite.SqliteClient.layer({ filename: ":memory:" })
          const StoreLive = IndexStoreLive.pipe(Layer.provide(SqlLive))
          const QueryLive = GraphQueryLive.pipe(Layer.provide(SqlLive))
          const PlatformLive = Layer.merge(NodeFileSystem.layer, NodePath.layer)
          const WalkerLive = FileWalkerLive.pipe(Layer.provide(PlatformLive))
          const IndexerTestLive = IndexerLive.pipe(
            Layer.provide(Layer.mergeAll(StoreLive, WalkerLive, ParserLive, PlatformLive))
          )
          return Layer.mergeAll(IndexerTestLive, StoreLive, QueryLive, PlatformLive)
        })()
      )
    )
  )
})
