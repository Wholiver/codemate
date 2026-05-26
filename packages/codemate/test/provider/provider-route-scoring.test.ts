import { describe, expect, test } from "bun:test"
import { InMemoryProviderHealthStore } from "@/provider/provider-health"
import { scoreProviderRouteCandidates } from "@/provider/provider-route-scoring"
import { InMemoryProviderTelemetryStore } from "@/provider/provider-telemetry"

function recordSeries(input: {
  telemetry: InMemoryProviderTelemetryStore
  provider: string
  model: string
  agent: string
  successes: number
  failures: number
  skipped?: number
  retryableFailures?: number
  fallbackFailures?: number
  latency: number[]
  startedAt?: string
}) {
  const base = Date.parse(input.startedAt ?? "2026-01-01T00:00:00.000Z")
  let index = 0
  for (let i = 0; i < input.successes; i += 1) {
    input.telemetry.recordAttempt({
      provider: input.provider,
      model: input.model,
      agent: input.agent,
      status: "success",
      fallback_index: 0,
      latency_ms: input.latency[index % input.latency.length] ?? 20,
      created_at: new Date(base + index * 1000).toISOString(),
    })
    index += 1
  }
  for (let i = 0; i < input.failures; i += 1) {
    input.telemetry.recordAttempt({
      provider: input.provider,
      model: input.model,
      agent: input.agent,
      status: "failure",
      error_category: "timeout",
      retryable: i < (input.retryableFailures ?? input.failures),
      fallback_index: i < (input.fallbackFailures ?? 0) ? 1 : 0,
      latency_ms: input.latency[index % input.latency.length] ?? 50,
      created_at: new Date(base + index * 1000).toISOString(),
    })
    index += 1
  }
  for (let i = 0; i < (input.skipped ?? 0); i += 1) {
    input.telemetry.recordAttempt({
      provider: input.provider,
      model: input.model,
      agent: input.agent,
      status: "skipped",
      error_category: "provider_unavailable",
      retryable: true,
      fallback_index: 1,
      latency_ms: 0,
      created_at: new Date(base + index * 1000).toISOString(),
    })
    index += 1
  }
}

describe("provider.provider-route-scoring", () => {
  test("high success and low latency candidate scores higher", () => {
    const telemetry = new InMemoryProviderTelemetryStore()
    recordSeries({
      telemetry,
      provider: "openai",
      model: "gpt-5",
      agent: "coder",
      successes: 9,
      failures: 1,
      latency: [60, 80, 70],
    })
    recordSeries({
      telemetry,
      provider: "anthropic",
      model: "claude-sonnet",
      agent: "coder",
      successes: 5,
      failures: 5,
      latency: [400, 500, 450],
    })
    const recommendation = scoreProviderRouteCandidates({
      candidates: [
        { provider: "openai", model: "gpt-5", source: "selected" },
        { provider: "anthropic", model: "claude-sonnet", source: "fallback" },
      ],
      agent: "coder",
      telemetryStore: telemetry,
    })
    expect(recommendation.recommended?.provider).toBe("openai")
    expect((recommendation.scores[0]?.score ?? 0) > (recommendation.scores[1]?.score ?? 0)).toBe(true)
  })

  test("high fallback and retryable failure candidate scores lower", () => {
    const telemetry = new InMemoryProviderTelemetryStore()
    recordSeries({
      telemetry,
      provider: "openai",
      model: "gpt-5",
      agent: "coder",
      successes: 7,
      failures: 3,
      fallbackFailures: 0,
      retryableFailures: 1,
      latency: [120, 130, 140],
    })
    recordSeries({
      telemetry,
      provider: "mistral",
      model: "mistral-large",
      agent: "coder",
      successes: 4,
      failures: 6,
      fallbackFailures: 5,
      retryableFailures: 6,
      latency: [220, 260, 280],
    })
    const recommendation = scoreProviderRouteCandidates({
      candidates: [
        { provider: "openai", model: "gpt-5", source: "selected" },
        { provider: "mistral", model: "mistral-large", source: "fallback" },
      ],
      agent: "coder",
      telemetryStore: telemetry,
    })
    const mistral = recommendation.scores.find((item) => item.candidate.provider === "mistral")
    const openai = recommendation.scores.find((item) => item.candidate.provider === "openai")
    expect((openai?.score ?? 0) > (mistral?.score ?? 0)).toBe(true)
  })

  test("open circuit candidate is penalized", () => {
    const telemetry = new InMemoryProviderTelemetryStore()
    const health = new InMemoryProviderHealthStore({
      config: { enabled: true, failureThreshold: 1, minAttempts: 1, openMs: 60_000, halfOpenMaxAttempts: 1 },
    })
    recordSeries({
      telemetry,
      provider: "openai",
      model: "gpt-5",
      agent: "coder",
      successes: 8,
      failures: 2,
      latency: [90, 110, 100],
    })
    recordSeries({
      telemetry,
      provider: "anthropic",
      model: "claude-sonnet",
      agent: "coder",
      successes: 8,
      failures: 2,
      latency: [90, 100, 110],
    })
    health.recordAttempt({
      provider: "openai",
      model: "gpt-5",
      status: "failure",
      error_category: "timeout",
      retryable: true,
      fallback_index: 0,
      created_at: "2026-01-01T00:00:00.000Z",
    })
    const recommendation = scoreProviderRouteCandidates({
      candidates: [
        { provider: "openai", model: "gpt-5", source: "selected" },
        { provider: "anthropic", model: "claude-sonnet", source: "fallback" },
      ],
      agent: "coder",
      telemetryStore: telemetry,
      healthStore: health,
    })
    expect(recommendation.recommended?.provider).toBe("anthropic")
    expect(recommendation.scores.some((item) => item.candidate.provider === "openai" && item.health_status === "open")).toBe(true)
  })

  test("low sample size lowers confidence", () => {
    const telemetry = new InMemoryProviderTelemetryStore()
    recordSeries({
      telemetry,
      provider: "openai",
      model: "gpt-5",
      agent: "coder",
      successes: 1,
      failures: 0,
      latency: [80],
    })
    const recommendation = scoreProviderRouteCandidates({
      candidates: [{ provider: "openai", model: "gpt-5", source: "selected" }],
      agent: "coder",
      telemetryStore: telemetry,
    })
    expect((recommendation.scores[0]?.confidence ?? 1) < 0.5).toBe(true)
    expect(recommendation.warnings.join("\n")).toContain("low sample size")
  })

  test("no telemetry returns low confidence recommendation", () => {
    const recommendation = scoreProviderRouteCandidates({
      candidates: [{ provider: "openai", model: "gpt-5", source: "selected" }],
    })
    expect(recommendation.read_only).toBe(true)
    expect(recommendation.confidence).toBe(0)
    expect(recommendation.reason).toContain("telemetry unavailable")
  })

  test("metadata does not include secrets", () => {
    const telemetry = new InMemoryProviderTelemetryStore()
    recordSeries({
      telemetry,
      provider: "openai",
      model: "gpt-5",
      agent: "coder",
      successes: 2,
      failures: 1,
      latency: [100, 110, 120],
    })
    const recommendation = scoreProviderRouteCandidates({
      candidates: [{ provider: "openai", model: "gpt-5", source: "selected" }],
      agent: "coder",
      telemetryStore: telemetry,
    })
    const serialized = JSON.stringify(recommendation)
    expect(serialized).not.toContain("apiKey")
    expect(serialized).not.toContain("Bearer")
    expect(serialized).not.toContain("sk-")
  })
})
