import { FileSystem, Path } from "@effect/platform"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import * as Sqlite from "@effect/sql-sqlite-node"
import { it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { describe, expect } from "vitest"
import { CrossRepo, CrossRepoLive } from "../src/services/CrossRepo.js"
import { FileWalkerLive } from "../src/services/FileWalker.js"
import { Indexer, IndexerLive } from "../src/services/Indexer.js"
import { IndexStoreLive } from "../src/services/IndexStore.js"
import { ParserLive } from "../src/services/Parser.js"

const makeTestLive = () => {
  const SqlLive = Sqlite.SqliteClient.layer({ filename: ":memory:" })
  const StoreLive = IndexStoreLive.pipe(Layer.provide(SqlLive))
  const CrossRepoServiceLive = CrossRepoLive.pipe(Layer.provide(SqlLive))
  const PlatformLive = Layer.merge(NodeFileSystem.layer, NodePath.layer)
  const WalkerLive = FileWalkerLive.pipe(Layer.provide(PlatformLive))
  const IndexerTestLive = IndexerLive.pipe(
    Layer.provide(Layer.mergeAll(StoreLive, WalkerLive, ParserLive, PlatformLive))
  )
  return Layer.mergeAll(IndexerTestLive, StoreLive, CrossRepoServiceLive, PlatformLive)
}

describe("Cross-repository links", () => {
  it.effect("matches HTTP routes and async channels across repositories", () =>
    Effect.gen(function* () {
      const indexer = yield* Indexer
      const crossRepo = yield* CrossRepo
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const root = path.resolve(`./.test-tmp-cross-${Date.now()}`)
      const repoA = path.join(root, "repo-a")
      const repoB = path.join(root, "repo-b")
      yield* fs.makeDirectory(repoA, { recursive: true })
      yield* fs.makeDirectory(repoB, { recursive: true })

      try {
        yield* fs.writeFileString(
          path.join(repoA, "a.ts"),
          `
function handlerA(): number { return 1 }
router.get("/funds/:id", handlerA)
bus.emit("funds:updated", 1)
`
        )
        yield* fs.writeFileString(
          path.join(repoB, "b.ts"),
          `
function handlerB(): number { return 2 }
router.get("/funds/{id}", handlerB)
bus.on("funds:updated", () => {})
`
        )

        const reportA = yield* indexer.indexRepo(repoA, { name: "repo-a" })
        const reportB = yield* indexer.indexRepo(repoB, { name: "repo-b" })

        const result = yield* crossRepo.link()
        expect(result.http).toBe(2)
        expect(result.async).toBe(2)
        expect(result.total).toBe(4)

        const links = yield* crossRepo.list(reportA.repoId)
        expect(links.length).toBe(4)
        expect(
          links.some(
            (link) =>
              link.kind === "http" &&
              link.source.repoId === reportA.repoId &&
              link.target.repoId === reportB.repoId
          )
        ).toBe(true)
        expect(
          links.some(
            (link) =>
              link.kind === "async" &&
              link.source.name === "channel:funds:updated" &&
              link.target.repoId === reportB.repoId
          )
        ).toBe(true)

        const again = yield* crossRepo.link()
        expect(again.total).toBe(4)
        expect((yield* crossRepo.list(reportA.repoId)).length).toBe(4)

        expect((yield* crossRepo.list("missing")).length).toBe(0)
      } finally {
        yield* fs.remove(root, { recursive: true }).pipe(Effect.ignore)
      }
    }).pipe(Effect.provide(makeTestLive()))
  )
})
