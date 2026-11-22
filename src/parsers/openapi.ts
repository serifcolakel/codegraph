import type { ParsedSymbol } from "../domain/models.js"
import { normalizeSignature, trimDoc } from "./doc.js"
import type { SourceParser } from "./types.js"

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head"])

const routeSymbol = (
  method: string,
  routePath: string,
  line: number,
  doc?: string
): ParsedSymbol => ({
  name: `${method.toUpperCase()} ${routePath}`,
  kind: "route",
  startLine: line,
  endLine: line,
  signature: normalizeSignature(`${method.toUpperCase()} ${routePath}`),
  exported: true,
  visibility: "public",
  ...(doc ? { doc: trimDoc(doc) } : {})
})

const addRoutes = (
  symbols: ParsedSymbol[],
  seen: Set<string>,
  routePath: string,
  methods: Iterable<readonly [string, string | undefined]>,
  line: number
) => {
  for (const [method, summary] of methods) {
    const key = `${method.toUpperCase()} ${routePath}`
    if (seen.has(key)) continue
    seen.add(key)
    symbols.push(routeSymbol(method, routePath, line, summary))
  }
}

const parseJsonSpec = (content: string): ParsedSymbol[] => {
  const symbols: ParsedSymbol[] = []
  const seen = new Set<string>()
  let document: unknown
  try {
    document = JSON.parse(content)
  } catch {
    return symbols
  }
  if (!document || typeof document !== "object") return symbols
  const paths = (document as Record<string, unknown>).paths
  if (!paths || typeof paths !== "object") return symbols

  for (const [routePath, value] of Object.entries(paths as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue
    const methods: Array<readonly [string, string | undefined]> = []
    for (const [method, operation] of Object.entries(value as Record<string, unknown>)) {
      if (!HTTP_METHODS.has(method.toLowerCase())) continue
      const summary =
        operation && typeof operation === "object"
          ? ((operation as Record<string, unknown>).summary ??
            (operation as Record<string, unknown>).description)
          : undefined
      methods.push([method.toLowerCase(), typeof summary === "string" ? summary : undefined])
    }
    addRoutes(symbols, seen, routePath, methods, 1)
  }

  return symbols
}

const parseYamlSpec = (content: string): ParsedSymbol[] => {
  const symbols: ParsedSymbol[] = []
  const seen = new Set<string>()
  const lines = content.split("\n")
  let inPaths = false
  let pathsIndent = 0
  let currentPath: string | undefined

  lines.forEach((line, index) => {
    const trimmed = line.trim()
    if (trimmed === "" || trimmed.startsWith("#")) return

    const pathsMatch = line.match(/^(\s*)paths:\s*$/)
    if (pathsMatch) {
      inPaths = true
      pathsIndent = pathsMatch[1]?.length ?? 0
      return
    }
    if (!inPaths) return

    const indent = line.match(/^\s*/)?.[0].length ?? 0
    if (indent <= pathsIndent) {
      inPaths = false
      return
    }

    if (indent === pathsIndent + 2) {
      const pathMatch = line.match(/^\s*["']?(\/[^"':]*?)["']?:\s*$/)
      currentPath = pathMatch?.[1]
      return
    }

    if (indent === pathsIndent + 4 && currentPath) {
      const methodMatch = line.match(/^\s*(get|post|put|patch|delete|options|head):\s*$/i)
      if (!methodMatch) return
      const method = methodMatch[1]?.toLowerCase() ?? "get"
      const key = `${method.toUpperCase()} ${currentPath}`
      if (seen.has(key)) return
      seen.add(key)
      symbols.push(routeSymbol(method, currentPath, index + 1))
    }
  })

  return symbols
}

export const parseOpenApiFile: SourceParser["parse"] = (filePath, content) => ({
  path: filePath,
  symbols: /\.json$/i.test(filePath) ? parseJsonSpec(content) : parseYamlSpec(content),
  edges: [],
  parseStatus: "parsed"
})
