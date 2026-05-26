import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { InMemoryAgentMemoryIndex, JsonlAgentMemoryIndex } from "@/session/agent-memory-index"
import { HybridAgentMemoryIndex } from "@/session/agent-memory-hybrid-index"
import { HnswAgentMemoryIndex } from "@/session/agent-memory-hnsw-index"
import { createAgentMemoryIndex, DEFAULT_AGENT_MEMORY_CONFIG } from "@/session/agent-memory-config"

const tmpDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    tmpDirs.splice(0, tmpDirs.length).map((dir) =>
      fs.rm(dir, { recursive: true, force: true }).catch(() => undefined),
    ),
  )
})

async function createProjectRoot() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codemate-agent-memory-config-"))
  tmpDirs.push(dir)
  return dir
}

describe("session.agent-memory-config", () => {
  test("default config returns JsonlAgentMemoryIndex", async () => {
    const projectRoot = await createProjectRoot()
    const selected = createAgentMemoryIndex(projectRoot)
    expect(selected.config.enabled).toBe(true)
    expect(selected.config.backend).toBe("jsonl")
    expect(selected.config.embedding?.enabled).toBe(false)
    expect(selected.config.embedding?.provider).toBe("off")
    expect(selected.index).toBeInstanceOf(JsonlAgentMemoryIndex)
    expect(selected.warnings.length).toBe(0)
  })

  test("enabled=false and off backend disable index", async () => {
    const projectRoot = await createProjectRoot()
    const disabled = createAgentMemoryIndex(projectRoot, { enabled: false, backend: "jsonl" })
    expect(disabled.index).toBeUndefined()
    const off = createAgentMemoryIndex(projectRoot, { enabled: true, backend: "off" })
    expect(off.index).toBeUndefined()
  })

  test("memory backend returns InMemoryAgentMemoryIndex", async () => {
    const projectRoot = await createProjectRoot()
    const selected = createAgentMemoryIndex(projectRoot, { backend: "memory" })
    expect(selected.index).toBeInstanceOf(InMemoryAgentMemoryIndex)
  })

  test("hybrid-jsonl with embedding enabled returns HybridAgentMemoryIndex", async () => {
    const projectRoot = await createProjectRoot()
    const selected = createAgentMemoryIndex(projectRoot, {
      backend: "hybrid-jsonl",
      embedding: { enabled: true, provider: "deterministic", dimensions: 24 },
    })
    expect(selected.index).toBeInstanceOf(HybridAgentMemoryIndex)
    expect(selected.warnings.length).toBe(0)
  })

  test("hybrid-memory with embedding enabled returns HybridAgentMemoryIndex", async () => {
    const projectRoot = await createProjectRoot()
    const selected = createAgentMemoryIndex(projectRoot, {
      backend: "hybrid-memory",
      embedding: { enabled: true, provider: "deterministic", dimensions: 24 },
    })
    expect(selected.index).toBeInstanceOf(HybridAgentMemoryIndex)
    expect(selected.warnings.length).toBe(0)
  })

  test("hybrid requested with embedding disabled falls back to non-hybrid with warning", async () => {
    const projectRoot = await createProjectRoot()
    const jsonl = createAgentMemoryIndex(projectRoot, {
      backend: "hybrid-jsonl",
      embedding: { enabled: false, provider: "off", dimensions: 24 },
    })
    expect(jsonl.index).toBeInstanceOf(JsonlAgentMemoryIndex)
    expect(jsonl.index).not.toBeInstanceOf(HybridAgentMemoryIndex)
    expect(jsonl.warnings.join("\n")).toContain("fallback to \"jsonl\"")

    const memory = createAgentMemoryIndex(projectRoot, {
      backend: "hybrid-memory",
      embedding: { enabled: false, provider: "off", dimensions: 24 },
    })
    expect(memory.index).toBeInstanceOf(InMemoryAgentMemoryIndex)
    expect(memory.index).not.toBeInstanceOf(HybridAgentMemoryIndex)
    expect(memory.warnings.join("\n")).toContain("fallback to \"memory\"")
  })

  test("hnsw-jsonl and hnsw-memory return real HnswAgentMemoryIndex when embedding is available", async () => {
    const projectRoot = await createProjectRoot()
    const hnswJsonl = createAgentMemoryIndex(projectRoot, {
      backend: "hnsw-jsonl",
      embedding: { enabled: true, provider: "deterministic", dimensions: 24 },
    })
    expect(hnswJsonl.index).toBeInstanceOf(HnswAgentMemoryIndex)

    const hnswMemory = createAgentMemoryIndex(projectRoot, {
      backend: "hnsw-memory",
      embedding: { enabled: true, provider: "deterministic", dimensions: 24 },
    })
    expect(hnswMemory.index).toBeInstanceOf(HnswAgentMemoryIndex)
  })

  test("hnsw backends with embedding disabled fall back to non-hybrid backends with warning", async () => {
    const projectRoot = await createProjectRoot()
    const hnswJsonl = createAgentMemoryIndex(projectRoot, {
      backend: "hnsw-jsonl",
      embedding: { enabled: false, provider: "off", dimensions: 24 },
    })
    expect(hnswJsonl.index).toBeInstanceOf(JsonlAgentMemoryIndex)
    expect(hnswJsonl.index).not.toBeInstanceOf(HybridAgentMemoryIndex)
    expect(hnswJsonl.warnings.join("\n")).toContain("fallback to \"jsonl\"")

    const hnswMemory = createAgentMemoryIndex(projectRoot, {
      backend: "hnsw-memory",
      embedding: { enabled: false, provider: "off", dimensions: 24 },
    })
    expect(hnswMemory.index).toBeInstanceOf(InMemoryAgentMemoryIndex)
    expect(hnswMemory.index).not.toBeInstanceOf(HybridAgentMemoryIndex)
    expect(hnswMemory.warnings.join("\n")).toContain("fallback to \"memory\"")
  })

  test("invalid backend falls back to jsonl with warning", async () => {
    const projectRoot = await createProjectRoot()
    const selected = createAgentMemoryIndex(projectRoot, {
      backend: "something-else" as unknown as "jsonl",
    })
    expect(selected.index).toBeInstanceOf(JsonlAgentMemoryIndex)
    expect(selected.config.backend).toBe("jsonl")
    expect(selected.warnings.join("\n")).toContain("invalid agent memory backend")
  })

  test("agentdb backends fallback safely with warning", async () => {
    const projectRoot = await createProjectRoot()
    const plain = createAgentMemoryIndex(projectRoot, {
      backend: "agentdb",
    })
    expect(plain.index).toBeInstanceOf(JsonlAgentMemoryIndex)
    expect(plain.warnings.join("\n")).toContain("agentdb unavailable")

    const hybrid = createAgentMemoryIndex(projectRoot, {
      backend: "agentdb-hybrid",
      embedding: { enabled: true, provider: "deterministic", dimensions: 24 },
    })
    expect(hybrid.index).toBeInstanceOf(HnswAgentMemoryIndex)
    expect(hybrid.warnings.join("\n")).toContain("agentdb unavailable")
  })

  test("hybrid falls back when external embedding provider config is unavailable", async () => {
    const projectRoot = await createProjectRoot()
    const selected = createAgentMemoryIndex(projectRoot, {
      backend: "hybrid-jsonl",
      embedding: {
        enabled: true,
        provider: "openai-compatible",
        dimensions: 24,
        openaiCompatible: {
          baseUrl: "https://example.invalid/v1",
          apiKeyEnv: "MISSING_EMBEDDING_KEY",
          model: "text-embedding-3-small",
        },
      },
    })
    expect(selected.index).toBeInstanceOf(JsonlAgentMemoryIndex)
    expect(selected.index).not.toBeInstanceOf(HybridAgentMemoryIndex)
    expect(selected.warnings.join("\n")).toContain("provider disabled")
    expect(selected.warnings.join("\n")).toContain("fallback to \"jsonl\"")
  })

  test("invalid dimensions use safe default with warning", async () => {
    const projectRoot = await createProjectRoot()
    const selected = createAgentMemoryIndex(projectRoot, {
      backend: "hybrid-memory",
      embedding: { enabled: true, provider: "deterministic", dimensions: -3 },
    })
    expect(selected.index).toBeInstanceOf(HybridAgentMemoryIndex)
    expect(selected.config.embedding?.dimensions).toBe(DEFAULT_AGENT_MEMORY_CONFIG.embedding?.dimensions)
    expect(selected.warnings.join("\n")).toContain("invalid embedding dimensions")
  })

  test("invalid hybrid weights use safe defaults with warning", async () => {
    const projectRoot = await createProjectRoot()
    const selected = createAgentMemoryIndex(projectRoot, {
      backend: "hybrid-memory",
      embedding: { enabled: true, provider: "deterministic", dimensions: 24 },
      hybrid: {
        keywordWeight: -1,
        semanticWeight: Number.NaN,
        candidateMultiplier: -2,
        candidateLimit: 0,
      },
    })
    expect(selected.config.hybrid?.keywordWeight).toBe(DEFAULT_AGENT_MEMORY_CONFIG.hybrid?.keywordWeight)
    expect(selected.config.hybrid?.semanticWeight).toBe(DEFAULT_AGENT_MEMORY_CONFIG.hybrid?.semanticWeight)
    expect(selected.config.hybrid?.candidateMultiplier).toBe(DEFAULT_AGENT_MEMORY_CONFIG.hybrid?.candidateMultiplier)
    expect(selected.config.hybrid?.candidateLimit).toBe(DEFAULT_AGENT_MEMORY_CONFIG.hybrid?.candidateLimit)
    expect(selected.warnings.join("\n")).toContain("invalid hybrid keywordWeight")
    expect(selected.warnings.join("\n")).toContain("invalid hybrid semanticWeight")
    expect(selected.warnings.join("\n")).toContain("invalid hybrid candidateMultiplier")
    expect(selected.warnings.join("\n")).toContain("invalid hybrid candidateLimit")
  })
})
