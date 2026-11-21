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
  commentPattern: RegExp
): string => {
  const collected: string[] = []
  let cursor = startLineIndex - 1
  while (cursor >= 0) {
    const line = lines[cursor] ?? ""
    if (line.trim() === "") {
      if (collected.length === 0) {
        cursor -= 1
        continue
      }
      break
    }
    if (!commentPattern.test(line)) break
    collected.unshift(line)
    cursor -= 1
  }
  return trimDoc(collected.join("\n").replace(/^\s*(?:\/\/+|#+|\/\*+|\*+)\s?/gm, ""))
}
