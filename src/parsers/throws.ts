import type { ParsedFile } from "../domain/models.js"

export type ThrowsKind = "throws" | "raises"

const TAG_PATTERN = /@(?:throws?|raises?|exception)\s+\{?\s*([A-Za-z_][\w.$:]*)/gi
const SPHINX_PATTERN = /:raises?\s+([A-Za-z_][\w.$:]*)\s*:/gi
const GOOGLE_HEADER = /(?:^|\n)[ \t]*Raises?[ \t]*:[ \t]*\n((?:[ \t]+[^\n]+\n?)+)/g

const normalizeException = (value: string): string => {
  const cleaned = value.replace(/^\{|\}$/g, "").trim()
  return (
    cleaned
      .split(/::|\.|:/)
      .filter(Boolean)
      .pop() ?? cleaned
  )
}

export const exceptionsInDoc = (doc: string): readonly string[] => {
  const found = new Set<string>()

  for (const match of doc.matchAll(TAG_PATTERN)) {
    const name = match[1]
    if (name) found.add(normalizeException(name))
  }
  for (const match of doc.matchAll(SPHINX_PATTERN)) {
    const name = match[1]
    if (name) found.add(normalizeException(name))
  }
  for (const block of doc.matchAll(GOOGLE_HEADER)) {
    const body = block[1] ?? ""
    for (const line of body.split("\n")) {
      const name = line.trim().match(/^([A-Za-z_][\w.$:]*)/)?.[1]
      if (name) found.add(normalizeException(name))
    }
  }

  return Array.from(found)
}

// Adds throws/raises edges from doc tags without touching existing edges.
export const withThrowsEdges = (parsed: ParsedFile, kind: ThrowsKind): ParsedFile => {
  const keys = new Set(parsed.edges.map((edge) => `${edge.srcName}->${edge.dstName}:${edge.kind}`))
  const edges = [...parsed.edges]

  for (const symbol of parsed.symbols) {
    for (const exception of exceptionsInDoc(symbol.doc ?? "")) {
      const key = `${symbol.name}->${exception}:${kind}`
      if (keys.has(key)) continue
      keys.add(key)
      edges.push({
        srcName: symbol.name,
        dstName: exception,
        kind,
        srcLine: symbol.startLine
      })
    }
  }

  return edges.length === parsed.edges.length ? parsed : { ...parsed, edges }
}
