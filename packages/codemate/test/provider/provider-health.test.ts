import { describe, expect, test } from "bun:test"
import {
  InMemoryProviderHealthStore,
  summarizeProviderRouteAttempts,
  type ProviderRouteAttempt,
} from "@/provider/provider-health"

function attempt(input: Partial<ProviderRouteAttempt> & { provider?: string; model?: string; status: ProviderRouteAttempt["status"] }) {
  return {
    provider: input.provider,
    model: input.model,
    agent: "coder",
    status: input.status,
    error_category: input.error_category,
    retryable: input.retryable,
    latency_ms: input.latency_ms ?? 10,
    fallback_index: input.fallback_index ?? 0,
    created_at: input.created_at ?? new Date("2026-01-01T00:00:00.000Z").toISOString(),
  } satisfies ProviderRouteAttempt
}

describe("provider.provider-health", () => {
  test("success keeps provider healthy", () => {
    const store = new InMemoryProviderHealthStore({ config: { enabled: true } })
    store.recordAttempt(attempt({ provider: "openai", model: "gpt-5", status: "success" }))
    const health = store.getHealth("openai", "gpt-5")
    expect(health?.status).toBe("healthy")
    expect(health?.success_count).toBe(1)
    expect(health?.consecutive_failures).toBe(0)
  })

  test("retryable consecutive failures open circuit", () => {
    const store = new InMemoryProviderHealthStore({
      config: { enabled: true, failureThreshold: 3, minAttempts: 3, openMs: 60_000, halfOpenMaxAttempts: 1 },
    })
    store.recordAttempt(attempt({ provider: "openai", model: "gpt-5", status: "failure", retryable: true, error_category: "timeout" }))
    store.recordAttempt(attempt({ provider: "openai", model: "gpt-5", status: "failure", retryable: true, error_category: "timeout" }))
    store.recordAttempt(attempt({ provider: "openai", model: "gpt-5", status: "failure", retryable: true, error_category: "timeout" }))
    expect(store.getHealth("openai", "gpt-5")?.status).toBe("open")
  })

  test("open circuit skips provider before openMs", () => {
    const store = new InMemoryProviderHealthStore({
      config: { enabled: true, failureThreshold: 1, minAttempts: 1, openMs: 60_000, halfOpenMaxAttempts: 1 },
    })
    const openedAt = "2026-01-01T00:00:00.000Z"
    store.recordAttempt(attempt({ provider: "openai", model: "gpt-5", status: "failure", retryable: true, error_category: "network", created_at: openedAt }))
    const verdict = store.shouldSkip("openai", "gpt-5", new Date("2026-01-01T00:00:10.000Z"))
    expect(verdict.skip).toBe(true)
    expect(verdict.status).toBe("open")
  })

  test("after openMs provider becomes half_open", () => {
    const store = new InMemoryProviderHealthStore({
      config: { enabled: true, failureThreshold: 1, minAttempts: 1, openMs: 1_000, halfOpenMaxAttempts: 1 },
    })
    store.recordAttempt(
      attempt({
        provider: "openai",
        model: "gpt-5",
        status: "failure",
        retryable: true,
        error_category: "network",
        created_at: "2026-01-01T00:00:00.000Z",
      }),
    )
    const verdict = store.shouldSkip("openai", "gpt-5", new Date("2026-01-01T00:00:02.000Z"))
    expect(verdict.skip).toBe(false)
    expect(verdict.status).toBe("half_open")
  })

  test("half_open success closes circuit", () => {
    const store = new InMemoryProviderHealthStore({
      config: { enabled: true, failureThreshold: 1, minAttempts: 1, openMs: 1_000, halfOpenMaxAttempts: 1 },
    })
    store.recordAttempt(
      attempt({
        provider: "openai",
        model: "gpt-5",
        status: "failure",
        retryable: true,
        error_category: "network",
        created_at: "2026-01-01T00:00:00.000Z",
      }),
    )
    store.shouldSkip("openai", "gpt-5", new Date("2026-01-01T00:00:02.000Z"))
    store.recordAttempt(
      attempt({
        provider: "openai",
        model: "gpt-5",
        status: "success",
        created_at: "2026-01-01T00:00:02.100Z",
      }),
    )
    expect(store.getHealth("openai", "gpt-5")?.status).toBe("healthy")
  })

  test("half_open failure reopens circuit", () => {
    const store = new InMemoryProviderHealthStore({
      config: { enabled: true, failureThreshold: 1, minAttempts: 1, openMs: 1_000, halfOpenMaxAttempts: 1 },
    })
    store.recordAttempt(
      attempt({
        provider: "openai",
        model: "gpt-5",
        status: "failure",
        retryable: true,
        error_category: "network",
        created_at: "2026-01-01T00:00:00.000Z",
      }),
    )
    store.shouldSkip("openai", "gpt-5", new Date("2026-01-01T00:00:02.000Z"))
    store.recordAttempt(
      attempt({
        provider: "openai",
        model: "gpt-5",
        status: "failure",
        retryable: true,
        error_category: "timeout",
        created_at: "2026-01-01T00:00:02.100Z",
      }),
    )
    expect(store.getHealth("openai", "gpt-5")?.status).toBe("open")
  })

  test("non-retryable cancelled/permission_denied/validation_error do not open circuit", () => {
    const store = new InMemoryProviderHealthStore({
      config: { enabled: true, failureThreshold: 1, minAttempts: 1, openMs: 60_000, halfOpenMaxAttempts: 1 },
    })
    store.recordAttempt(attempt({ provider: "openai", model: "gpt-5", status: "failure", retryable: false, error_category: "cancelled" }))
    store.recordAttempt(attempt({ provider: "openai", model: "gpt-5", status: "failure", retryable: false, error_category: "permission_denied" }))
    store.recordAttempt(attempt({ provider: "openai", model: "gpt-5", status: "failure", retryable: false, error_category: "validation_error" }))
    expect(store.getHealth("openai", "gpt-5")?.status).not.toBe("open")
  })

  test("provider_unavailable/model_unavailable can open circuit", () => {
    const store = new InMemoryProviderHealthStore({
      config: { enabled: true, failureThreshold: 2, minAttempts: 2, openMs: 60_000, halfOpenMaxAttempts: 1 },
    })
    store.recordAttempt(
      attempt({
        provider: "openai",
        model: "gpt-5",
        status: "failure",
        retryable: false,
        error_category: "provider_unavailable",
      }),
    )
    store.recordAttempt(
      attempt({
        provider: "openai",
        model: "gpt-5",
        status: "failure",
        retryable: false,
        error_category: "model_unavailable",
      }),
    )
    expect(store.getHealth("openai", "gpt-5")?.status).toBe("open")
  })

  test("health store keeps provider+model independent state", () => {
    const store = new InMemoryProviderHealthStore({
      config: { enabled: true, failureThreshold: 1, minAttempts: 1, openMs: 60_000, halfOpenMaxAttempts: 1 },
    })
    store.recordAttempt(attempt({ provider: "openai", model: "gpt-5", status: "failure", retryable: true, error_category: "timeout" }))
    store.recordAttempt(attempt({ provider: "openai", model: "gpt-5-mini", status: "success" }))
    expect(store.getHealth("openai", "gpt-5")?.status).toBe("open")
    expect(store.getHealth("openai", "gpt-5-mini")?.status).toBe("healthy")
  })

  test("summary helper does not include secret", () => {
    const summary = summarizeProviderRouteAttempts([
      attempt({
        provider: "openai",
        model: "gpt-5",
        status: "failure",
        error_category: "provider_unavailable",
        retryable: true,
      }),
      attempt({
        provider: "anthropic",
        model: "claude-sonnet",
        status: "success",
        fallback_index: 1,
      }),
    ])
    const serialized = JSON.stringify(summary)
    expect(summary.total).toBe(2)
    expect(summary.fallback_used).toBe(true)
    expect(serialized).not.toContain("sk-")
    expect(serialized).not.toContain("apiKey")
  })
})
