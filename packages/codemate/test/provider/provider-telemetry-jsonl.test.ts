import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  JsonlProviderTelemetryStore,
  pathProjectProviderTelemetry,
} from "@/provider/provider-telemetry"
import type { ProviderRouteAttempt } from "@/provider/provider-health"

const tmpDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    tmpDirs.splice(0, tmpDirs.length).map((dir) =>
      fs.rm(dir, { recursive: true, force: true }).catch(() => undefined),
    ),
  )
})

async function createProjectRoot() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codemate-provider-telemetry-"))
  tmpDirs.push(dir)
  return dir
}

function attempt(input: Partial<ProviderRouteAttempt> & { status: ProviderRouteAttempt["status"] }) {
  return {
    provider: input.provider,
    model: input.model,
    agent: input.agent,
    status: input.status,
    error_category: input.error_category,
    retryable: input.retryable,
    latency_ms: input.latency_ms ?? 10,
    fallback_index: input.fallback_index ?? 0,
    created_at: input.created_at ?? "2026-01-01T00:00:00.000Z",
    skipped_due_to_circuit: input.skipped_due_to_circuit,
    circuit_status: input.circuit_status,
    skip_reason: input.skip_reason,
  } satisfies ProviderRouteAttempt
}

describe("provider.provider-telemetry-jsonl", () => {
  test("recordAttempt writes JSONL", async () => {
    const projectRoot = await createProjectRoot()
    const filePath = pathProjectProviderTelemetry(projectRoot)
    const store = new JsonlProviderTelemetryStore({ filePath })

    store.recordAttempt(attempt({ provider: "openai", model: "gpt-5", agent: "coder", status: "success" }))
    store.recordAttempt(
      attempt({
        provider: "anthropic",
        model: "claude-sonnet",
        agent: "coder",
        status: "failure",
        error_category: "timeout",
        retryable: true,
        fallback_index: 1,
      }),
    )

    const lines = (await fs.readFile(filePath, "utf8"))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)

    expect(lines.length).toBe(2)
  })

  test("queryStats reads persisted attempts", async () => {
    const projectRoot = await createProjectRoot()
    const filePath = pathProjectProviderTelemetry(projectRoot)
    const writer = new JsonlProviderTelemetryStore({ filePath })
    writer.recordAttempt(attempt({ provider: "openai", model: "gpt-5", agent: "coder", status: "success", latency_ms: 20 }))
    writer.recordAttempt(
      attempt({
        provider: "openai",
        model: "gpt-5",
        agent: "coder",
        status: "failure",
        error_category: "timeout",
        retryable: true,
        latency_ms: 120,
      }),
    )

    const reader = new JsonlProviderTelemetryStore({ filePath })
    const stats = reader.queryStats({ group_by: ["provider", "model", "agent"] })

    expect(stats.total_attempts).toBe(2)
    expect(stats.buckets[0]?.provider).toBe("openai")
    expect(stats.buckets[0]?.successes).toBe(1)
    expect(stats.buckets[0]?.failures).toBe(1)
  })

  test("filters by provider/model/agent/window", async () => {
    const projectRoot = await createProjectRoot()
    const filePath = pathProjectProviderTelemetry(projectRoot)
    const store = new JsonlProviderTelemetryStore({ filePath })

    store.recordAttempt(
      attempt({
        provider: "openai",
        model: "gpt-5",
        agent: "coder",
        status: "success",
        created_at: "2026-01-01T00:00:00.000Z",
      }),
    )
    store.recordAttempt(
      attempt({
        provider: "openai",
        model: "gpt-5-mini",
        agent: "tester",
        status: "failure",
        created_at: "2026-01-01T00:00:10.000Z",
      }),
    )

    const filtered = store.queryStats({ provider: "openai", model: "gpt-5", agent: "coder" })
    expect(filtered.total_attempts).toBe(1)

    const byWindow = store.queryStats({
      now: new Date("2026-01-01T00:00:20.000Z"),
      window_ms: 15_000,
    })
    expect(byWindow.total_attempts).toBe(1)
  })

  test("corrupt line skipped with warning and no crash", async () => {
    const projectRoot = await createProjectRoot()
    const filePath = pathProjectProviderTelemetry(projectRoot)
    const warnings: string[] = []
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(
      filePath,
      [
        JSON.stringify(attempt({ provider: "openai", model: "gpt-5", agent: "coder", status: "success" })),
        "{",
        JSON.stringify({ foo: "bar" }),
      ].join("\n") + "\n",
      "utf8",
    )

    const store = new JsonlProviderTelemetryStore({ filePath, onWarning: (message) => warnings.push(message) })
    const stats = store.queryStats()

    expect(stats.total_attempts).toBe(1)
    expect(warnings.length).toBeGreaterThanOrEqual(2)
    expect(warnings.some((item) => item.includes("corrupt line"))).toBe(true)
  })

  test("reset clears persisted file", async () => {
    const projectRoot = await createProjectRoot()
    const filePath = pathProjectProviderTelemetry(projectRoot)
    const store = new JsonlProviderTelemetryStore({ filePath })

    store.recordAttempt(attempt({ provider: "openai", model: "gpt-5", agent: "coder", status: "success" }))
    expect(store.queryStats().total_attempts).toBe(1)

    store.reset()
    expect(store.queryStats().total_attempts).toBe(0)

    const content = await fs.readFile(filePath, "utf8")
    expect(content).toBe("")
  })

  test("redaction excludes secret fields and request bodies", async () => {
    const projectRoot = await createProjectRoot()
    const filePath = pathProjectProviderTelemetry(projectRoot)
    const store = new JsonlProviderTelemetryStore({ filePath })

    store.recordAttempt({
      ...attempt({
        provider: "openai",
        model: "gpt-5",
        agent: "coder",
        status: "failure",
        error_category: "unknown",
        retryable: true,
        skip_reason: "prompt=top-secret",
      }),
      prompt: "private prompt",
      apiKey: "sk-secret",
      request_body: { tokens: ["secret"] },
      response_body: { text: "secret" },
      error_stack: "stacktrace",
    } as ProviderRouteAttempt)

    const raw = await fs.readFile(filePath, "utf8")
    const line = raw.split(/\r?\n/).find((item) => item.trim().length > 0)
    expect(line).toBeDefined()
    if (!line) return

    const parsed = JSON.parse(line) as Record<string, unknown>
    expect(Object.keys(parsed).toSorted()).toEqual([
      "agent",
      "created_at",
      "error_category",
      "fallback_index",
      "latency_ms",
      "model",
      "provider",
      "retryable",
      "status",
    ])
    const serialized = JSON.stringify(parsed)
    expect(serialized).not.toContain("sk-secret")
    expect(serialized).not.toContain("prompt")
    expect(serialized).not.toContain("request_body")
    expect(serialized).not.toContain("response_body")
    expect(serialized).not.toContain("error_stack")
  })

  test("write failure emits warning and does not throw", async () => {
    const projectRoot = await createProjectRoot()
    const directoryAsFile = path.join(projectRoot, ".codemate")
    const warnings: string[] = []
    await fs.mkdir(directoryAsFile, { recursive: true })

    const store = new JsonlProviderTelemetryStore({
      filePath: directoryAsFile,
      onWarning: (message) => warnings.push(message),
    })

    expect(() => {
      store.recordAttempt(attempt({ provider: "openai", model: "gpt-5", agent: "coder", status: "success" }))
    }).not.toThrow()

    expect(warnings.some((item) => item.includes("append failed"))).toBe(true)
  })
})
