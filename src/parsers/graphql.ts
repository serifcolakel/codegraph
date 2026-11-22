import type { ParsedSymbol } from "../domain/models.js"
import { leadingComment, normalizeSignature, trimDoc } from "./doc.js"
import type { SourceParser } from "./types.js"

const definitionPattern =
  /^\s*(?:extend\s+)?(type|interface|enum|input|scalar|union)\s+([A-Za-z_]\w*)/

const kindFor = (keyword: string): "type" | "interface" | "enum" =>
  keyword === "interface" ? "interface" : keyword === "enum" ? "enum" : "type"

export const parseGraphqlFile: SourceParser["parse"] = (filePath, content) => {
  const lines = content.split("\n")
  const symbols: ParsedSymbol[] = []
  const definitions: Array<{ keyword: string; name: string; start: number; end: number }> = []

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ""
    const match = line.match(definitionPattern)
    if (!match) continue
    const keyword = match[1] ?? "type"
    const name = match[2] ?? ""
    let depth = (line.match(/{/g) ?? []).length - (line.match(/}/g) ?? []).length
    let end = index
    let cursor = index + 1
    while (depth > 0 && cursor < lines.length) {
      const current = lines[cursor] ?? ""
      depth += (current.match(/{/g) ?? []).length - (current.match(/}/g) ?? []).length
      end = cursor
      cursor++
    }
    definitions.push({ keyword, name, start: index + 1, end: end + 1 })

    symbols.push({
      name,
      kind: kindFor(keyword),
      startLine: index + 1,
      endLine: end + 1,
      signature: normalizeSignature(line.trim()),
      exported: true,
      visibility: "public",
      doc: leadingComment(lines, index, /^\s*#/)
    })
  }

  for (const definition of definitions) {
    if (definition.keyword === "scalar" || definition.keyword === "union") continue
    for (let lineNumber = definition.start; lineNumber < definition.end; lineNumber++) {
      const line = lines[lineNumber] ?? ""
      const fieldMatch =
        definition.keyword === "enum"
          ? line.match(/^\s{2}([A-Za-z_]\w*)\s*$/)
          : line.match(/^\s{2}([A-Za-z_]\w*)\s*(?:\([^)]*\))?\s*:\s*.+$/)
      const field = fieldMatch?.[1]
      if (!field) continue
      symbols.push({
        name: `${definition.name}.${field}`,
        kind: "property",
        startLine: lineNumber + 1,
        endLine: lineNumber + 1,
        signature: normalizeSignature(trimDoc(line).split("\n")[0] ?? field),
        exported: true,
        visibility: "public",
        doc: leadingComment(lines, lineNumber, /^\s*#/),
        containerName: definition.name
      })
    }
  }

  return { path: filePath, symbols, edges: [], parseStatus: "parsed" }
}
