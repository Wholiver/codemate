import { describe, expect, test } from "bun:test"
import {
  InMemoryProviderTelemetryStore,
  JsonlProviderTelemetryStore,
  pathProjectProviderTelemetry,
  resolveProviderTelemetryStore,
  type ProviderTelemetryQuery,
} from "@/provider/provider-telemetry"
import type { ProviderRouteAttempt } from "@/provider/provider-health"

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
  } satisfies ProviderRouteAttempt
}

describe("provider.provider-telemetry", () => {
  test("records success/failure/skipped counts and rates", () => {
    const store = new InMemoryProviderTelemetryStore()
    store.recordAttempt(attempt({ provider: "openai", model: "gpt-5", agent: "coder", status: "success", latency_ms: 20 }))
    store.recordAttempt(
      attempt({
        provider: "openai",
        model: "gpt-5",
        agent: "coder",
        status: "failure",
        retryable: true,
        error_category: "timeout",
        latency_ms: 80,
      }),
    )
    store.recordAttempt(
      attempt({
        provider: "openai",
        model: "gpt-5",
        agent: "coder",
        status: "skipped",
        error_category: "provider_unavailable",
        latency_ms: 0,
      }),
    )
    const stats = store.queryStats({ group_by: ["provider", "model", "agent"] })
    expect(stats.total_attempts).toBe(3)
    expect(stats.buckets).toHaveLength(1)
    const bucket = stats.buckets[0]
    if (!bucket) return
    expect(bucket.successes).toBe(1)
    expect(bucket.failures).toBe(1)
    expect(bucket.skipped).toBe(1)
    expect(bucket.success_rate).toBeCloseTo(1 / 3)
    expect(bucket.failure_rate).toBeCloseTo(1 / 3)
    expect(bucket.retryable_failure_rate).toBeCloseTo(1 / 3)
  })

  test("computes fallback_used_rate", () => {
    const store = new InMemoryProviderTelemetryStore()
    store.recordAttempt(attempt({ provider: "openai", model: "gpt-5", agent: "coder", status: "failure", fallback_index: 0 }))
    store.recordAttempt(attempt({ provider: "anthropic", model: "claude-sonnet", agent: "coder", status: "success", fallback_index: 1 }))
    const bucket = store.queryStats().buckets[0]
    if (!bucket) return
    expect(bucket.fallback_used_rate).toBe(0.5)
  })

  test("computes p50 and p95 latency", () => {
    const store = new InMemoryProviderTelemetryStore()
    ;[10, 20, 30, 100].forEach((latency) =>
      store.recordAttempt(attempt({ provider: "openai", model: "gpt-5", agent: "coder", status: "success", latency_ms: latency })),
    )
    const bucket = store.queryStats().buckets[0]
    if (!bucket) return
    expect(bucket.p50_latency_ms).toBe(20)
    expect(bucket.p95_latency_ms).toBe(100)
  })

  test("filters by provider/model/agent and time window", () => {
    const store = new InMemoryProviderTelemetryStore()
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
    const byProvider = store.queryStats({ provider: "openai", model: "gpt-5", agent: "coder" })
    expect(byProvider.total_attempts).toBe(1)
    const windowQuery: ProviderTelemetryQuery = {
      now: new Date("2026-01-01T00:00:20.000Z"),
      window_ms: 15_000,
    }
    const byWindow = store.queryStats(windowQuery)
    expect(byWindow.total_attempts).toBe(1)
    expect(byWindow.buckets[0]?.agent).toBeUndefined()
  })

  test("supports group by error_category", () => {
    const store = new InMemoryProviderTelemetryStore()
    store.recordAttempt(attempt({ provider: "openai", model: "gpt-5", agent: "coder", status: "failure", error_category: "timeout" }))
    store.recordAttempt(attempt({ provider: "openai", model: "gpt-5", agent: "coder", status: "failure", error_category: "timeout" }))
    store.recordAttempt(attempt({ provider: "openai", model: "gpt-5", agent: "coder", status: "failure", error_category: "rate_limit" }))
    const stats = store.queryStats({ group_by: ["error_category"] })
    expect(stats.buckets.length).toBe(2)
    expect(stats.buckets.some((item) => item.error_category === "timeout" && item.total_attempts === 2)).toBe(true)
  })

  test("reset clears stats", () => {
    const store = new InMemoryProviderTelemetryStore()
    store.recordAttempt(attempt({ provider: "openai", model: "gpt-5", agent: "coder", status: "success" }))
    expect(store.queryStats().total_attempts).toBe(1)
    store.reset()
    expect(store.queryStats().total_attempts).toBe(0)
  })

  test("metadata contains no secrets", () => {
    const store = new InMemoryProviderTelemetryStore()
    store.recordAttempt(
      attempt({
        provider: "openai",
        model: "gpt-5",
        agent: "coder",
        status: "failure",
        error_category: "unknown",
      }),
    )
    const serialized = JSON.stringify(store.queryStats())
    expect(serialized).not.toContain("apiKey")
    expect(serialized).not.toContain("Bearer")
    expect(serialized).not.toContain("sk-")
  })

  test("factory defaults to memory and enabled when routing is enabled", () => {
    const resolved = resolveProviderTelemetryStore({ routingEnabled: true })
    expect(resolved.store).toBeInstanceOf(InMemoryProviderTelemetryStore)
    expect(resolved.config.enabled).toBe(true)
    expect(resolved.config.store).toBe("memory")
  })

  test("factory selects jsonl store with project root", () => {
    const resolved = resolveProviderTelemetryStore({
      routingEnabled: true,
      telemetry: { store: "jsonl" },
      projectRoot: "/tmp/codemate-provider-telemetry-factory",
    })
    expect(resolved.store).toBeInstanceOf(JsonlProviderTelemetryStore)
    expect(resolved.filePath).toBe(pathProjectProviderTelemetry("/tmp/codemate-provider-telemetry-factory"))
    expect(resolved.warnings.length).toBe(0)
  })

  test("factory falls back to memory with warning when jsonl lacks project root", () => {
    const resolved = resolveProviderTelemetryStore({
      routingEnabled: true,
      telemetry: { store: "jsonl" },
    })
    expect(resolved.store).toBeInstanceOf(InMemoryProviderTelemetryStore)
    expect(resolved.warnings.join("\\n")).toContain("fallback to \"memory\"")
  })
})
