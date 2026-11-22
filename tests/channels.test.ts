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

const makeTestLive = () => {
  const SqlLive = Sqlite.SqliteClient.layer({ filename: ":memory:" })
  const StoreLive = IndexStoreLive.pipe(Layer.provide(SqlLive))
  const QueryLive = GraphQueryLive.pipe(Layer.provide(SqlLive))
  const PlatformLive = Layer.merge(NodeFileSystem.layer, NodePath.layer)
  const WalkerLive = FileWalkerLive.pipe(Layer.provide(PlatformLive))
  const IndexerTestLive = IndexerLive.pipe(
    Layer.provide(Layer.mergeAll(StoreLive, WalkerLive, ParserLive, PlatformLive))
  )
  return Layer.mergeAll(IndexerTestLive, StoreLive, QueryLive, PlatformLive)
}

describe("Event channels", () => {
  it.effect("merges channel nodes and links publishers and subscribers", () =>
    Effect.gen(function* () {
      const indexer = yield* Indexer
      const query = yield* GraphQuery
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const tmpDir = path.resolve(`./.test-tmp-channels-${Date.now()}`)
      yield* fs.makeDirectory(tmpDir, { recursive: true })

      try {
        yield* fs.writeFileString(
          path.join(tmpDir, "publisher.ts"),
          `
export function publisher(bus: { emit: (event: string, value: number) => void }): void {
  bus.emit("funds:updated", 1)
}
`
        )
        yield* fs.writeFileString(
          path.join(tmpDir, "subscriber.ts"),
          `
export function subscriber(bus: { on: (event: string, handler: () => void) => void }): void {
  bus.on("funds:updated", () => {})
}
`
        )

        const report = yield* indexer.indexRepo(tmpDir, { name: "channels" })

        const channels = (yield* query.searchSymbols("funds", 50, report.repoId)).filter(
          (symbol) => symbol.kind === "channel"
        )
        expect(channels).toHaveLength(1)
        const channel = channels[0]
        expect(channel?.name).toBe("channel:funds:updated")

        const references = yield* query.findReferences(channel?.id ?? "")
        expect(
          references.some(
            (reference) =>
              reference.kind === "publishes" && reference.sourceSymbol.name === "publisher"
          )
        ).toBe(true)
        expect(
          references.some(
            (reference) =>
              reference.kind === "subscribes" && reference.sourceSymbol.name === "subscriber"
          )
        ).toBe(true)

        const publisherOutline = yield* query.outlineFile(report.repoId, "publisher.ts")
        expect(publisherOutline.some((symbol) => symbol.kind === "channel")).toBe(true)
      } finally {
        yield* fs.remove(tmpDir, { recursive: true }).pipe(Effect.ignore)
      }
    }).pipe(Effect.provide(makeTestLive()))
  )
})
