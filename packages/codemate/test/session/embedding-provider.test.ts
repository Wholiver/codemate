import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createAgentMemoryIndex } from "@/session/agent-memory-config"
import {
  DeterministicEmbeddingProvider,
  createEmbeddingProvider,
} from "@/session/embedding"

const originalFetch = globalThis.fetch
const tmpDirs: string[] = []

function setMockFetch(fn: (...args: any[]) => Promise<Response>) {
  globalThis.fetch = fn as unknown as typeof fetch
}

afterEach(async () => {
  globalThis.fetch = originalFetch
  delete process.env.EMBEDDING_API_KEY
  delete process.env.MISSING_EMBEDDING_KEY
  await Promise.all(
    tmpDirs.splice(0, tmpDirs.length).map((dir) =>
      fs.rm(dir, { recursive: true, force: true }).catch(() => undefined),
    ),
  )
})

async function createProjectRoot() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codemate-embedding-provider-"))
  tmpDirs.push(dir)
  return dir
}

describe("session.embedding-provider", () => {
  test("default off returns undefined", () => {
    const missing = createEmbeddingProvider(undefined)
    expect(missing.provider).toBeUndefined()

    const off = createEmbeddingProvider({
      enabled: false,
      provider: "off",
    })
    expect(off.provider).toBeUndefined()
    expect(off.warnings.length).toBe(0)
  })

  test("deterministic provider works when enabled", async () => {
    const selected = createEmbeddingProvider({
      enabled: true,
      provider: "deterministic",
      dimensions: 24,
    })
    expect(selected.provider).toBeInstanceOf(DeterministicEmbeddingProvider)
    expect(selected.warnings.length).toBe(0)
    const vector = await selected.provider!.embedText("release lockfile verification")
    expect(vector.length).toBe(24)
  })

  test("openai-compatible missing api key env returns warning/no provider", () => {
    const selected = createEmbeddingProvider({
      enabled: true,
      provider: "openai-compatible",
      openaiCompatible: {
        baseUrl: "https://example.invalid/v1",
        apiKeyEnv: "MISSING_EMBEDDING_KEY",
        model: "text-embedding-3-small",
      },
    })
    expect(selected.provider).toBeUndefined()
    expect(selected.warnings.join("\n")).toContain("provider disabled")
    expect(selected.warnings.join("\n")).toContain("MISSING_EMBEDDING_KEY")
  })

  test("openai-compatible mocked fetch returns embedding", async () => {
    process.env.EMBEDDING_API_KEY = "sk-test-embedding-key"
    setMockFetch(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
      const input = Array.isArray(body.input) ? body.input : []
      return new Response(
        JSON.stringify({
          data: input.map((_, index) => ({ embedding: index === 0 ? [0.1, 0.2] : [0.3, 0.4] })),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    })

    const selected = createEmbeddingProvider({
      enabled: true,
      provider: "openai-compatible",
      openaiCompatible: {
        baseUrl: "https://example.invalid/v1",
        apiKeyEnv: "EMBEDDING_API_KEY",
        model: "text-embedding-3-small",
      },
    })
    expect(selected.provider).toBeDefined()
    const vector = await selected.provider!.embedText("first")
    expect(vector).toEqual([0.1, 0.2])
    const batch = await selected.provider!.embedBatch(["first", "second"])
    expect(batch).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ])
  })

  test("openai-compatible HTTP error safe message without key/input leak", async () => {
    const secretKey = "sk-super-secret-provider-key"
    const secretInput = "VERY_SECRET_USER_TEXT_SHOULD_NOT_LEAK"
    process.env.EMBEDDING_API_KEY = secretKey
    setMockFetch(async () =>
      new Response(
        JSON.stringify({
          error: {
            message: `${secretInput} ${secretKey}`,
          },
        }),
        { status: 401, statusText: "Unauthorized", headers: { "content-type": "application/json" } },
      ))

    const selected = createEmbeddingProvider({
      enabled: true,
      provider: "openai-compatible",
      openaiCompatible: {
        baseUrl: "https://example.invalid/v1",
        apiKeyEnv: "EMBEDDING_API_KEY",
        model: "text-embedding-3-small",
      },
    })
    await expect(selected.provider!.embedText(secretInput)).rejects.toThrow(/HTTP 401/)
    await selected.provider!.embedText(secretInput).catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).not.toContain(secretKey)
      expect(message).not.toContain(secretInput)
      expect(message).toContain("openai-compatible")
    })
  })

  test("local-http mocked fetch supports single embedding response", async () => {
    setMockFetch(async () =>
      new Response(JSON.stringify({ embedding: [1, 2, 3] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))

    const selected = createEmbeddingProvider({
      enabled: true,
      provider: "local-http",
      localHttp: {
        url: "http://127.0.0.1:5000/embed",
      },
    })
    const vector = await selected.provider!.embedText("hello")
    expect(vector).toEqual([1, 2, 3])
  })

  test("local-http mocked fetch supports batch/openai-compatible response", async () => {
    setMockFetch(async () =>
      new Response(
        JSON.stringify({
          data: [{ embedding: [1, 0] }, { embedding: [0, 1] }],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ))

    const selected = createEmbeddingProvider({
      enabled: true,
      provider: "local-http",
      localHttp: {
        url: "http://127.0.0.1:5000/embed",
        model: "mini-embed",
      },
    })
    const batch = await selected.provider!.embedBatch(["one", "two"])
    expect(batch).toEqual([
      [1, 0],
      [0, 1],
    ])
  })

  test("timeout handled safely", async () => {
    setMockFetch((_: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("The operation was aborted", "AbortError")),
            { once: true },
          )
        }))

    const selected = createEmbeddingProvider({
      enabled: true,
      provider: "local-http",
      localHttp: {
        url: "http://127.0.0.1:5000/embed",
        timeoutMs: 20,
      },
    })
    await expect(selected.provider!.embedText("timeout")).rejects.toThrow(/timed out/)
  })

  test("createAgentMemoryIndex hybrid with unavailable embedding falls back", async () => {
    const projectRoot = await createProjectRoot()
    const selected = createAgentMemoryIndex(projectRoot, {
      backend: "hybrid-memory",
      embedding: {
        enabled: true,
        provider: "local-http",
        localHttp: {},
      },
    })
    expect(selected.warnings.join("\n")).toContain("provider unavailable")
    expect(selected.warnings.join("\n")).toContain("fallback to \"memory\"")
  })

  test("default AgentMemoryIndex behavior unchanged", async () => {
    const projectRoot = await createProjectRoot()
    const selected = createAgentMemoryIndex(projectRoot)
    expect(selected.config.backend).toBe("jsonl")
    expect(selected.config.embedding?.enabled).toBe(false)
    expect(selected.config.embedding?.provider).toBe("off")
    expect(selected.warnings.length).toBe(0)
  })
})
