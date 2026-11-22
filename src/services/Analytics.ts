import * as SqlClient from "@effect/sql/SqlClient"
import { Context, Effect, Layer } from "effect"
import { StoreError } from "../domain/errors.js"

export type RankingAlgorithm = "pagerank" | "in_degree" | "complexity"
export type CycleLevel = "symbol" | "file" | "package"
export type CommunityLevel = "symbol" | "file"

export interface RankedSymbol {
  readonly id: string
  readonly name: string
  readonly kind: string
  readonly filePath: string
  readonly startLine: number
  readonly score: number
  readonly inDegree: number
  readonly outDegree: number
  readonly cyclomatic: number
  readonly cognitive: number
}

export interface HotspotSymbol extends RankedSymbol {
  readonly fanIn: number
  readonly fanOut: number
}

export interface DeadCodeSymbol {
  readonly id: string
  readonly name: string
  readonly kind: string
  readonly filePath: string
  readonly startLine: number
  readonly language: string
}

export interface CycleMember {
  readonly id: string
  readonly name?: string
  readonly filePath: string
  readonly startLine?: number
}

export interface CommunityMember {
  readonly id: string
  readonly name?: string
  readonly filePath: string
  readonly startLine?: number
}

export interface CommunityGroup {
  readonly level: CommunityLevel
  readonly label: string
  readonly size: number
  readonly members: readonly CommunityMember[]
}

export interface PackageRanking {
  readonly name: string
  readonly files: number
  readonly symbols: number
  readonly fanIn: number
  readonly fanOut: number
  readonly score: number
}

export interface CycleGroup {
  readonly level: CycleLevel
  readonly size: number
  readonly members: readonly CycleMember[]
}

export interface Analytics {
  readonly rank: (
    repoId: string,
    options?: { readonly algorithm?: RankingAlgorithm; readonly limit?: number }
  ) => Effect.Effect<readonly RankedSymbol[], StoreError>
  readonly hotspots: (
    repoId: string,
    options?: { readonly limit?: number }
  ) => Effect.Effect<readonly HotspotSymbol[], StoreError>
  readonly deadCode: (
    repoId: string,
    options?: { readonly limit?: number }
  ) => Effect.Effect<readonly DeadCodeSymbol[], StoreError>
  readonly cycles: (
    repoId: string,
    options?: { readonly level?: CycleLevel; readonly limit?: number }
  ) => Effect.Effect<readonly CycleGroup[], StoreError>
  readonly communities: (
    repoId: string,
    options?: { readonly level?: CommunityLevel; readonly limit?: number }
  ) => Effect.Effect<readonly CommunityGroup[], StoreError>
  readonly packageRankings: (
    repoId: string,
    options?: { readonly limit?: number }
  ) => Effect.Effect<readonly PackageRanking[], StoreError>
}

export const Analytics = Context.GenericTag<Analytics>("@codegraph/Analytics")

interface SymbolRow {
  readonly id: string
  readonly name: string
  readonly kind: string
  readonly filePath: string
  readonly startLine: number
  readonly language: string
  readonly exported: number
  readonly cyclomatic: number
  readonly cognitive: number
}

interface EdgeRow {
  readonly src: string
  readonly dst: string
}

const CALL_KINDS = ["call", "call_reference"]

const clampLimit = (value: number | undefined, fallback: number, max = 200): number =>
  Math.max(1, Math.min(max, value ?? fallback))

// Tarjan's strongly connected components, iterative to avoid deep recursion.
const stronglyConnected = (
  nodes: readonly string[],
  adjacency: ReadonlyMap<string, readonly string[]>
): readonly (readonly string[])[] => {
  let index = 0
  const indices = new Map<string, number>()
  const lowlink = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const components: string[][] = []

  for (const start of nodes) {
    if (indices.has(start)) continue

    const work: Array<{ readonly node: string; readonly edge: number }> = [{ node: start, edge: 0 }]
    indices.set(start, index)
    lowlink.set(start, index)
    index++
    stack.push(start)
    onStack.add(start)

    while (work.length > 0) {
      const frame = work[work.length - 1]
      if (!frame) break
      const neighbors = adjacency.get(frame.node) ?? []

      if (frame.edge < neighbors.length) {
        const neighbor = neighbors[frame.edge] as string
        work[work.length - 1] = { node: frame.node, edge: frame.edge + 1 }
        if (!indices.has(neighbor)) {
          indices.set(neighbor, index)
          lowlink.set(neighbor, index)
          index++
          stack.push(neighbor)
          onStack.add(neighbor)
          work.push({ node: neighbor, edge: 0 })
        } else if (onStack.has(neighbor)) {
          lowlink.set(
            frame.node,
            Math.min(lowlink.get(frame.node) ?? 0, indices.get(neighbor) ?? 0)
          )
        }
        continue
      }

      work.pop()
      const parent = work[work.length - 1]
      if (parent) {
        lowlink.set(
          parent.node,
          Math.min(lowlink.get(parent.node) ?? 0, lowlink.get(frame.node) ?? 0)
        )
      }

      if (lowlink.get(frame.node) === indices.get(frame.node)) {
        const component: string[] = []
        for (;;) {
          const member = stack.pop()
          if (member === undefined) break
          onStack.delete(member)
          component.push(member)
          if (member === frame.node) break
        }
        components.push(component)
      }
    }
  }

  return components
}

const adjacencyOf = (edges: readonly EdgeRow[]): Map<string, string[]> => {
  const adjacency = new Map<string, string[]>()
  for (const edge of edges) {
    const list = adjacency.get(edge.src) ?? []
    list.push(edge.dst)
    adjacency.set(edge.src, list)
  }
  return adjacency
}

const undirectedAdjacencyOf = (edges: readonly EdgeRow[]): Map<string, string[]> => {
  const adjacency = new Map<string, string[]>()
  const add = (from: string, to: string) => {
    const list = adjacency.get(from) ?? []
    list.push(to)
    adjacency.set(from, list)
  }
  for (const edge of edges) {
    add(edge.src, edge.dst)
    add(edge.dst, edge.src)
  }
  return adjacency
}

const packageOfPath = (filePath: string): string => {
  const slash = filePath.indexOf("/")
  return slash === -1 ? "." : filePath.slice(0, slash)
}

// Deterministic label propagation over an undirected graph.
const labelPropagation = (
  nodes: readonly string[],
  adjacency: ReadonlyMap<string, readonly string[]>
): ReadonlyMap<string, string> => {
  const labels = new Map(nodes.map((node) => [node, node]))
  const ordered = [...nodes].sort()

  for (let iteration = 0; iteration < 30; iteration++) {
    let changed = false
    for (const node of ordered) {
      const counts = new Map<string, number>()
      for (const neighbor of adjacency.get(node) ?? []) {
        const label = labels.get(neighbor)
        if (label === undefined) continue
        counts.set(label, (counts.get(label) ?? 0) + 1)
      }
      let best: string | undefined
      let bestCount = -1
      for (const [label, count] of counts) {
        if (count > bestCount || (count === bestCount && best !== undefined && label < best)) {
          best = label
          bestCount = count
        }
      }
      if (best !== undefined && best !== labels.get(node)) {
        labels.set(node, best)
        changed = true
      }
    }
    if (!changed) break
  }

  return labels
}

export const AnalyticsLive = Layer.effect(
  Analytics,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const loadSymbols = (repoId: string): Effect.Effect<readonly SymbolRow[], StoreError> =>
      sql<SymbolRow>`
        SELECT s.id, s.name, s.kind, f.path as filePath, s.start_line as startLine,
               COALESCE(NULLIF(s.language, ''), 'unknown') as language, s.exported,
               s.cyclomatic, s.cognitive
        FROM symbols s
        JOIN files f ON s.file_id = f.id
        WHERE f.repo_id = ${repoId};
      `.pipe(
        Effect.mapError(
          (e) => new StoreError({ message: "Analytics symbol query failed", cause: e })
        )
      )

    const loadCallEdges = (repoId: string): Effect.Effect<readonly EdgeRow[], StoreError> =>
      sql<EdgeRow>`
        SELECT e.src_symbol_id as src, e.dst_symbol_id as dst
        FROM edges e
        JOIN symbols s ON e.src_symbol_id = s.id
        JOIN files f ON s.file_id = f.id
        WHERE f.repo_id = ${repoId}
          AND e.kind IN ${sql.in(CALL_KINDS)}
          AND EXISTS (
            SELECT 1 FROM symbols target
            JOIN files target_file ON target.file_id = target_file.id
            WHERE target.id = e.dst_symbol_id AND target_file.repo_id = ${repoId}
          );
      `.pipe(
        Effect.mapError((e) => new StoreError({ message: "Analytics edge query failed", cause: e }))
      )

    const loadFileGraph = (
      repoId: string
    ): Effect.Effect<
      {
        readonly fileRows: readonly { readonly id: string; readonly path: string }[]
        readonly edges: readonly EdgeRow[]
      },
      StoreError
    > =>
      Effect.gen(function* () {
        const fileRows = yield* sql<{ id: string; path: string }>`
          SELECT id, path FROM files WHERE repo_id = ${repoId};
        `.pipe(
          Effect.mapError(
            (e) => new StoreError({ message: "Analytics file query failed", cause: e })
          )
        )

        const importEdges = yield* sql<EdgeRow>`
          SELECT src_file_id as src, dst_file_id as dst
          FROM file_edges
          WHERE repo_id = ${repoId} AND kind = 'imports' AND dst_file_id IS NOT NULL;
        `.pipe(
          Effect.mapError(
            (e) => new StoreError({ message: "Analytics import query failed", cause: e })
          )
        )

        const crossFileCalls = yield* sql<EdgeRow>`
          SELECT DISTINCT f1.id as src, f2.id as dst
          FROM edges e
          JOIN symbols s1 ON e.src_symbol_id = s1.id
          JOIN files f1 ON s1.file_id = f1.id
          JOIN symbols s2 ON e.dst_symbol_id = s2.id
          JOIN files f2 ON s2.file_id = f2.id
          WHERE f1.repo_id = ${repoId}
            AND f1.id <> f2.id
            AND e.kind IN ${sql.in(CALL_KINDS)};
        `.pipe(
          Effect.mapError(
            (e) => new StoreError({ message: "Analytics cross-file call query failed", cause: e })
          )
        )

        return { fileRows, edges: [...importEdges, ...crossFileCalls] }
      })

    const rank = (
      repoId: string,
      options: { readonly algorithm?: RankingAlgorithm; readonly limit?: number } = {}
    ): Effect.Effect<readonly RankedSymbol[], StoreError> =>
      Effect.gen(function* () {
        const symbols = yield* loadSymbols(repoId)
        const edges = yield* loadCallEdges(repoId)
        const limit = clampLimit(options.limit, 20)

        if (symbols.length === 0) return []

        const inDegree = new Map<string, number>()
        const outDegree = new Map<string, number>()
        for (const edge of edges) {
          outDegree.set(edge.src, (outDegree.get(edge.src) ?? 0) + 1)
          inDegree.set(edge.dst, (inDegree.get(edge.dst) ?? 0) + 1)
        }

        let scores: Map<string, number>
        if (options.algorithm === "in_degree") {
          scores = new Map(symbols.map((symbol) => [symbol.id, inDegree.get(symbol.id) ?? 0]))
        } else if (options.algorithm === "complexity") {
          scores = new Map(
            symbols.map((symbol) => [symbol.id, symbol.cyclomatic * 10 + symbol.cognitive])
          )
        } else {
          const damping = 0.85
          const nodeCount = symbols.length
          let current = new Map(symbols.map((symbol) => [symbol.id, 1 / nodeCount]))
          const adjacency = adjacencyOf(edges)

          for (let iteration = 0; iteration < 20; iteration++) {
            let dangling = 0
            for (const symbol of symbols) {
              if ((adjacency.get(symbol.id) ?? []).length === 0) {
                dangling += current.get(symbol.id) ?? 0
              }
            }

            const next = new Map<string, number>()
            const base = (1 - damping) / nodeCount + (damping * dangling) / nodeCount
            for (const symbol of symbols) next.set(symbol.id, base)

            for (const edge of edges) {
              if (!current.has(edge.src) || !next.has(edge.dst)) continue
              const out = adjacency.get(edge.src)?.length ?? 0
              if (out === 0) continue
              next.set(
                edge.dst,
                (next.get(edge.dst) ?? 0) + (damping * (current.get(edge.src) ?? 0)) / out
              )
            }
            current = next
          }
          scores = current
        }

        return symbols
          .map((symbol) => ({
            id: symbol.id,
            name: symbol.name,
            kind: symbol.kind,
            filePath: symbol.filePath,
            startLine: symbol.startLine,
            score: Number((scores.get(symbol.id) ?? 0).toFixed(6)),
            inDegree: inDegree.get(symbol.id) ?? 0,
            outDegree: outDegree.get(symbol.id) ?? 0,
            cyclomatic: symbol.cyclomatic,
            cognitive: symbol.cognitive
          }))
          .sort(
            (a, b) => b.score - a.score || b.inDegree - a.inDegree || a.name.localeCompare(b.name)
          )
          .slice(0, limit)
      })

    const hotspots = (
      repoId: string,
      options: { readonly limit?: number } = {}
    ): Effect.Effect<readonly HotspotSymbol[], StoreError> =>
      Effect.gen(function* () {
        const symbols = yield* loadSymbols(repoId)
        const edges = yield* loadCallEdges(repoId)
        const limit = clampLimit(options.limit, 20)

        const fanIn = new Map<string, number>()
        const fanOut = new Map<string, number>()
        for (const edge of edges) {
          fanOut.set(edge.src, (fanOut.get(edge.src) ?? 0) + 1)
          fanIn.set(edge.dst, (fanIn.get(edge.dst) ?? 0) + 1)
        }

        return symbols
          .map((symbol) => {
            const incoming = fanIn.get(symbol.id) ?? 0
            const outgoing = fanOut.get(symbol.id) ?? 0
            return {
              id: symbol.id,
              name: symbol.name,
              kind: symbol.kind,
              filePath: symbol.filePath,
              startLine: symbol.startLine,
              score: incoming * 2 + outgoing + symbol.cyclomatic,
              inDegree: incoming,
              outDegree: outgoing,
              cyclomatic: symbol.cyclomatic,
              cognitive: symbol.cognitive,
              fanIn: incoming,
              fanOut: outgoing
            }
          })
          .filter((symbol) => symbol.fanIn > 0 || symbol.fanOut > 0)
          .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
          .slice(0, limit)
      })

    const deadCode = (
      repoId: string,
      options: { readonly limit?: number } = {}
    ): Effect.Effect<readonly DeadCodeSymbol[], StoreError> =>
      Effect.gen(function* () {
        const symbols = yield* loadSymbols(repoId)
        const edges = yield* loadCallEdges(repoId)
        const limit = clampLimit(options.limit, 50)
        const referenced = new Set(edges.map((edge) => edge.dst))
        const candidates = new Set([
          "function",
          "method",
          "class",
          "interface",
          "type",
          "enum",
          "const"
        ])
        const entryPoints = new Set(["main", "constructor", "init"])

        return symbols
          .filter(
            (symbol) =>
              symbol.exported === 0 &&
              candidates.has(symbol.kind) &&
              !entryPoints.has(symbol.name) &&
              !referenced.has(symbol.id)
          )
          .map((symbol) => ({
            id: symbol.id,
            name: symbol.name,
            kind: symbol.kind,
            filePath: symbol.filePath,
            startLine: symbol.startLine,
            language: symbol.language
          }))
          .sort((a, b) => a.filePath.localeCompare(b.filePath) || a.startLine - b.startLine)
          .slice(0, limit)
      })

    const cycles = (
      repoId: string,
      options: { readonly level?: CycleLevel; readonly limit?: number } = {}
    ): Effect.Effect<readonly CycleGroup[], StoreError> =>
      Effect.gen(function* () {
        const level = options.level ?? "symbol"
        const limit = clampLimit(options.limit, 20)

        if (level === "symbol") {
          const symbols = yield* loadSymbols(repoId)
          const edges = yield* loadCallEdges(repoId)
          const nodeIds = symbols.map((symbol) => symbol.id)
          const byId = new Map(symbols.map((symbol) => [symbol.id, symbol]))
          const adjacency = adjacencyOf(edges)
          const selfLoops = new Set(
            edges.filter((edge) => edge.src === edge.dst).map((edge) => edge.src)
          )

          return stronglyConnected(nodeIds, adjacency)
            .filter(
              (component) => component.length > 1 || (component[0] && selfLoops.has(component[0]))
            )
            .map((component) => ({
              level,
              size: component.length,
              members: component.flatMap((id) => {
                const symbol = byId.get(id)
                return symbol
                  ? [
                      {
                        id,
                        name: symbol.name,
                        filePath: symbol.filePath,
                        startLine: symbol.startLine
                      }
                    ]
                  : []
              })
            }))
            .sort((a, b) => b.size - a.size)
            .slice(0, limit)
        }

        if (level === "package") {
          const symbols = yield* loadSymbols(repoId)
          const calls = yield* loadCallEdges(repoId)
          const { fileRows, edges: fileEdges } = yield* loadFileGraph(repoId)
          const filePackage = new Map(fileRows.map((row) => [row.id, packageOfPath(row.path)]))
          const symbolPackage = new Map(
            symbols.map((symbol) => [symbol.id, packageOfPath(symbol.filePath)])
          )

          const packageEdges: EdgeRow[] = []
          for (const edge of calls) {
            const from = symbolPackage.get(edge.src)
            const to = symbolPackage.get(edge.dst)
            if (from && to && from !== to) packageEdges.push({ src: from, dst: to })
          }
          for (const edge of fileEdges) {
            const from = filePackage.get(edge.src)
            const to = filePackage.get(edge.dst)
            if (from && to && from !== to) packageEdges.push({ src: from, dst: to })
          }

          const packages = Array.from(new Set(fileRows.map((row) => packageOfPath(row.path))))
          return stronglyConnected(packages, adjacencyOf(packageEdges))
            .filter((component) => component.length > 1)
            .map((component) => ({
              level,
              size: component.length,
              members: component.map((name) => ({ id: name, name, filePath: name }))
            }))
            .sort((a, b) => b.size - a.size)
            .slice(0, limit)
        }

        const { fileRows, edges: fileEdges } = yield* loadFileGraph(repoId)
        const byId = new Map(fileRows.map((row) => [row.id, row.path]))
        const adjacency = adjacencyOf(fileEdges)
        const selfLoops = new Set(
          fileEdges.filter((edge) => edge.src === edge.dst).map((edge) => edge.src)
        )

        return stronglyConnected(
          fileRows.map((row) => row.id),
          adjacency
        )
          .filter(
            (component) => component.length > 1 || (component[0] && selfLoops.has(component[0]))
          )
          .map((component) => ({
            level,
            size: component.length,
            members: component.flatMap((id) => {
              const filePath = byId.get(id)
              return filePath ? [{ id, filePath }] : []
            })
          }))
          .sort((a, b) => b.size - a.size)
          .slice(0, limit)
      })

    const communities = (
      repoId: string,
      options: { readonly level?: CommunityLevel; readonly limit?: number } = {}
    ): Effect.Effect<readonly CommunityGroup[], StoreError> =>
      Effect.gen(function* () {
        const level = options.level ?? "symbol"
        const limit = clampLimit(options.limit, 20)

        if (level === "symbol") {
          const symbols = yield* loadSymbols(repoId)
          const edges = yield* loadCallEdges(repoId)
          const byId = new Map(symbols.map((symbol) => [symbol.id, symbol]))
          const labels = labelPropagation(
            symbols.map((symbol) => symbol.id),
            undirectedAdjacencyOf(edges)
          )
          const groups = new Map<string, string[]>()
          for (const [node, label] of labels) {
            const list = groups.get(label) ?? []
            list.push(node)
            groups.set(label, list)
          }

          return Array.from(groups.values())
            .filter((members) => members.length > 1)
            .map((members) => {
              const symbolMembers = members.flatMap((id) => {
                const symbol = byId.get(id)
                return symbol
                  ? [
                      {
                        id,
                        name: symbol.name,
                        filePath: symbol.filePath,
                        startLine: symbol.startLine
                      }
                    ]
                  : []
              })
              const counts = new Map<string, number>()
              for (const member of symbolMembers) {
                const pkg = packageOfPath(member.filePath)
                counts.set(pkg, (counts.get(pkg) ?? 0) + 1)
              }
              const label =
                Array.from(counts.entries()).sort(
                  (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
                )[0]?.[0] ?? "group"
              return { level, label, size: symbolMembers.length, members: symbolMembers }
            })
            .sort((a, b) => b.size - a.size)
            .slice(0, limit)
        }

        const { fileRows, edges } = yield* loadFileGraph(repoId)
        const byId = new Map(fileRows.map((row) => [row.id, row.path]))
        const labels = labelPropagation(
          fileRows.map((row) => row.id),
          undirectedAdjacencyOf(edges)
        )
        const groups = new Map<string, string[]>()
        for (const [node, label] of labels) {
          const list = groups.get(label) ?? []
          list.push(node)
          groups.set(label, list)
        }

        return Array.from(groups.values())
          .filter((members) => members.length > 1)
          .map((members) => {
            const fileMembers = members.flatMap((id) => {
              const filePath = byId.get(id)
              return filePath ? [{ id, filePath }] : []
            })
            const counts = new Map<string, number>()
            for (const member of fileMembers) {
              const pkg = packageOfPath(member.filePath)
              counts.set(pkg, (counts.get(pkg) ?? 0) + 1)
            }
            const label =
              Array.from(counts.entries()).sort(
                (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
              )[0]?.[0] ?? "group"
            return { level, label, size: fileMembers.length, members: fileMembers }
          })
          .sort((a, b) => b.size - a.size)
          .slice(0, limit)
      })

    const packageRankings = (
      repoId: string,
      options: { readonly limit?: number } = {}
    ): Effect.Effect<readonly PackageRanking[], StoreError> =>
      Effect.gen(function* () {
        const symbols = yield* loadSymbols(repoId)
        const edges = yield* loadCallEdges(repoId)
        const limit = clampLimit(options.limit, 20)

        const symbolPackage = new Map(
          symbols.map((symbol) => [symbol.id, packageOfPath(symbol.filePath)])
        )
        const stats = new Map<string, { files: Set<string>; symbols: number }>()
        for (const symbol of symbols) {
          const pkg = packageOfPath(symbol.filePath)
          const entry = stats.get(pkg) ?? { files: new Set<string>(), symbols: 0 }
          entry.files.add(symbol.filePath)
          entry.symbols += 1
          stats.set(pkg, entry)
        }

        const fanIn = new Map<string, number>()
        const fanOut = new Map<string, number>()
        for (const edge of edges) {
          const from = symbolPackage.get(edge.src)
          const to = symbolPackage.get(edge.dst)
          if (!from || !to || from === to) continue
          fanOut.set(from, (fanOut.get(from) ?? 0) + 1)
          fanIn.set(to, (fanIn.get(to) ?? 0) + 1)
        }

        return Array.from(stats.entries())
          .map(([name, entry]) => {
            const incoming = fanIn.get(name) ?? 0
            const outgoing = fanOut.get(name) ?? 0
            return {
              name,
              files: entry.files.size,
              symbols: entry.symbols,
              fanIn: incoming,
              fanOut: outgoing,
              score: incoming * 2 + outgoing
            }
          })
          .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
          .slice(0, limit)
      })

    return { rank, hotspots, deadCode, cycles, communities, packageRankings }
  })
)
