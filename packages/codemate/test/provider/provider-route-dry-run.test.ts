import { describe, expect, test } from "bun:test"
import { InMemoryProviderHealthStore } from "@/provider/provider-health"
import {
  buildProviderRouteDryRunReport,
  type ProviderRouteDryRunReport,
} from "@/provider/provider-route-dry-run"
import type { ProviderRouteRecommendation } from "@/provider/provider-route-scoring"
import type { ProviderRouteDecision } from "@/provider/provider-routing"
import { InMemoryProviderTelemetryStore } from "@/provider/provider-telemetry"

function makeDecision(): ProviderRouteDecision {
  return {
    enabled: true,
    agent: "coder",
    selected: { provider: "openai", model: "gpt-5" },
    fallback: [{ provider: "anthropic", model: "claude-sonnet" }],
    maxRetries: 1,
    reason: "test",
    warnings: [],
    source: "agent-route",
    circuit_breaker: {
      enabled: true,
      failureThreshold: 1,
      openMs: 60_000,
      halfOpenMaxAttempts: 1,
      minAttempts: 1,
    },
    skipped_due_to_circuit: [],
    fallback_used_due_to_health: false,
    outcome_routing: {
      mode: "dry_run",
      effective_mode: "dry_run",
      minConfidence: 0.65,
      minSamples: 5,
    },
  }
}

function makeRecommendation(input: {
  provider?: string
  model?: string
  confidence?: number
  sampleSize?: number
}): ProviderRouteRecommendation {
  return {
    read_only: true,
    recommended: {
      provider: input.provider,
      model: input.model,
    },
    scores: [
      {
        candidate: { provider: input.provider, model: input.model, source: "fallback" },
        score: 0.9,
        sample_size: input.sampleSize ?? 8,
        success_rate: 0.9,
        fallback_used_rate: 0.1,
        retryable_failure_rate: 0.1,
        p95_latency_ms: 120,
        confidence: input.confidence ?? 0.85,
        reasons: ["test"],
      },
    ],
    reason: "test recommendation",
    confidence: input.confidence ?? 0.85,
    warnings: [],
  }
}

function recordTelemetry(store: InMemoryProviderTelemetryStore, input: { provider: string; model: string; successes: number; failures: number }) {
  const start = Date.parse("2026-01-01T00:00:00.000Z")
  let offset = 0
  for (let i = 0; i < input.successes; i += 1) {
    store.recordAttempt({
      provider: input.provider,
      model: input.model,
      agent: "coder",
      status: "success",
      fallback_index: 0,
      latency_ms: 90,
      created_at: new Date(start + offset * 1000).toISOString(),
    })
    offset += 1
  }
  for (let i = 0; i < input.failures; i += 1) {
    store.recordAttempt({
      provider: input.provider,
      model: input.model,
      agent: "coder",
      status: "failure",
      error_category: "timeout",
      retryable: true,
      fallback_index: 0,
      latency_ms: 220,
      created_at: new Date(start + offset * 1000).toISOString(),
    })
    offset += 1
  }
}

describe("provider.provider-route-dry-run", () => {
  test("missing recommendation blocks switch", () => {
    const report = buildProviderRouteDryRunReport({
      decision: makeDecision(),
    })
    expect(report.would_switch).toBe(false)
    expect(report.switch_blocked_by).toContain("missing_recommendation")
  })

  test("same recommendation blocks switch", () => {
    const report = buildProviderRouteDryRunReport({
      decision: makeDecision(),
      recommendation: makeRecommendation({
        provider: "openai",
        model: "gpt-5",
        confidence: 0.95,
        sampleSize: 10,
      }),
    })
    expect(report.would_switch).toBe(false)
    expect(report.switch_blocked_by).toContain("same_as_selected")
  })

  test("low confidence blocks switch", () => {
    const report = buildProviderRouteDryRunReport({
      decision: makeDecision(),
      recommendation: makeRecommendation({
        provider: "anthropic",
        model: "claude-sonnet",
        confidence: 0.4,
        sampleSize: 10,
      }),
      minConfidence: 0.65,
    })
    expect(report.would_switch).toBe(false)
    expect(report.switch_blocked_by).toContain("low_confidence")
  })

  test("insufficient samples blocks switch", () => {
    const report = buildProviderRouteDryRunReport({
      decision: makeDecision(),
      recommendation: makeRecommendation({
        provider: "anthropic",
        model: "claude-sonnet",
        confidence: 0.9,
        sampleSize: 2,
      }),
      minSamples: 5,
    })
    expect(report.would_switch).toBe(false)
    expect(report.switch_blocked_by).toContain("insufficient_samples")
  })

  test("open recommended provider blocks switch", () => {
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
    const report = buildProviderRouteDryRunReport({
      decision: makeDecision(),
      recommendation: makeRecommendation({
        provider: "anthropic",
        model: "claude-sonnet",
        confidence: 0.9,
        sampleSize: 10,
      }),
      healthStore,
    })
    expect(report.would_switch).toBe(false)
    expect(report.switch_blocked_by).toContain("unhealthy_recommendation")
    expect(report.health?.recommended_status).toBe("open")
  })

  test("high confidence different recommendation marks would_switch but remains blocked by read_only", () => {
    const telemetry = new InMemoryProviderTelemetryStore()
    recordTelemetry(telemetry, { provider: "openai", model: "gpt-5", successes: 7, failures: 3 })
    recordTelemetry(telemetry, { provider: "anthropic", model: "claude-sonnet", successes: 9, failures: 1 })
    const report = buildProviderRouteDryRunReport({
      decision: makeDecision(),
      recommendation: makeRecommendation({
        provider: "anthropic",
        model: "claude-sonnet",
        confidence: 0.9,
        sampleSize: 10,
      }),
      telemetryStore: telemetry,
      minConfidence: 0.65,
      minSamples: 5,
    })
    expect(report.would_switch).toBe(true)
    expect(report.switch_blocked_by).toContain("read_only")
    expect(report.telemetry?.recommended_success_rate).toBeGreaterThan(report.telemetry?.selected_success_rate ?? 0)
  })

  test("report does not alter selected provider", () => {
    const decision = makeDecision()
    const before = JSON.stringify(decision.selected)
    const report = buildProviderRouteDryRunReport({
      decision,
      recommendation: makeRecommendation({
        provider: "anthropic",
        model: "claude-sonnet",
        confidence: 0.9,
        sampleSize: 10,
      }),
    })
    expect(JSON.stringify(decision.selected)).toBe(before)
    expect(report.selected.provider).toBe("openai")
  })

  test("metadata contains no secrets", () => {
    const report: ProviderRouteDryRunReport = buildProviderRouteDryRunReport({
      decision: makeDecision(),
      recommendation: {
        read_only: true,
        recommended: { provider: "anthropic", model: "claude-sonnet" },
        scores: [],
        confidence: 0.9,
        reason: "test",
        warnings: ["apiKey=secret"],
      },
    })
    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain("sk-")
    expect(serialized).not.toContain("Bearer ")
  })
})
