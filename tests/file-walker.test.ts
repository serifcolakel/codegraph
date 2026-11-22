import { FileSystem, Path } from "@effect/platform"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { describe, expect } from "vitest"
import { FileWalker, FileWalkerPlatformLive } from "../src/services/FileWalker.js"
import { Parser, ParserLive } from "../src/services/Parser.js"

describe("File walker", () => {
  it.effect("honors root and nested .gitignore files and includes docs/text files", () =>
    Effect.gen(function* () {
      const walker = yield* FileWalker
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const tmpDir = path.resolve(`./.test-tmp-walker-${Date.now()}`)
      yield* fs.makeDirectory(path.join(tmpDir, "docs"), { recursive: true })
      yield* fs.makeDirectory(path.join(tmpDir, "sub/ignored"), { recursive: true })
      yield* fs.makeDirectory(path.join(tmpDir, "vendor"), { recursive: true })

      try {
        yield* fs.writeFileString(path.join(tmpDir, ".gitignore"), "secret.txt\nbuild-out/\n")
        yield* fs.writeFileString(
          path.join(tmpDir, "sub/.gitignore"),
          "*.log\nignored/\n*.gen.ts\n!keep.gen.ts\n"
        )
        for (const file of [
          "keep.ts",
          "secret.txt",
          "notes.txt",
          "docs/guide.md",
          "docs/page.mdx",
          "sub/a.ts",
          "sub/debug.log",
          "sub/data.gen.ts",
          "sub/keep.gen.ts",
          "sub/ignored/b.ts",
          "vendor/lib.ts"
        ]) {
          yield* fs.writeFileString(path.join(tmpDir, file), "content\n")
        }

        const files = yield* walker.walk(tmpDir)
        const paths = files.map((file) => file.path).sort()
        expect(paths).toEqual([
          "docs/guide.md",
          "docs/page.mdx",
          "keep.ts",
          "notes.txt",
          "sub/a.ts",
          "sub/keep.gen.ts"
        ])

        const filtered = yield* walker.walk(tmpDir, ["docs/"])
        expect(filtered.some((file) => file.path.startsWith("docs/"))).toBe(false)
      } finally {
        yield* fs.remove(tmpDir, { recursive: true }).pipe(Effect.ignore)
      }
    }).pipe(
      Effect.provide(
        Layer.merge(FileWalkerPlatformLive, Layer.merge(NodeFileSystem.layer, NodePath.layer))
      )
    )
  )

  it.effect("parses .txt files as documentation nodes", () =>
    Effect.gen(function* () {
      const parser = yield* Parser
      const parsed = yield* parser.parse("notes.txt", "Release notes\n\nSecond line.\n")
      expect(parsed.parseStatus).toBe("parsed")
      expect(parsed.symbols[0]?.kind).toBe("doc")
      expect(parsed.symbols[0]?.name).toBe("notes")
      expect(parsed.symbols[0]?.doc).toContain("Release notes")
    }).pipe(Effect.provide(ParserLive))
  )
})
