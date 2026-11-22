import { FileSystem, Path } from "@effect/platform"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import * as Sqlite from "@effect/sql-sqlite-node"
import { it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { describe, expect } from "vitest"
import { Analytics, AnalyticsLive } from "../src/services/Analytics.js"
import { FileWalkerLive } from "../src/services/FileWalker.js"
import { Indexer, IndexerLive } from "../src/services/Indexer.js"
import { IndexStoreLive } from "../src/services/IndexStore.js"
import { ParserLive } from "../src/services/Parser.js"

const makeTestLive = () => {
  const SqlLive = Sqlite.SqliteClient.layer({ filename: ":memory:" })
  const StoreLive = IndexStoreLive.pipe(Layer.provide(SqlLive))
  const AnalyticsServiceLive = AnalyticsLive.pipe(Layer.provide(SqlLive))
  const PlatformLive = Layer.merge(NodeFileSystem.layer, NodePath.layer)
  const WalkerLive = FileWalkerLive.pipe(Layer.provide(PlatformLive))
  const IndexerTestLive = IndexerLive.pipe(
    Layer.provide(Layer.mergeAll(StoreLive, WalkerLive, ParserLive, PlatformLive))
  )
  return Layer.mergeAll(IndexerTestLive, StoreLive, AnalyticsServiceLive, PlatformLive)
}

describe("Analytics", () => {
  it.effect("ranks symbols, finds hotspots, dead code and cycles", () =>
    Effect.gen(function* () {
      const indexer = yield* Indexer
      const analytics = yield* Analytics
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const tmpDir = path.resolve(`./.test-tmp-analytics-${Date.now()}`)
      yield* fs.makeDirectory(tmpDir, { recursive: true })

      try {
        yield* fs.writeFileString(
          path.join(tmpDir, "service.ts"),
          `
export function alpha(): number { return beta() }
function beta(): number { return alpha() }
export function leaf(): number { return 1 }
export function caller1(): number { return leaf() }
export function caller2(): number { return leaf() }
function dead(): number { return 42 }
`
        )
        yield* fs.writeFileString(
          path.join(tmpDir, "a.ts"),
          'import { b } from "./b";\nexport function a(): number { return b() }\n'
        )
        yield* fs.writeFileString(
          path.join(tmpDir, "b.ts"),
          'import { a } from "./a";\nexport function b(): number { return a() }\n'
        )

        const report = yield* indexer.indexRepo(tmpDir, { name: "analytics" })

        const pagerank = yield* analytics.rank(report.repoId)
        expect(pagerank.length).toBeGreaterThan(0)
        expect(pagerank.every((symbol) => symbol.score >= 0)).toBe(true)
        expect(pagerank.find((symbol) => symbol.name === "leaf")?.inDegree).toBe(2)

        const inDegree = yield* analytics.rank(report.repoId, { algorithm: "in_degree" })
        expect(inDegree[0]?.name).toBe("leaf")
        expect(inDegree[0]?.score).toBe(2)

        const hotspots = yield* analytics.hotspots(report.repoId, { limit: 5 })
        expect(hotspots[0]?.name).toBe("leaf")
        expect(hotspots[0]?.fanIn).toBe(2)

        const dead = yield* analytics.deadCode(report.repoId)
        const deadNames = dead.map((symbol) => symbol.name)
        expect(deadNames).toContain("dead")
        expect(deadNames).not.toContain("leaf")
        expect(deadNames).not.toContain("alpha")

        const symbolCycles = yield* analytics.cycles(report.repoId, { level: "symbol" })
        const cycleNames = symbolCycles.flatMap((group) =>
          group.members.map((member) => member.name)
        )
        expect(cycleNames).toEqual(expect.arrayContaining(["alpha", "beta", "a", "b"]))

        const fileCycles = yield* analytics.cycles(report.repoId, { level: "file" })
        expect(fileCycles.length).toBeGreaterThan(0)
        const cycleFiles = fileCycles.flatMap((group) =>
          group.members.map((member) => member.filePath)
        )
        expect(cycleFiles).toEqual(expect.arrayContaining(["a.ts", "b.ts"]))
      } finally {
        yield* fs.remove(tmpDir, { recursive: true }).pipe(Effect.ignore)
      }
    }).pipe(Effect.provide(makeTestLive()))
  )
})
