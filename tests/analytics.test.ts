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
  it.effect("groups communities and ranks packages across directories", () =>
    Effect.gen(function* () {
      const indexer = yield* Indexer
      const analytics = yield* Analytics
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const tmpDir = path.resolve(`./.test-tmp-community-${Date.now()}`)
      yield* fs.makeDirectory(path.join(tmpDir, "lib"), { recursive: true })
      yield* fs.makeDirectory(path.join(tmpDir, "app"), { recursive: true })

      try {
        yield* fs.writeFileString(
          path.join(tmpDir, "lib/a.ts"),
          `import { fb } from "../app/b";
export function fa(): number { return fb() }
`
        )
        yield* fs.writeFileString(
          path.join(tmpDir, "app/b.ts"),
          "export function fb(): number { return 1 }"
        )
        yield* fs.writeFileString(
          path.join(tmpDir, "app/c.ts"),
          `import { fa } from "../lib/a";
export function fc(): number { return fa() }
`
        )

        const report = yield* indexer.indexRepo(tmpDir, { name: "communities" })

        const packages = yield* analytics.packageRankings(report.repoId)
        const byName = new Map(packages.map((pkg) => [pkg.name, pkg]))
        expect(byName.get("lib")?.fanOut).toBeGreaterThanOrEqual(1)
        expect(byName.get("app")?.fanIn).toBeGreaterThanOrEqual(1)

        const packageCycles = yield* analytics.cycles(report.repoId, { level: "package" })
        expect(packageCycles.length).toBeGreaterThan(0)
        const packageNames = packageCycles.flatMap((group) =>
          group.members.map((member) => member.name)
        )
        expect(packageNames).toEqual(expect.arrayContaining(["app", "lib"]))

        const fileCommunities = yield* analytics.communities(report.repoId, { level: "file" })
        const fileGroup = fileCommunities.find((group) => group.size >= 3)
        expect(fileGroup).toBeDefined()
        const files = fileGroup?.members.map((member) => member.filePath) ?? []
        expect(files).toEqual(expect.arrayContaining(["lib/a.ts", "app/b.ts", "app/c.ts"]))

        const symbolCommunities = yield* analytics.communities(report.repoId)
        const symbolNames = symbolCommunities.flatMap((group) =>
          group.members.map((member) => member.name)
        )
        expect(symbolNames).toEqual(expect.arrayContaining(["fa", "fb", "fc"]))
      } finally {
        yield* fs.remove(tmpDir, { recursive: true }).pipe(Effect.ignore)
      }
    }).pipe(Effect.provide(makeTestLive()))
  )

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

export function complex(values: number[]): number {
  let total = 0;
  for (const value of values) {
    if (value > 0) total += complex(values);
  }
  return total;
}
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

        const complexRank = yield* analytics.rank(report.repoId, { algorithm: "complexity" })
        const complexSymbol = complexRank.find((symbol) => symbol.name === "complex")
        expect(complexSymbol?.cyclomatic).toBe(3)
        expect(complexSymbol?.score).toBeGreaterThan(0)

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
