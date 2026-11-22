import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { cosineSimilarity, embedText } from "../src/domain/embeddings.js"

describe("Embeddings", () => {
  it("is deterministic, normalized and semantic for identifier parts", () => {
    const first = embedText("Tracks fund sizes for the dashboard useFundSizes")
    const second = embedText("Tracks fund sizes for the dashboard useFundSizes")
    expect(Array.from(first)).toEqual(Array.from(second))

    const norm = Math.sqrt(Array.from(first).reduce((sum, value) => sum + value * value, 0))
    expect(norm).toBeCloseTo(1, 5)

    const related = embedText("fund size tracking")
    const unrelated = embedText("parse yaml configuration")
    expect(cosineSimilarity(first, related)).toBeGreaterThan(cosineSimilarity(first, unrelated))
  })
})
