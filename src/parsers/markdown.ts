import type { ParsedEdge, ParsedSymbol } from "../domain/models.js"
import { normalizeSignature, trimDoc } from "./doc.js"
import type { SourceParser } from "./types.js"

interface Heading {
  readonly level: number
  readonly text: string
  readonly line: number
}

const headingPattern = /^(#{1,6})\s+(.+?)\s*#*\s*$/
const fencePattern = /^\s*(```+|~~~+)/

const isDecisionPath = (filePath: string): boolean =>
  /(^|\/)docs\/adr\//i.test(filePath) ||
  /(^|\/)adr[-/][^/]*\.mdx?$/i.test(filePath) ||
  /(^|\/)decisions?\//i.test(filePath)

const cleanHeading = (text: string): string =>
  text
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()

const mentionTokens = (
  body: string
): readonly { readonly token: string; readonly line: number }[] => {
  const mentions: { token: string; line: number }[] = []
  const lines = body.split("\n")
  lines.forEach((lineText, index) => {
    for (const match of lineText.matchAll(/`([^`\n]+)`/g)) {
      const raw = (match[1] ?? "").trim()
      const withoutCall = raw.replace(/\([\s\S]*$/, "")
      const token = withoutCall
        .replace(/^this\./, "")
        .replace(/::/g, ".")
        .replace(/[.,;:]+$/, "")
      if (!/^[A-Za-z_$][\w$.:-]*$/.test(token)) continue
      if (token.includes("/") || token.length < 2) continue
      mentions.push({ token, line: index })
    }
  })
  return mentions
}

export const parseMarkdownFile: SourceParser["parse"] = (filePath, content) => {
  const lines = content.split("\n")
  const headings: Heading[] = []
  let fence: string | undefined

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ""
    const fenceMatch = line.match(fencePattern)
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? "```"
      if (fence === undefined) fence = marker[0]
      else if (marker[0] === fence) fence = undefined
      continue
    }
    if (fence !== undefined) continue
    const match = line.match(headingPattern)
    if (!match) continue
    const level = match[1]?.length ?? 1
    const text = cleanHeading(match[2] ?? "")
    if (text.length === 0) continue
    headings.push({ level, text, line: index + 1 })
  }

  const decision = isDecisionPath(filePath)
  const symbols: ParsedSymbol[] = []
  const edges: ParsedEdge[] = []
  const edgeKeys = new Set<string>()

  const addEdge = (edge: ParsedEdge) => {
    const key = `${edge.srcName}->${edge.dstName}:${edge.kind}`
    if (edgeKeys.has(key)) return
    edgeKeys.add(key)
    edges.push(edge)
  }

  const stack: Heading[] = []

  for (let index = 0; index < headings.length; index++) {
    const heading = headings[index]
    if (!heading) continue
    while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= heading.level) {
      stack.pop()
    }
    const parent = stack[stack.length - 1]
    const next = headings[index + 1]
    const endLine = Math.max(heading.line, next ? next.line - 1 : lines.length)
    const body = lines.slice(heading.line, endLine).join("\n")

    symbols.push({
      name: heading.text,
      kind: decision ? "decision" : "doc",
      startLine: heading.line,
      endLine,
      signature: normalizeSignature(`#${"#".repeat(heading.level - 1)} ${heading.text}`),
      exported: true,
      visibility: "public",
      doc: trimDoc(body),
      ...(parent ? { containerName: parent.text } : {})
    })

    if (parent) {
      addEdge({
        srcName: parent.text,
        dstName: heading.text,
        kind: "contains",
        srcLine: heading.line
      })
    }

    for (const mention of mentionTokens(body)) {
      addEdge({
        srcName: heading.text,
        dstName: mention.token,
        kind: "mentions",
        srcLine: heading.line + 1 + mention.line
      })
    }

    stack.push(heading)
  }

  return {
    path: filePath,
    symbols,
    edges,
    parseStatus: "parsed"
  }
}
