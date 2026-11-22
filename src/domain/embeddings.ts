import { splitIdentifier } from "./naming.js"

// Dependency-free, deterministic, offline embeddings via feature hashing.
// This is a baseline retrieval embedding; the storage and ranking interfaces
// allow swapping in a local model later without changing the schema.
export const EMBEDDING_DIMENSIONS = 256

const FNV_OFFSET = 2166136261
const FNV_PRIME = 16777619

const hashToken = (token: string): number => {
  let hash = FNV_OFFSET
  for (let index = 0; index < token.length; index++) {
    hash ^= token.charCodeAt(index)
    hash = Math.imul(hash, FNV_PRIME)
  }
  return hash >>> 0
}

const tokensOf = (text: string): readonly string[] => {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9_$]+/)
    .filter((word) => word.length > 1)
  const identifierWords = splitIdentifier(text)
  return Array.from(new Set([...words, ...identifierWords]))
}

export const embedText = (text: string): Float32Array => {
  const vector = new Float32Array(EMBEDDING_DIMENSIONS)
  const tokens = tokensOf(text)

  const add = (token: string, weight: number) => {
    const hash = hashToken(token)
    const index = hash % EMBEDDING_DIMENSIONS
    const sign = (hash >>> 17) & 1 ? -1 : 1
    vector[index] = (vector[index] ?? 0) + sign * weight
  }

  for (const token of tokens) add(token, 1)
  for (let index = 0; index < tokens.length - 1; index++) {
    add(`${tokens[index]}_${tokens[index + 1]}`, 0.5)
  }

  let norm = 0
  for (const value of vector) norm += value * value
  norm = Math.sqrt(norm)
  if (norm > 0) {
    for (let index = 0; index < vector.length; index++) {
      vector[index] = (vector[index] ?? 0) / norm
    }
  }
  return vector
}

export const cosineSimilarity = (left: ArrayLike<number>, right: ArrayLike<number>): number => {
  const length = Math.min(left.length, right.length)
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < length; index++) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    dot += a * b
    leftNorm += a * a
    rightNorm += b * b
  }
  if (leftNorm === 0 || rightNorm === 0) return 0
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))
}

export const encodeVector = (vector: Float32Array): Uint8Array =>
  new Uint8Array(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength))

export const decodeVector = (bytes: Uint8Array): Float32Array => {
  const copy = new Uint8Array(bytes)
  return new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4))
}

export interface EmbeddableSymbol {
  readonly name: string
  readonly qualifiedName: string
  readonly kind: string
  readonly signature: string
  readonly doc?: string
}

export const embedSymbol = (symbol: EmbeddableSymbol): Float32Array =>
  embedText(
    [
      symbol.kind,
      symbol.name,
      symbol.qualifiedName,
      symbol.signature,
      (symbol.doc ?? "").slice(0, 1200)
    ].join("\n")
  )
