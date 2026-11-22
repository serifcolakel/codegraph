import type { ParsedSymbol } from "../domain/models.js"
import { normalizeSignature, trimDoc } from "./doc.js"
import type { SourceParser } from "./types.js"

const configSymbol = (
  name: string,
  line: number,
  endLine: number,
  signature: string,
  doc?: string
): ParsedSymbol => ({
  name,
  kind: "config",
  startLine: line,
  endLine,
  signature: normalizeSignature(signature),
  exported: true,
  visibility: "public",
  ...(doc ? { doc: trimDoc(doc) } : {})
})

export const parseDockerfile: SourceParser["parse"] = (filePath, content) => {
  const lines = content.split("\n")
  const symbols: ParsedSymbol[] = []

  lines.forEach((line, index) => {
    const match = line.match(/^\s*FROM\s+(\S+)(?:\s+AS\s+(\S+))?/i)
    if (!match) return
    const image = match[1] ?? "image"
    const alias = match[2]
    symbols.push(
      configSymbol(
        `stage:${alias ?? image}`,
        index + 1,
        index + 1,
        line,
        alias ? `image ${image} as ${alias}` : `image ${image}`
      )
    )
  })

  return { path: filePath, symbols, edges: [], parseStatus: "parsed" }
}

const composeSymbols = (lines: readonly string[]): ParsedSymbol[] => {
  const symbols: ParsedSymbol[] = []
  let inServices = false
  let servicesIndent = 0

  lines.forEach((line, index) => {
    const trimmed = line.trim()
    if (trimmed === "" || trimmed.startsWith("#")) return

    const servicesMatch = line.match(/^(\s*)services:\s*(#.*)?$/)
    if (servicesMatch) {
      inServices = true
      servicesIndent = servicesMatch[1]?.length ?? 0
      return
    }
    if (!inServices) return

    const indent = line.match(/^\s*/)?.[0].length ?? 0
    if (indent <= servicesIndent) {
      inServices = false
      return
    }
    if (indent !== servicesIndent + 2) return

    const serviceMatch = line.match(/^\s*([A-Za-z0-9_.-]+):\s*(#.*)?$/)
    const service = serviceMatch?.[1]
    if (!service) return
    symbols.push(configSymbol(`service:${service}`, index + 1, index + 1, line, "compose service"))
  })

  return symbols
}

const kubernetesSymbols = (content: string): ParsedSymbol[] => {
  const symbols: ParsedSymbol[] = []
  const documents = content.split(/^---\s*$/m)

  for (const document of documents) {
    const kind = document.match(/^kind:\s*["']?([A-Za-z0-9_.-]+)/m)?.[1]
    const name = document.match(/^\s{0,4}name:\s*["']?([A-Za-z0-9_.-]+)/m)?.[1]
    if (!kind || !name) continue
    const offset = content.indexOf(document)
    const line = offset <= 0 ? 1 : content.slice(0, offset).split("\n").length
    symbols.push(
      configSymbol(`${kind}:${name}`, line, line, `${kind} ${name}`, "kubernetes resource")
    )
  }

  return symbols
}

const chartSymbols = (filePath: string, content: string): ParsedSymbol[] => {
  if (!/(^|\/)Chart\.yaml$/i.test(filePath)) return []
  const name = content.match(/^name:\s*["']?([^"'\n]+)/m)?.[1]?.trim()
  const version = content.match(/^version:\s*["']?([^"'\n]+)/m)?.[1]?.trim()
  if (!name) return []
  return [
    configSymbol(`chart:${name}`, 1, 1, `Chart ${name}`, version ? `version ${version}` : undefined)
  ]
}

export const parseYamlConfig: SourceParser["parse"] = (filePath, content) => {
  const lines = content.split("\n")
  const symbols = [
    ...chartSymbols(filePath, content),
    ...(/(^|\/)(docker-)?compose[^/]*\.ya?ml$/i.test(filePath) ? composeSymbols(lines) : []),
    ...kubernetesSymbols(content)
  ]

  return { path: filePath, symbols, edges: [], parseStatus: "parsed" }
}
