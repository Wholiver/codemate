import { describe, expect, test } from "bun:test"
import { InMemoryAgentMemoryIndex } from "@/session/agent-memory-index"
import {
  HnswAgentMemoryIndex,
  detectHnswAvailability,
  type HnswVectorAdapter,
} from "@/session/agent-memory-hnsw-index"
import { DeterministicEmbeddingProvider, cosineSimilarity, type EmbeddingProvider, type EmbeddingVector } from "@/session/embedding"

const now = new Date("2026-01-01T00:00:00.000Z").toISOString()

function makeRecord(input?: {
  id?: string
  text?: string
  tags?: string[]
  status?: "active" | "quarantined" | "deprecated"
  scope?: "project" | "global"
  confidence?: number
}) {
  return {
    id: input?.id ?? "memory:r1",
    kind: "lesson" as const,
    scope: input?.scope ?? ("project" as const),
    text: input?.text ?? "tls verification rule",
    tags: input?.tags ?? ["tls", "verification"],
    confidence: input?.confidence ?? 0.9,
    status: input?.status ?? ("active" as const),
    created_at: now,
    updated_at: now,
    metadata: {},
  }
}

class MockHnswAdapter implements HnswVectorAdapter {
  readonly adapterName = "mock-hnsw"
  readonly dimensions: number
  private readonly vectors = new Map<string, EmbeddingVector>()

  constructor(dimensions: number) {
    this.dimensions = dimensions
  }

  async upsert(input: { id: string; vector: EmbeddingVector }) {
    this.vectors.set(input.id, input.vector)
  }

  async search(input: { vector: EmbeddingVector; limit: number }) {
    return [...this.vectors.entries()]
      .map(([id, vector]) => ({ id, score: cosineSimilarity(input.vector, vector) }))
      .toSorted((left, right) => right.score - left.score)
      .slice(0, Math.max(1, input.limit))
  }

  async delete(id: string) {
    this.vectors.delete(id)
  }
}

describe("session.agent-memory-hnsw-index", () => {
  test("detectHnswAvailability reports available runtime backend", () => {
    const availability = detectHnswAvailability()
    expect(availability.available).toBe(true)
  })

  test("disabled hnsw safely falls back to hybrid semantics", async () => {
    const index = new HnswAgentMemoryIndex(new InMemoryAgentMemoryIndex(), new DeterministicEmbeddingProvider({ dimensions: 24 }), {
      hnswEnabled: false,
    })
    await index.upsert(makeRecord({ id: "active-project" }))
    await index.upsert(makeRecord({ id: "quarantined-project", status: "quarantined" }))
    await index.upsert(makeRecord({ id: "global-low", scope: "global", confidence: 0.7 }))
    await index.upsert(makeRecord({ id: "global-high", scope: "global", confidence: 0.9 }))

    const search = await index.search("tls verification")
    expect(search.map((item) => item.id)).toContain("active-project")
    expect(search.map((item) => item.id)).toContain("global-high")
    expect(search.map((item) => item.id)).not.toContain("quarantined-project")
    expect(search.map((item) => item.id)).not.toContain("global-low")
  })

  test("available hnsw search works and delete removes record from results", async () => {
    const provider = new DeterministicEmbeddingProvider({ dimensions: 24 })
    const adapter = new MockHnswAdapter(24)
    const index = new HnswAgentMemoryIndex(new InMemoryAgentMemoryIndex(), provider, { adapter, hnswEnabled: true })
    await index.upsert(makeRecord({ id: "tls-record", text: "tls path mismatch recovery rule", tags: ["tls", "path"] }))
    await index.upsert(makeRecord({ id: "unrelated-record", text: "frontend css style rule", tags: ["ui"] }))
    const first = await index.search("tls path mismatch", { limit: 5 })
    expect(first[0]?.id).toBe("tls-record")

    const removed = await index.delete("tls-record")
    expect(removed).toBe(true)
    const afterDelete = await index.search("tls path mismatch", { limit: 5 })
    expect(afterDelete.map((item) => item.id)).not.toContain("tls-record")
  })

  test("embedding failures fallback safely to keyword search", async () => {
    const provider: EmbeddingProvider = {
      providerName: "failing-provider",
      dimensions: 24,
      embedText: async () => Promise.reject(new Error("embed failed")),
      embedBatch: async () => Promise.reject(new Error("embed batch failed")),
    }
    const adapter = new MockHnswAdapter(24)
    const index = new HnswAgentMemoryIndex(new InMemoryAgentMemoryIndex(), provider, { adapter, hnswEnabled: true })
    await index.upsert(makeRecord({ id: "tls-a", text: "tls cert validation step" }))
    await index.upsert(makeRecord({ id: "tls-b", text: "tls cert writer rule" }))
    const search = await index.search("tls cert", { limit: 2 })
    expect(search.length).toBe(2)
  })
})
