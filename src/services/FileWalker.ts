import { Context, Effect, Layer } from "effect"
import { FileSystem, Path } from "@effect/platform"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { createHash } from "node:crypto"
import ignore from "ignore"
import { WalkError } from "../domain/errors.js"
import type { FileScanResult } from "../domain/models.js"

export interface FileWalker {
  readonly walk: (
    rootPath: string,
    extraIgnores?: readonly string[]
  ) => Effect.Effect<readonly FileScanResult[], WalkError>
}

export const FileWalker = Context.GenericTag<FileWalker>("@codegraph/FileWalker")

const VALID_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"])
const DEFAULT_IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  ".turbo",
  ".cache"
])

export const FileWalkerLive = Layer.effect(
  FileWalker,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    const walk = (
      rootPath: string,
      extraIgnores: readonly string[] = []
    ): Effect.Effect<readonly FileScanResult[], WalkError> =>
      Effect.gen(function* () {
        const resolvedRoot = path.resolve(rootPath)

        const exists = yield* fs.exists(resolvedRoot).pipe(
          Effect.mapError(e => new WalkError({ message: `Failed to check path ${rootPath}`, cause: e }))
        )
        if (!exists) {
          return yield* Effect.fail(new WalkError({ message: `Root path does not exist: ${rootPath}` }))
        }

        const ig = (ignore as any).default ? (ignore as any).default() : (ignore as any)()
        // Add default ignores
        ig.add([
          "node_modules",
          ".git",
          "dist",
          "build",
          ".next",
          "coverage",
          "*.sqlite",
          "*.sqlite-journal",
          "*.sqlite-wal",
          ".DS_Store"
        ])

        // Add extra ignore globs
        for (const pattern of extraIgnores) {
          if (pattern.trim().length > 0) {
            ig.add(pattern.trim())
          }
        }

        // Try reading root .gitignore
        const gitignorePath = path.join(resolvedRoot, ".gitignore")
        const hasGitignore = yield* fs.exists(gitignorePath).pipe(
          Effect.mapError(e => new WalkError({ message: `Error checking .gitignore`, cause: e }))
        )

        if (hasGitignore) {
          const content = yield* fs.readFileString(gitignorePath).pipe(
            Effect.mapError(e => new WalkError({ message: `Failed to read .gitignore`, cause: e }))
          )
          ig.add(content)
        }

        const results: FileScanResult[] = []

        const traverse = (currentDir: string): Effect.Effect<void, WalkError> =>
          Effect.gen(function* () {
            const entries = yield* fs.readDirectory(currentDir).pipe(
              Effect.mapError(e => new WalkError({ message: `Failed to read dir ${currentDir}`, cause: e }))
            )

            for (const entry of entries) {
              if (DEFAULT_IGNORED_DIRS.has(entry)) {
                continue
              }

              const fullPath = path.join(currentDir, entry)
              const relPath = path.relative(resolvedRoot, fullPath)

              // Check ignore rules (ignore expects unix-style path, directory trailing slash if dir)
              const normalizedRelPath = relPath.split(path.sep).join("/")
              if (ig.ignores(normalizedRelPath)) {
                continue
              }

              const stat = yield* fs.stat(fullPath).pipe(
                Effect.mapError(e => new WalkError({ message: `Failed to stat ${fullPath}`, cause: e }))
              )

              if (stat.type === "Directory") {
                if (ig.ignores(normalizedRelPath + "/")) {
                  continue
                }
                yield* traverse(fullPath)
              } else if (stat.type === "File") {
                const ext = path.extname(entry).toLowerCase()
                // Skip if not a valid script extension or is a declaration file
                if (!VALID_EXTENSIONS.has(ext) || entry.endsWith(".d.ts")) {
                  continue
                }

                const fileContent = yield* fs.readFile(fullPath).pipe(
                  Effect.mapError(e => new WalkError({ message: `Failed to read ${fullPath}`, cause: e }))
                )
                const hash = createHash("sha256").update(fileContent).digest("hex")

                results.push({
                  path: normalizedRelPath,
                  absolutePath: fullPath,
                  hash
                })
              }
            }
          })

        yield* traverse(resolvedRoot)
        return results
      })

    return { walk }
  })
)

export const FileWalkerPlatformLive = FileWalkerLive.pipe(
  Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))
)
