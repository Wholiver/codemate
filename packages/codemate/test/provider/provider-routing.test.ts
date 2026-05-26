import { describe, expect, test } from "bun:test"
import {
  createRecommendedProviderRoutes,
  providerRouteDecisionMetadata,
  resolveProviderRoute,
  runWithProviderFallback,
} from "@/provider/provider-routing"
import { InMemoryProviderHealthStore } from "@/provider/provider-health"
import { InMemoryProviderTelemetryStore } from "@/provider/provider-telemetry"

describe("provider.provider-routing", () => {
  test("disabled preserves current provider/model", () => {
    const decision = resolveProviderRoute({
      agent: "coder",
      currentProvider: "openai",
      currentModel: "gpt-5",
      config: { enabled: false },
    })
    expect(decision.enabled).toBe(false)
    expect(decision.source).toBe("disabled")
    expect(decision.selected.provider).toBe("openai")
    expect(decision.selected.model).toBe("gpt-5")
  })

  test("agent route selects configured provider/model", () => {
    const decision = resolveProviderRoute({
      agent: "coder",
      currentProvider: "openai",
      currentModel: "gpt-5",
      config: {
        enabled: true,
        routes: {
          coder: {
            provider: "anthropic",
            model: "claude-sonnet",
          },
        },
      },
    })
    expect(decision.enabled).toBe(true)
    expect(decision.source).toBe("agent-route")
    expect(decision.selected.provider).toBe("anthropic")
    expect(decision.selected.model).toBe("claude-sonnet")
  })

  test("missing route uses default provider/model", () => {
    const decision = resolveProviderRoute({
      agent: "reviewer",
      currentProvider: "openai",
      currentModel: "gpt-5",
      config: {
        enabled: true,
        defaultProvider: "mistral",
        defaultModel: "mistral-large",
      },
    })
    expect(decision.source).toBe("default-route")
    expect(decision.selected.provider).toBe("mistral")
    expect(decision.selected.model).toBe("mistral-large")
  })

  test("no route and no default uses current provider/model", () => {
    const decision = resolveProviderRoute({
      agent: "writer",
      currentProvider: "openai",
      currentModel: "gpt-5-mini",
      config: { enabled: true },
    })
    expect(decision.source).toBe("current-provider")
    expect(decision.selected.provider).toBe("openai")
    expect(decision.selected.model).toBe("gpt-5-mini")
  })

  test("fallback chain merges route fallback and global fallback", () => {
    const decision = resolveProviderRoute({
      agent: "coder",
      currentProvider: "openai",
      currentModel: "gpt-5",
      config: {
        enabled: true,
        routes: {
          coder: {
            provider: "anthropic",
            model: "claude-sonnet",
            fallback: [{ provider: "openai", model: "gpt-5-mini" }],
          },
        },
        fallback: [{ provider: "mistral", model: "mistral-large" }],
      },
    })
    expect(decision.fallback.map((item) => `${item.provider}/${item.model}`)).toEqual([
      "openai/gpt-5-mini",
      "mistral/mistral-large",
    ])
  })

  test("fallback removes duplicates and selected target", () => {
    const decision = resolveProviderRoute({
      agent: "coder",
      currentProvider: "openai",
      currentModel: "gpt-5",
      config: {
        enabled: true,
        routes: {
          coder: {
            provider: "openai",
            model: "gpt-5",
            fallback: [
              { provider: "openai", model: "gpt-5" },
              { provider: "openai", model: "gpt-5-mini" },
            ],
          },
        },
        fallback: [{ provider: "openai", model: "gpt-5-mini" }],
      },
    })
    expect(decision.fallback.map((item) => `${item.provider}/${item.model}`)).toEqual(["openai/gpt-5-mini"])
  })

  test("invalid provider returns warning without throw", () => {
    const decision = resolveProviderRoute({
      agent: "planner",
      currentProvider: "openai",
      currentModel: "gpt-5",
      config: {
        enabled: true,
        routes: {
          planner: {
            provider: "unknown-provider",
            model: "m-1",
          },
        },
      },
      availableProviders: ["openai", "anthropic"],
      availableModels: {
        openai: ["gpt-5"],
        anthropic: ["claude-sonnet"],
      },
    })
    expect(decision.warnings.join("\n")).toContain("selected provider \"unknown-provider\" is unavailable")
  })

  test("invalid model returns warning without throw", () => {
    const decision = resolveProviderRoute({
      agent: "planner",
      currentProvider: "openai",
      currentModel: "gpt-5",
      config: {
        enabled: true,
        routes: {
          planner: {
            provider: "openai",
            model: "missing-model",
          },
        },
      },
      availableProviders: ["openai"],
      availableModels: {
        openai: ["gpt-5"],
      },
    })
    expect(decision.warnings.join("\n")).toContain("selected model \"openai/missing-model\" is unavailable")
  })

  test("invalid timeout and retries are normalized with warnings", () => {
    const decision = resolveProviderRoute({
      agent: "research",
      currentProvider: "openai",
      currentModel: "gpt-5",
      config: {
        enabled: true,
        routes: {
          research: {
            provider: "openai",
            model: "gpt-5",
            maxRetries: -1,
            timeoutMs: 0,
          },
        },
      },
    })
    expect(decision.maxRetries).toBe(1)
    expect(decision.timeoutMs).toBeUndefined()
    expect(decision.warnings.join("\n")).toContain("invalid maxRetries")
    expect(decision.warnings.join("\n")).toContain("invalid timeoutMs")
  })

  test("strict invalid route disables primary route safely", () => {
    const decision = resolveProviderRoute({
      agent: "coder",
      currentProvider: "openai",
      currentModel: "gpt-5",
      config: {
        enabled: true,
        strict: true,
        routes: {
          coder: {
            provider: "unknown",
            model: "missing",
          },
        },
      },
      availableProviders: ["openai"],
      availableModels: {
        openai: ["gpt-5"],
      },
    })
    expect(decision.selected.provider).toBe("openai")
    expect(decision.selected.model).toBe("gpt-5")
    expect(["current-provider", "fallback"]).toContain(decision.source)
    expect(decision.warnings.join("\n")).toContain("strict mode disabled invalid primary route")
  })

  test("recommended policy helper returns config not auto-enabled", () => {
    const policy = createRecommendedProviderRoutes()
    expect(policy.enabled).toBe(false)
    expect(policy.routes?.coder).toBeDefined()
    expect(policy.routes?.planner).toBeDefined()
  })

  test("route decision metadata does not include secrets", () => {
    const decision = resolveProviderRoute({
      agent: "writer",
      currentProvider: "openai",
      currentModel: "gpt-5-mini",
      config: {
        enabled: true,
        routes: {
          writer: {
            provider: "openai",
            model: "gpt-5-mini",
            fallback: [{ provider: "anthropic", model: "claude-haiku", reason: "token=super-secret-value" }],
          },
        },
      },
    })
    const metadata = providerRouteDecisionMetadata(decision)
    const serialized = JSON.stringify(metadata)
    expect(serialized).toContain("selected_provider")
    expect(serialized).toContain("selected_model")
    expect(serialized).not.toContain("super-secret-value")
  })

  test("default config does not alter existing provider behavior", () => {
    const currentProvider = "openai"
    const currentModel = "gpt-5"
    const decision = resolveProviderRoute({
      agent: "orchestrator",
      currentProvider,
      currentModel,
      config: {},
    })
    expect(decision.selected.provider).toBe(currentProvider)
    expect(decision.selected.model).toBe(currentModel)
    expect(decision.enabled).toBe(false)
  })

  test("default outcome routing mode is off", () => {
    const decision = resolveProviderRoute({
      agent: "coder",
      currentProvider: "openai",
      currentModel: "gpt-5",
      config: { enabled: true },
    })
    expect(decision.outcome_routing.mode).toBe("off")
    expect(decision.outcome_routing.effective_mode).toBe("off")
    expect(decision.recommendation).toBeUndefined()
  })

  test("circuit breaker disabled keeps current route behavior unchanged", () => {
    const healthStore = new InMemoryProviderHealthStore({
      config: { enabled: true, failureThreshold: 1, minAttempts: 1, openMs: 60_000, halfOpenMaxAttempts: 1 },
    })
    healthStore.recordAttempt({
      provider: "openai",
      model: "gpt-5",
      status: "failure",
      error_category: "timeout",
      retryable: true,
      fallback_index: 0,
      created_at: "2026-01-01T00:00:00.000Z",
    })
    const decision = resolveProviderRoute({
      agent: "coder",
      currentProvider: "openai",
      currentModel: "gpt-5",
      config: {
        enabled: true,
        circuitBreaker: { enabled: false, failureThreshold: 1, openMs: 60_000, halfOpenMaxAttempts: 1, minAttempts: 1 },
        fallback: [{ provider: "anthropic", model: "claude-sonnet" }],
      },
      healthStore,
    })
    expect(decision.selected.provider).toBe("openai")
    expect(decision.selected.model).toBe("gpt-5")
    expect(decision.fallback.length).toBe(1)
  })

  test("circuit enabled primary open selects healthy fallback", () => {
    const healthStore = new InMemoryProviderHealthStore({
      config: { enabled: true, failureThreshold: 1, minAttempts: 1, openMs: 60_000, halfOpenMaxAttempts: 1 },
    })
    healthStore.recordAttempt({
      provider: "openai",
      model: "gpt-5",
      status: "failure",
      error_category: "timeout",
      retryable: true,
      fallback_index: 0,
      created_at: "2026-01-01T00:00:00.000Z",
    })
    const decision = resolveProviderRoute({
      agent: "coder",
      currentProvider: "openai",
      currentModel: "gpt-5",
      config: {
        enabled: true,
        circuitBreaker: { enabled: true, failureThreshold: 1, openMs: 60_000, halfOpenMaxAttempts: 1, minAttempts: 1 },
        fallback: [{ provider: "anthropic", model: "claude-sonnet" }],
      },
      healthStore,
      now: new Date("2026-01-01T00:00:10.000Z"),
    })
    expect(decision.selected.provider).toBe("anthropic")
    expect(decision.fallback_used_due_to_health).toBe(true)
    expect(decision.skipped_due_to_circuit.length).toBeGreaterThan(0)
  })

  test("open fallback target is skipped by circuit", () => {
    const healthStore = new InMemoryProviderHealthStore({
      config: { enabled: true, failureThreshold: 1, minAttempts: 1, openMs: 60_000, halfOpenMaxAttempts: 1 },
    })
    healthStore.recordAttempt({
      provider: "anthropic",
      model: "claude-sonnet",
      status: "failure",
      error_category: "timeout",
      retryable: true,
      fallback_index: 0,
      created_at: "2026-01-01T00:00:00.000Z",
    })
    const decision = resolveProviderRoute({
      agent: "coder",
      currentProvider: "openai",
      currentModel: "gpt-5",
      config: {
        enabled: true,
        circuitBreaker: { enabled: true, failureThreshold: 1, openMs: 60_000, halfOpenMaxAttempts: 1, minAttempts: 1 },
        routes: {
          coder: {
            provider: "openai",
            model: "gpt-5",
            fallback: [{ provider: "anthropic", model: "claude-sonnet" }],
          },
        },
      },
      healthStore,
      now: new Date("2026-01-01T00:00:10.000Z"),
    })
    expect(decision.selected.provider).toBe("openai")
    expect(decision.fallback.length).toBe(0)
    expect(decision.skipped_due_to_circuit.some((item) => item.provider === "anthropic")).toBe(true)
  })

  test("all open targets keep readable fallback-safe decision without throw", () => {
    const healthStore = new InMemoryProviderHealthStore({
      config: { enabled: true, failureThreshold: 1, minAttempts: 1, openMs: 60_000, halfOpenMaxAttempts: 1 },
    })
    healthStore.recordAttempt({
      provider: "openai",
      model: "gpt-5",
      status: "failure",
      error_category: "timeout",
      retryable: true,
      fallback_index: 0,
      created_at: "2026-01-01T00:00:00.000Z",
    })
    healthStore.recordAttempt({
      provider: "anthropic",
      model: "claude-sonnet",
      status: "failure",
      error_category: "timeout",
      retryable: true,
      fallback_index: 1,
      created_at: "2026-01-01T00:00:00.000Z",
    })
    const decision = resolveProviderRoute({
      agent: "coder",
      currentProvider: "openai",
      currentModel: "gpt-5",
      config: {
        enabled: true,
        circuitBreaker: { enabled: true, failureThreshold: 1, openMs: 60_000, halfOpenMaxAttempts: 1, minAttempts: 1 },
        fallback: [{ provider: "anthropic", model: "claude-sonnet" }],
      },
      healthStore,
      now: new Date("2026-01-01T00:00:10.000Z"),
    })
    expect(decision.selected.provider).toBe("openai")
    expect(decision.warnings.join("\n")).toContain("all route targets are currently skipped by circuit breaker")
  })

  test("recommendation metadata does not change selected provider", () => {
    const telemetry = new InMemoryProviderTelemetryStore()
    for (let i = 0; i < 8; i += 1) {
      telemetry.recordAttempt({
        provider: "anthropic",
        model: "claude-sonnet",
        agent: "coder",
        status: "success",
        fallback_index: 0,
        latency_ms: 80,
        created_at: new Date(1704067200000 + i * 1000).toISOString(),
      })
    }
    for (let i = 0; i < 8; i += 1) {
      telemetry.recordAttempt({
        provider: "openai",
        model: "gpt-5",
        agent: "coder",
        status: "failure",
        error_category: "timeout",
        retryable: true,
        fallback_index: 0,
        latency_ms: 300,
        created_at: new Date(1704067200000 + 10000 + i * 1000).toISOString(),
      })
    }
    const decision = resolveProviderRoute({
      agent: "coder",
      currentProvider: "openai",
      currentModel: "gpt-5",
      config: {
        enabled: true,
        outcome_routing: {
          mode: "dry_run",
        },
        routes: {
          coder: {
            provider: "openai",
            model: "gpt-5",
            fallback: [{ provider: "anthropic", model: "claude-sonnet" }],
          },
        },
      },
      telemetryStore: telemetry,
    })
    expect(decision.selected.provider).toBe("openai")
    expect(decision.recommendation?.read_only).toBe(true)
    expect(decision.recommendation?.recommended?.provider).toBe("anthropic")
  })

  test("mode off does not produce recommendation metadata", () => {
    const telemetry = new InMemoryProviderTelemetryStore()
    const decision = resolveProviderRoute({
      agent: "coder",
      currentProvider: "openai",
      currentModel: "gpt-5",
      config: {
        enabled: true,
      },
      telemetryStore: telemetry,
    })
    expect(decision.recommendation).toBeUndefined()
  })

  test("mode dry_run produces recommendation metadata", () => {
    const telemetry = new InMemoryProviderTelemetryStore()
    const decision = resolveProviderRoute({
      agent: "coder",
      currentProvider: "openai",
      currentModel: "gpt-5",
      config: {
        enabled: true,
        outcome_routing: {
          mode: "dry_run",
        },
      },
      telemetryStore: telemetry,
    })
    expect(decision.outcome_routing.effective_mode).toBe("dry_run")
    expect(decision.recommendation?.read_only).toBe(true)
  })

  test("mode enabled falls back to dry_run with warning", () => {
    const telemetry = new InMemoryProviderTelemetryStore()
    const decision = resolveProviderRoute({
      agent: "coder",
      currentProvider: "openai",
      currentModel: "gpt-5",
      config: {
        enabled: true,
        outcome_routing: {
          mode: "enabled",
        },
      },
      telemetryStore: telemetry,
    })
    expect(decision.outcome_routing.mode).toBe("enabled")
    expect(decision.outcome_routing.effective_mode).toBe("dry_run")
    expect(decision.warnings.join("\n")).toContain("outcome routing enabled mode is not implemented; falling back to dry_run")
    expect(decision.recommendation?.read_only).toBe(true)
  })

  test("provider routing disabled suppresses outcome routing even in dry_run", () => {
    const telemetry = new InMemoryProviderTelemetryStore()
    const decision = resolveProviderRoute({
      agent: "coder",
      currentProvider: "openai",
      currentModel: "gpt-5",
      config: {
        enabled: false,
        outcome_routing: {
          mode: "dry_run",
        },
      },
      telemetryStore: telemetry,
    })
    expect(decision.enabled).toBe(false)
    expect(decision.outcome_routing.effective_mode).toBe("off")
    expect(decision.recommendation).toBeUndefined()
  })

  test("non-retryable error does not continue fallback chain", async () => {
    const attempts: string[] = []
    const result = await runWithProviderFallback(
      {
        primary: { provider: "openai", model: "gpt-5" },
        fallback: [{ provider: "anthropic", model: "claude-sonnet" }],
        maxRetries: 2,
      },
      async (target) => {
        attempts.push(`${target.provider}/${target.model}`)
        throw new Error("PermissionDeniedError: denied")
      },
      {
        isRetryable: (error) => !String(error).toLowerCase().includes("permissiondeniederror"),
      },
    )
    expect(result.ok).toBe(false)
    expect(attempts).toEqual(["openai/gpt-5"])
    expect(result.visited).toHaveLength(1)
  })
})
