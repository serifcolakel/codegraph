import type { ParsedSymbol } from "../domain/models.js"
import { normalizeSignature, trimDoc } from "./doc.js"
import type { SourceParser } from "./types.js"

export const parseTextFile: SourceParser["parse"] = (filePath, content) => {
  const symbols: ParsedSymbol[] = []
  const lines = content.split("\n")
  const baseName = (filePath.split("/").pop() ?? filePath).replace(/\.[^.]+$/, "")
  const trimmed = content.trim()

  if (trimmed.length > 0) {
    const firstLine = lines.find((line) => line.trim().length > 0) ?? baseName
    symbols.push({
      name: baseName.length > 0 ? baseName : filePath,
      kind: "doc",
      startLine: 1,
      endLine: Math.max(1, lines.length),
      signature: normalizeSignature(firstLine),
      exported: true,
      visibility: "public",
      doc: trimDoc(content)
    })
  }

  return { path: filePath, symbols, edges: [], parseStatus: "parsed" }
}
