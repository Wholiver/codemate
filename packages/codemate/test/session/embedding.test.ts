import { describe, expect, test } from "bun:test"
import {
  DeterministicEmbeddingProvider,
  buildMemoryEmbeddingText,
  cosineSimilarity,
  hybridMemoryScore,
  normalizeVector,
} from "@/session/embedding"

describe("session.embedding", () => {
  test("deterministic embedding is stable for same text", async () => {
    const provider = new DeterministicEmbeddingProvider({ dimensions: 24 })
    const v1 = await provider.embedText("release lockfile verification")
    const v2 = await provider.embedText("release lockfile verification")
    const v3 = await provider.embedText("different content")

    expect(v1.length).toBe(24)
    expect(v1).toEqual(v2)
    expect(v1).not.toEqual(v3)

    const batch = await provider.embedBatch(["release lockfile verification", "different content"])
    expect(batch.length).toBe(2)
    expect(batch[0]).toEqual(v1)
    expect(batch[1]).toEqual(v3)
  })

  test("cosine similarity and normalizeVector work", () => {
    const unit = normalizeVector([3, 4])
    expect(unit[0]).toBeCloseTo(0.6)
    expect(unit[1]).toBeCloseTo(0.8)

    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1)
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0)
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1)
    expect(cosineSimilarity([1, 0], [1, 0, 1])).toBe(0)
  })

  test("buildMemoryEmbeddingText excludes unsafe raw fields", () => {
    const text = buildMemoryEmbeddingText({
      kind: "failure_recovery",
      scope: "project",
      text: [
        "-----BEGIN PRIVATE KEY-----\\nMIIEvwIBADANBgkqhki...\\n-----END PRIVATE KEY-----",
        "Authorization: Bearer sk-very-secret-token-value",
      ].join("\n"),
      tags: ["tls", "failure"],
      metadata: {
        summary: "when tls path mismatch, recover by correcting path",
        repair_action: "set token=abc123 and rerun checks",
        raw_tool_log: "should not be included",
        transcript: "should not be included",
      },
    })

    expect(text).toContain("kind: failure_recovery")
    expect(text).toContain("scope: project")
    expect(text).toContain("summary:")
    expect(text).toContain("repair_action:")
    expect(text).not.toContain("BEGIN PRIVATE KEY")
    expect(text).not.toContain("MIIEvwIB")
    expect(text).not.toContain("sk-very-secret-token-value")
    expect(text).not.toContain("raw_tool_log")
    expect(text).not.toContain("transcript")
    expect(text).toContain("[REDACTED_PRIVATE_KEY_BLOCK]")
  })

  test("hybridMemoryScore weights work", () => {
    const keywordDominant = hybridMemoryScore(1, 0.2, { keyword: 0.9, semantic: 0.1 })
    const semanticDominant = hybridMemoryScore(1, 0.2, { keyword: 0.1, semantic: 0.9 })
    expect(keywordDominant).toBeGreaterThan(semanticDominant)

    const equal = hybridMemoryScore(0.8, 0.2, { keyword: 1, semantic: 1 })
    expect(equal).toBeCloseTo(0.5)

    const zeroWeights = hybridMemoryScore(0.8, 0.2, { keyword: 0, semantic: 0 })
    expect(zeroWeights).toBe(0)
  })
})
