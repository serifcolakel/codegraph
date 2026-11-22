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
import { Parser, ParserLive } from "../src/services/Parser.js"

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

const SOURCE = `# CodeGraph

Intro mentions \`indexRepo\` and \`npm run\`.

## Installation

Run \`indexRepo\` with \`Parser.parse\`.

\`\`\`ts
# not a heading
\`\`\`

### Nested

See \`helper()\`.

## Notes

No mentions here.
`

describe("Markdown documentation indexing", () => {
  it.effect("extracts heading sections, hierarchy and mentions", () =>
    Effect.gen(function* () {
      const parser = yield* Parser
      const parsed = yield* parser.parse("docs/guide.md", SOURCE)

      expect(parsed.parseStatus).toBe("parsed")
      const byName = (name: string) => parsed.symbols.find((symbol) => symbol.name === name)

      expect(byName("CodeGraph")?.kind).toBe("doc")
      expect(byName("Installation")?.containerName).toBe("CodeGraph")
      expect(byName("Nested")?.containerName).toBe("Installation")
      expect(byName("Notes")?.containerName).toBe("CodeGraph")
      expect(byName("# not a heading")).toBeUndefined()

      expect(byName("Installation")?.doc).toContain("indexRepo")

      expect(
        parsed.edges.some(
          (edge) =>
            edge.kind === "contains" && edge.srcName === "Installation" && edge.dstName === "Nested"
        )
      ).toBe(true)

      expect(
        parsed.edges.some(
          (edge) =>
            edge.kind === "mentions" &&
            edge.srcName === "Installation" &&
            edge.dstName === "Parser.parse"
        )
      ).toBe(true)
      expect(
        parsed.edges.some(
          (edge) =>
            edge.kind === "mentions" && edge.srcName === "Nested" && edge.dstName === "helper"
        )
      ).toBe(true)
      expect(
        parsed.edges.some(
          (edge) =>
            edge.kind === "mentions" && edge.srcName === "CodeGraph" && edge.dstName === "indexRepo"
        )
      ).toBe(true)
    }).pipe(Effect.provide(ParserLive))
  )

  it.effect("resolves documentation mentions to code symbols", () =>
    Effect.gen(function* () {
      const indexer = yield* Indexer
      const query = yield* GraphQuery
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const tmpDir = path.resolve(`./.test-tmp-markdown-${Date.now()}`)
      yield* fs.makeDirectory(path.join(tmpDir, "docs"), { recursive: true })

      try {
        yield* fs.writeFileString(
          path.join(tmpDir, "src.ts"),
          "export function indexRepo(): number { return 1 }\nexport function helper(): number { return 2 }\n"
        )
        yield* fs.writeFileString(
          path.join(tmpDir, "docs/guide.md"),
          "# Guide\n\nUse `indexRepo` and `helper`.\n"
        )

        const report = yield* indexer.indexRepo(tmpDir, { name: "markdown" })

        const outline = yield* query.outlineFile(report.repoId, "docs/guide.md")
        const guide = outline.find((symbol) => symbol.name === "Guide")
        expect(guide?.kind).toBe("doc")
        expect(guide?.language).toBe("markdown")

        const search = yield* query.searchSymbols("Guide", 10, report.repoId)
        expect(search.some((symbol) => symbol.name === "Guide")).toBe(true)

        const indexRepo = (yield* query.searchSymbols("indexRepo", 10, report.repoId)).find(
          (symbol) => symbol.name === "indexRepo"
        )
        expect(indexRepo).toBeDefined()
        const references = yield* query.findReferences(indexRepo?.id ?? "")
        expect(
          references.some(
            (reference) => reference.kind === "mentions" && reference.sourceSymbol.name === "Guide"
          )
        ).toBe(true)
      } finally {
        yield* fs.remove(tmpDir, { recursive: true }).pipe(Effect.ignore)
      }
    }).pipe(Effect.provide(makeTestLive()))
  )
})
