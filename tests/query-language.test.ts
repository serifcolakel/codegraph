import { FileSystem, Path } from "@effect/platform"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import * as Sqlite from "@effect/sql-sqlite-node"
import { it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { describe, expect } from "vitest"
import { FileWalkerLive } from "../src/services/FileWalker.js"
import { Indexer, IndexerLive } from "../src/services/Indexer.js"
import { IndexStore, IndexStoreLive } from "../src/services/IndexStore.js"
import { ParserLive } from "../src/services/Parser.js"
import { QueryLanguage, QueryLanguageLive } from "../src/services/QueryLanguage.js"

const makeTestLive = () => {
  const SqlLive = Sqlite.SqliteClient.layer({ filename: ":memory:" })
  const StoreLive = IndexStoreLive.pipe(Layer.provide(SqlLive))
  const LanguageLive = QueryLanguageLive.pipe(Layer.provide(SqlLive))
  const PlatformLive = Layer.merge(NodeFileSystem.layer, NodePath.layer)
  const WalkerLive = FileWalkerLive.pipe(Layer.provide(PlatformLive))
  const IndexerTestLive = IndexerLive.pipe(
    Layer.provide(Layer.mergeAll(StoreLive, WalkerLive, ParserLive, PlatformLive))
  )
  return Layer.mergeAll(IndexerTestLive, StoreLive, LanguageLive, PlatformLive)
}

describe("query_graph language", () => {
  it.effect("filters symbols, files and call edges", () =>
    Effect.gen(function* () {
      const indexer = yield* Indexer
      const language = yield* QueryLanguage
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const tmpDir = path.resolve(`./.test-tmp-query-lang-${Date.now()}`)
      yield* fs.makeDirectory(tmpDir, { recursive: true })

      try {
        yield* fs.writeFileString(
          path.join(tmpDir, "a.ts"),
          `
export function helper(value: number): number { return value }
export function caller(): number { return helper(1) }
export const LIMIT = 10

export function risky(values: number[]): number {
  let total = 0;
  for (const value of values) {
    if (value > 0) total += value;
  }
  return total;
}
`
        )
        yield* fs.writeFileString(
          path.join(tmpDir, "b.ts"),
          `
import { helper } from "./a";
export class Service {
  run(): number { return helper(2) }
}
`
        )

        const report = yield* indexer.indexRepo(tmpDir, { name: "query-lang" })

        const functions = yield* language.execute(
          `MATCH (s:Symbol) WHERE s.kind = "function" RETURN s.name AS name, s.filePath AS file ORDER BY s.name`
        )
        expect(functions.total).toBeGreaterThanOrEqual(2)
        expect(functions.columns).toEqual(["name", "file"])
        const names = functions.rows.map((row) => row.name)
        expect(names).toContain("helper")
        expect(names).toContain("caller")

        const calls = yield* language.execute(
          `MATCH (a:Symbol)-[e:CALLS]->(b:Symbol) WHERE a.name = "caller" RETURN a.name AS caller, b.name AS callee`
        )
        expect(calls.rows).toContainEqual({ caller: "caller", callee: "helper" })

        const inbound = yield* language.execute(
          `MATCH (b:Symbol)<-[e:CALLS]-(a:Symbol) WHERE b.name = "helper" RETURN a.name AS caller ORDER BY a.name`
        )
        expect(inbound.rows.map((row) => row.caller)).toContain("caller")

        const complex = yield* language.execute(
          `MATCH (s:Symbol) WHERE s.cyclomatic >= 3 RETURN s.name AS name, s.cyclomatic AS cx`
        )
        expect(complex.rows).toContainEqual({ name: "risky", cx: 3 })

        const files = yield* language.execute(
          `MATCH (f:File) WHERE f.path ENDS WITH ".ts" RETURN f.path AS path ORDER BY f.path`
        )
        expect(files.rows.map((row) => row.path)).toEqual(["a.ts", "b.ts"])

        const filtered = yield* language.execute(
          `MATCH (s:Symbol) WHERE s.name IN ["helper", "caller"] OR s.name STARTS WITH "Serv" RETURN s.name AS name ORDER BY s.name`
        )
        expect(filtered.rows.map((row) => row.name)).toEqual([
          "Service",
          "Service.run",
          "caller",
          "helper"
        ])

        const scoped = yield* language.execute(`MATCH (s:Symbol) RETURN s.name AS name`, {
          repoId: report.repoId
        })
        expect(scoped.total).toBeGreaterThan(0)
        expect(scoped.truncated).toBe(false)

        const page = yield* language.execute(`MATCH (s:Symbol) RETURN s.name AS name LIMIT 1`)
        expect(page.returned).toBe(1)
        expect(page.total).toBeGreaterThan(1)
        expect(page.truncated).toBe(true)
      } finally {
        yield* fs.remove(tmpDir, { recursive: true }).pipe(Effect.ignore)
      }
    }).pipe(Effect.provide(makeTestLive()))
  )

  it.effect("rejects writes and unsupported properties", () =>
    Effect.gen(function* () {
      const store = yield* IndexStore
      yield* store.initSchema()
      const language = yield* QueryLanguage
      const cases = [
        `MATCH (s:Symbol) SET s.name = "x" RETURN s.name`,
        `CREATE (s:Symbol) RETURN s.name`,
        `MATCH (s:Symbol) RETURN s.password`,
        `MATCH (s:Symbol) WHERE s.name = "x"`,
        `MATCH (a:File)-[e:CALLS]->(b:Symbol) RETURN a.path`,
        `MATCH (a:Symbol)-[e:DELETES]->(b:Symbol) RETURN a.name`
      ]

      for (const query of cases) {
        const error = yield* language.execute(query).pipe(Effect.flip)
        expect(error._tag, `${query} -> ${error.message}`).toBe("QueryLanguageError")
        expect(error.message.length).toBeGreaterThan(0)
      }
    }).pipe(Effect.provide(makeTestLive()))
  )
})
