import type { FileSystem, Path } from "@effect/platform"
import { Effect } from "effect"

export interface PackageMapping {
  readonly prefix: string
  readonly directory: string
}

const SKIP_DIRS = new Set(["node_modules", "dist", "build", "target", ".git", ".next"])

const readText = (fs: FileSystem.FileSystem, filePath: string): Effect.Effect<string | undefined> =>
  fs.readFileString(filePath).pipe(Effect.catchAll(() => Effect.succeed(undefined)))

const readJson = (
  fs: FileSystem.FileSystem,
  filePath: string
): Effect.Effect<Record<string, unknown> | undefined> =>
  Effect.gen(function* () {
    const text = yield* readText(fs, filePath)
    if (!text) return undefined
    try {
      const parsed: unknown = JSON.parse(text)
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined
    } catch {
      return undefined
    }
  })

const directoryEntries = (
  fs: FileSystem.FileSystem,
  directory: string
): Effect.Effect<readonly string[]> =>
  fs.readDirectory(directory).pipe(Effect.catchAll(() => Effect.succeed([] as string[])))

// Expands simple workspace globs such as "packages/*" into child directories.
const expandWorkspacePatterns = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  repoPath: string,
  patterns: readonly string[]
): Effect.Effect<readonly string[]> =>
  Effect.gen(function* () {
    const directories = new Set<string>()

    for (const rawPattern of patterns) {
      const pattern = rawPattern.replace(/^\.\//, "").replace(/\/$/, "")
      const starParts = pattern.split("*")
      if (starParts.length === 1) {
        directories.add(pattern)
        continue
      }
      if (starParts.length !== 2) continue

      const base = (starParts[0] ?? "").replace(/\/$/, "")
      const suffix = (starParts[1] ?? "").replace(/^\//, "")
      const baseDirectory = base === "" ? repoPath : path.join(repoPath, base)
      for (const entry of yield* directoryEntries(fs, baseDirectory)) {
        if (SKIP_DIRS.has(entry) || entry.startsWith(".")) continue
        const candidate = suffix === "" ? entry : `${entry}/${suffix}`
        directories.add(base === "" ? candidate : `${base}/${candidate}`)
      }
    }

    return Array.from(directories)
  })

const workspaceList = (value: unknown): readonly string[] => {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string")
  if (value && typeof value === "object") {
    const packages = (value as Record<string, unknown>).packages
    if (Array.isArray(packages)) {
      return packages.filter((item): item is string => typeof item === "string")
    }
  }
  return []
}

const npmMappings = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  repoPath: string
): Effect.Effect<readonly PackageMapping[]> =>
  Effect.gen(function* () {
    const mappings: PackageMapping[] = []
    const rootPackage = yield* readJson(fs, path.join(repoPath, "package.json"))
    const rootName = rootPackage?.name
    if (typeof rootName === "string") mappings.push({ prefix: rootName, directory: "" })

    const packages = yield* expandWorkspacePatterns(
      fs,
      path,
      repoPath,
      workspaceList(rootPackage?.workspaces)
    )

    for (const directory of packages) {
      const manifest = yield* readJson(fs, path.join(repoPath, directory, "package.json"))
      const name = manifest?.name
      if (typeof name === "string") mappings.push({ prefix: name, directory })
    }

    return mappings
  })

const tomlSection = (text: string, section: string): string | undefined => {
  const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = text.match(new RegExp(`\\[${escaped}\\]([\\s\\S]*?)(?:\\n\\[|$)`))
  return match?.[1]
}

const tomlString = (text: string | undefined, key: string): string | undefined =>
  text?.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, "m"))?.[1]

const goMappings = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  repoPath: string
): Effect.Effect<readonly PackageMapping[]> =>
  Effect.gen(function* () {
    const text = yield* readText(fs, path.join(repoPath, "go.mod"))
    const modulePath = text?.match(/^\s*module\s+(\S+)/m)?.[1]
    return modulePath ? [{ prefix: modulePath, directory: "" }] : []
  })

const cargoMappings = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  repoPath: string
): Effect.Effect<readonly PackageMapping[]> =>
  Effect.gen(function* () {
    const rootText = yield* readText(fs, path.join(repoPath, "Cargo.toml"))
    if (!rootText) return []

    const mappings: PackageMapping[] = []
    const rootName = tomlString(tomlSection(rootText, "package"), "name")
    if (rootName) {
      mappings.push({ prefix: rootName, directory: "" })
      mappings.push({ prefix: rootName.replace(/-/g, "_"), directory: "" })
    }

    const membersBlock = rootText.match(/members\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? ""
    const members = Array.from(membersBlock.matchAll(/"([^"]+)"/g))
      .map((match) => match[1])
      .filter((value): value is string => Boolean(value))
    const directories = yield* expandWorkspacePatterns(fs, path, repoPath, members)

    for (const directory of directories) {
      const manifest = yield* readText(fs, path.join(repoPath, directory, "Cargo.toml"))
      if (!manifest) continue
      const name = tomlString(tomlSection(manifest, "package"), "name")
      if (!name) continue
      mappings.push({ prefix: name, directory })
      mappings.push({ prefix: name.replace(/-/g, "_"), directory })
    }

    return mappings
  })

const pythonMappings = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  repoPath: string
): Effect.Effect<readonly PackageMapping[]> =>
  Effect.gen(function* () {
    const text = yield* readText(fs, path.join(repoPath, "pyproject.toml"))
    if (!text) return []
    const name =
      tomlString(tomlSection(text, "project"), "name") ??
      tomlString(tomlSection(text, "tool.poetry"), "name")
    return name ? [{ prefix: name.replace(/-/g, "_"), directory: "" }] : []
  })

export const collectPackageMappings = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  repoPath: string
): Effect.Effect<readonly PackageMapping[]> =>
  Effect.gen(function* () {
    const groups = yield* Effect.all(
      [
        npmMappings(fs, path, repoPath),
        goMappings(fs, path, repoPath),
        cargoMappings(fs, path, repoPath),
        pythonMappings(fs, path, repoPath)
      ],
      { concurrency: 1 }
    )

    const byPrefix = new Map<string, PackageMapping>()
    for (const mapping of groups.flat()) {
      if (!byPrefix.has(mapping.prefix)) byPrefix.set(mapping.prefix, mapping)
    }
    return Array.from(byPrefix.values())
  }).pipe(Effect.withSpan("manifest.collectPackageMappings"))
