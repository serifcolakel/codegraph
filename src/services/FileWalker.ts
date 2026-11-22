import { createHash } from "node:crypto"
import { FileSystem, Path } from "@effect/platform"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { Context, Effect, Layer } from "effect"
import ignore from "ignore"
import { WalkError } from "../domain/errors.js"
import { SOURCE_EXTENSIONS } from "../domain/languages.js"
import type { FileScanResult } from "../domain/models.js"

export interface FileWalker {
  readonly walk: (
    rootPath: string,
    extraIgnores?: readonly string[]
  ) => Effect.Effect<readonly FileScanResult[], WalkError>
}

export const FileWalker = Context.GenericTag<FileWalker>("@codegraph/FileWalker")

const CONFIG_YAML =
  /^(?:docker-)?compose[^/]*\.ya?ml$|^Chart\.ya?ml$|^(?:openapi|swagger)(?:[.-].*)?\.(?:json|ya?ml)$/i
const CONFIG_PATH = /(^|\/)(k8s|kubernetes|deploy|deployment|helm|manifests)\//i

const isConfigFile = (entry: string, relativePath: string): boolean =>
  /^Dockerfile(?:\.|$)/i.test(entry) ||
  CONFIG_YAML.test(entry) ||
  (/\.(?:ya?ml)$/i.test(entry) && CONFIG_PATH.test(relativePath))

const DEFAULT_IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  ".turbo",
  ".cache",
  "vendor",
  "target",
  "bin",
  "obj",
  ".venv",
  "venv",
  "__pycache__",
  ".gradle",
  ".idea",
  "Pods",
  "DerivedData"
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

        const exists = yield* fs
          .exists(resolvedRoot)
          .pipe(
            Effect.mapError(
              (e) => new WalkError({ message: `Failed to check path ${rootPath}`, cause: e })
            )
          )
        if (!exists) {
          return yield* Effect.fail(
            new WalkError({ message: `Root path does not exist: ${rootPath}` })
          )
        }

        const ig = ignore()
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
          "vendor",
          "target",
          "bin",
          "obj",
          ".venv",
          "venv",
          "__pycache__",
          ".gradle",
          "Pods",
          "DerivedData",
          ".DS_Store"
        ])

        // Add extra ignore globs
        for (const pattern of extraIgnores) {
          if (pattern.trim().length > 0) {
            ig.add(pattern.trim())
          }
        }

        const results: FileScanResult[] = []
        const loadedGitignores = new Set<string>()

        // Reads a .gitignore in its own directory and rewrites patterns so they
        // stay relative to that directory (git semantics) before feeding `ignore`.
        const addGitignore = (
          directory: string,
          relative: string
        ): Effect.Effect<void, WalkError> =>
          Effect.gen(function* () {
            if (loadedGitignores.has(directory)) return
            loadedGitignores.add(directory)
            const gitignorePath = path.join(directory, ".gitignore")
            const hasGitignore = yield* fs
              .exists(gitignorePath)
              .pipe(
                Effect.mapError(
                  (e) => new WalkError({ message: "Error checking .gitignore", cause: e })
                )
              )
            if (!hasGitignore) return

            const content = yield* fs
              .readFileString(gitignorePath)
              .pipe(
                Effect.mapError(
                  (e) => new WalkError({ message: "Failed to read .gitignore", cause: e })
                )
              )
            const prefix = relative.split(path.sep).join("/")
            const patterns: string[] = []
            for (const rawLine of content.split(/\r?\n/)) {
              const line = rawLine.trim()
              if (line.length === 0 || line.startsWith("#")) continue
              const negated = line.startsWith("!")
              const body = (negated ? line.slice(1) : line).replace(/^\//, "")
              if (prefix === "") {
                patterns.push(line)
                continue
              }
              if (line.startsWith("/") || body.includes("/")) {
                const prefixed = `${prefix}/${body}`
                patterns.push(negated ? `!${prefixed}` : prefixed)
              } else if (negated) {
                patterns.push(`!${prefix}/**/${body}`)
                patterns.push(`!${prefix}/${body}`)
              } else {
                patterns.push(`${prefix}/**/${body}`)
                patterns.push(`${prefix}/${body}`)
              }
            }
            ig.add(patterns)
          })

        const traverse = (
          currentDir: string,
          relativeDir: string
        ): Effect.Effect<void, WalkError> =>
          Effect.gen(function* () {
            yield* addGitignore(currentDir, relativeDir)
            const entries = yield* fs
              .readDirectory(currentDir)
              .pipe(
                Effect.mapError(
                  (e) => new WalkError({ message: `Failed to read dir ${currentDir}`, cause: e })
                )
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

              const stat = yield* fs
                .stat(fullPath)
                .pipe(
                  Effect.mapError(
                    (e) => new WalkError({ message: `Failed to stat ${fullPath}`, cause: e })
                  )
                )

              if (stat.type === "Directory") {
                if (ig.ignores(`${normalizedRelPath}/`)) {
                  continue
                }
                yield* traverse(fullPath, path.join(relativeDir, entry))
              } else if (stat.type === "File") {
                const ext = path.extname(entry).toLowerCase()
                // Skip unsupported files, type declarations and minified bundles.
                if (
                  (!SOURCE_EXTENSIONS.has(ext) && !isConfigFile(entry, normalizedRelPath)) ||
                  entry.endsWith(".d.ts") ||
                  entry.endsWith(".min.js")
                ) {
                  continue
                }

                const fileContent = yield* fs
                  .readFile(fullPath)
                  .pipe(
                    Effect.mapError(
                      (e) => new WalkError({ message: `Failed to read ${fullPath}`, cause: e })
                    )
                  )
                const hash = createHash("sha256").update(fileContent).digest("hex")

                results.push({
                  path: normalizedRelPath,
                  absolutePath: fullPath,
                  hash,
                  sizeBytes: fileContent.byteLength
                })
              }
            }
          })

        yield* traverse(resolvedRoot, "")
        return results
      })

    return { walk }
  })
)

export const FileWalkerPlatformLive = FileWalkerLive.pipe(
  Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))
)
