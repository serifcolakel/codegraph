const MAX_SIGNATURE_LENGTH = 400
const MAX_DOC_LENGTH = 2000

export const normalizeSignature = (text: string): string => {
  const normalized = text.replace(/\s+/g, " ").trim()
  return normalized.length > MAX_SIGNATURE_LENGTH
    ? `${normalized.slice(0, MAX_SIGNATURE_LENGTH - 3)}...`
    : normalized
}

export const trimDoc = (text: string): string => {
  const cleaned = text
    .split("\n")
    .map((line) => line.replace(/^\s*\*?\s?/, "").trim())
    .filter((line) => line.length > 0)
    .join("\n")
  return cleaned.slice(0, MAX_DOC_LENGTH)
}

// Collects contiguous comment lines directly above a declaration.
export const leadingComment = (
  lines: readonly string[],
  startLineIndex: number,
  commentPattern: RegExp,
  skipPattern?: RegExp
): string => {
  const collected: string[] = []
  let cursor = startLineIndex - 1
  while (cursor >= 0) {
    const line = lines[cursor] ?? ""
    const trimmed = line.trim()
    if (trimmed === "") {
      if (collected.length === 0) {
        cursor -= 1
        continue
      }
      break
    }
    if (skipPattern?.test(line)) {
      cursor -= 1
      continue
    }
    if (trimmed.endsWith("*/")) {
      const block: string[] = []
      let blockCursor = cursor
      while (blockCursor >= 0) {
        const blockLine = lines[blockCursor] ?? ""
        block.unshift(blockLine)
        if (blockLine.includes("/*")) break
        blockCursor -= 1
      }
      return cleanDocText(block.join("\n"))
    }
    if (!commentPattern.test(line)) break
    collected.unshift(line)
    cursor -= 1
  }
  return cleanDocText(collected.join("\n"))
}

const cleanDocText = (text: string): string =>
  trimDoc(
    text
      .replace(/^\s*\/\*+!?/gm, "")
      .replace(/\*\/\s*$/gm, "")
      .replace(/^\s*(?:\/\/+!?|#+|\*+)\s?/gm, "")
  )

// Returns the declaration header up to its body node, if any.
export const headerOf = (
  node: {
    namedChildren: readonly { type: string; startIndex: number }[]
    startIndex: number
    text: string
    childForFieldName?: (name: string) => { startIndex: number } | null
  },
  bodyTypes: readonly string[]
): string => {
  const fieldBody = node.childForFieldName?.("body") ?? null
  const body =
    fieldBody ?? node.namedChildren.find((child) => bodyTypes.includes(child.type)) ?? undefined
  const end = body ? body.startIndex : undefined
  const raw = end === undefined ? node.text : node.text.slice(0, Math.max(0, end - node.startIndex))
  return normalizeSignature(raw.replace(/:\s*$/, ""))
}
