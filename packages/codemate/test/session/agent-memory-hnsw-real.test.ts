import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { InMemoryAgentMemoryIndex, JsonlAgentMemoryIndex } from "@/session/agent-memory-index"
import { HnswAgentMemoryIndex } from "@/session/agent-memory-hnsw-index"
import type { EmbeddingProvider, EmbeddingVector } from "@/session/embedding"
import { runAgentMemoryIndexContract } from "./agent-memory-index.contract"

type Status = "active" | "quarantined" | "deprecated"

const tmpDirs: string[] = []
const baseTime = Date.parse("2026-01-01T00:00:00.000Z")

afterEach(async () => {
  await Promise.all(
    tmpDirs.splice(0, tmpDirs.length).map((dir) =>
      fs.rm(dir, { recursive: true, force: true }).catch(() => undefined),
    ),
  )
})

async function createProjectRoot() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codemate-agent-memory-hnsw-real-"))
  tmpDirs.push(dir)
  return dir
}

function iso(offsetMs = 0) {
  return new Date(baseTime + offsetMs).toISOString()
}

function vector(...values: number[]) {
  return values
}

const embedMap = new Map<string, EmbeddingVector>([
  ["ssl verify", vector(1, 0, 0, 0)],
  ["routing", vector(0, 1, 0, 0)],
  ["keyword weak", vector(0.95, 0.05, 0, 0)],
  ["alt", vector(0, 0, 1, 0)],
])

const provider: EmbeddingProvider = {
  providerName: "mapped-embedding-provider",
  dimensions: 4,
  async embedText(text: string) {
    const key = [...embedMap.keys()].find((item) => text.toLowerCase().includes(item))
    if (key) return embedMap.get(key) ?? vector(0, 0, 0, 1)
    return vector(0, 0, 0, 1)
  },
  async embedBatch(texts: string[]) {
    return Promise.all(texts.map((text) => this.embedText(text)))
  },
}

function makeRecord(input: {
  id: string
  text: string
  tags?: string[]
  scope?: "project" | "global"
  status?: Status
  confidence?: number
  embedding?: EmbeddingVector
  updatedAtOffsetMs?: number
}) {
  const time = iso(input.updatedAtOffsetMs ?? 0)
  return {
    id: input.id,
    kind: "lesson" as const,
    scope: input.scope ?? ("project" as const),
    text: input.text,
    tags: input.tags ?? ["memory"],
    confidence: input.confidence ?? 0.92,
    status: input.status ?? ("active" as const),
    created_at: time,
    updated_at: time,
    embedding: input.embedding
      ? {
          vector: input.embedding,
          provider: provider.providerName,
          dimensions: provider.dimensions,
          updated_at: time,
        }
      : undefined,
    metadata: {},
  }
}

runAgentMemoryIndexContract("hnsw-real+memory", async () => ({
  index: new HnswAgentMemoryIndex(new InMemoryAgentMemoryIndex(), provider, {
    hnswEnabled: true,
  }),
}))

runAgentMemoryIndexContract("hnsw-real+jsonl", async () => {
  const projectRoot = await createProjectRoot()
  return {
    index: new HnswAgentMemoryIndex(new JsonlAgentMemoryIndex({ projectRoot }), provider, {
      hnswEnabled: true,
      projectRoot,
    }),
    filePath: path.join(projectRoot, ".codemate", "agent-memory-index.jsonl"),
  }
})

describe("session.agent-memory-hnsw-real", () => {
  test("real hnsw backend indexes and retrieves semantic neighbors", async () => {
    const index = new HnswAgentMemoryIndex(new InMemoryAgentMemoryIndex(), provider, { hnswEnabled: true })
    await index.upsert(makeRecord({ id: "ssl", text: "SSL certificate verification", embedding: vector(1, 0, 0, 0) }))
    await index.upsert(makeRecord({ id: "routing", text: "Provider routing fallback", embedding: vector(0, 1, 0, 0) }))

    const result = await index.search("ssl verify", { limit: 2 })
    expect(result[0]?.id).toBe("ssl")
  })

  test("search uses vector similarity even with weak keyword overlap", async () => {
    const index = new HnswAgentMemoryIndex(new InMemoryAgentMemoryIndex(), provider, { hnswEnabled: true })
    await index.upsert(
      makeRecord({
        id: "semantic",
        text: "artifact continuity constraint",
        tags: ["opaque"],
        embedding: vector(0.95, 0.05, 0, 0),
      }),
    )
    await index.upsert(
      makeRecord({
        id: "keyword",
        text: "keyword weak exact string match",
        tags: ["keyword"],
        embedding: vector(0, 1, 0, 0),
      }),
    )

    const result = await index.search("keyword weak", { limit: 2 })
    expect(result.map((item) => item.id)).toContain("semantic")
  })

  test("active-only default respected; includeInactive enables quarantined/deprecated", async () => {
    const index = new HnswAgentMemoryIndex(new InMemoryAgentMemoryIndex(), provider, { hnswEnabled: true })
    await index.upsert(makeRecord({ id: "active", text: "ssl verify active", embedding: vector(1, 0, 0, 0), status: "active" }))
    await index.upsert(makeRecord({ id: "quarantine", text: "ssl verify quarantined", embedding: vector(1, 0, 0, 0), status: "quarantined" }))

    const activeOnly = await index.search("ssl verify", { limit: 5 })
    expect(activeOnly.map((item) => item.id)).toContain("active")
    expect(activeOnly.map((item) => item.id)).not.toContain("quarantine")

    const includeInactive = await index.search("ssl verify", { includeInactive: true, limit: 5 })
    expect(includeInactive.map((item) => item.id)).toContain("quarantine")
  })

  test("global confidence threshold and scope/kind filters respected", async () => {
    const index = new HnswAgentMemoryIndex(new InMemoryAgentMemoryIndex(), provider, { hnswEnabled: true })
    await index.upsert(
      makeRecord({
        id: "global-low",
        text: "ssl verify low",
        scope: "global",
        confidence: 0.79,
        embedding: vector(1, 0, 0, 0),
      }),
    )
    await index.upsert(
      makeRecord({
        id: "global-high",
        text: "ssl verify high",
        scope: "global",
        confidence: 0.92,
        embedding: vector(1, 0, 0, 0),
      }),
    )

    const byDefault = await index.search("ssl verify", { limit: 5 })
    expect(byDefault.map((item) => item.id)).toContain("global-high")
    expect(byDefault.map((item) => item.id)).not.toContain("global-low")

    const projectOnly = await index.search("ssl verify", { scope: "project", limit: 5 })
    expect(projectOnly.some((item) => item.scope === "global")).toBe(false)
  })

  test("delete removes from vector search and newer upsert replaces old vector", async () => {
    const index = new HnswAgentMemoryIndex(new InMemoryAgentMemoryIndex(), provider, { hnswEnabled: true })
    await index.upsert(
      makeRecord({ id: "replace", text: "alt", embedding: vector(0, 0, 1, 0), updatedAtOffsetMs: 1000 }),
    )
    await index.upsert(
      makeRecord({ id: "replace", text: "ssl verify", embedding: vector(1, 0, 0, 0), updatedAtOffsetMs: 3000 }),
    )
    const replaced = await index.search("ssl verify", { limit: 3 })
    expect(replaced[0]?.id).toBe("replace")

    const removed = await index.delete("replace")
    expect(removed).toBe(true)
    const afterDelete = await index.search("ssl verify", { includeInactive: true, limit: 3 })
    expect(afterDelete.map((item) => item.id)).not.toContain("replace")
  })

  test("persisted or rebuilt index keeps semantic ranking across new instance", async () => {
    const projectRoot = await createProjectRoot()
    const create = () =>
      new HnswAgentMemoryIndex(new JsonlAgentMemoryIndex({ projectRoot }), provider, {
        hnswEnabled: true,
        projectRoot,
      })

    const first = create()
    await first.upsert(makeRecord({ id: "persist-a", text: "ssl verify", embedding: vector(1, 0, 0, 0) }))
    await first.upsert(makeRecord({ id: "persist-b", text: "routing", embedding: vector(0, 1, 0, 0) }))
    const expected = await first.search("ssl verify", { limit: 2 })

    const second = create()
    const actual = await second.search("ssl verify", { limit: 2 })
    expect(actual.map((item) => item.id)).toEqual(expected.map((item) => item.id))
  })
})
