import type { ProviderHealthStatus, ProviderHealthStore } from "@/provider/provider-health"
import type { ProviderTelemetryStore } from "@/provider/provider-telemetry"

export type ProviderRouteCandidate = {
  provider?: string
  model?: string
  source?: "selected" | "fallback" | "current" | "other"
}

export type ProviderRouteScore = {
  candidate: ProviderRouteCandidate
  score: number
  sample_size: number
  success_rate: number
  fallback_used_rate: number
  retryable_failure_rate: number
  p95_latency_ms: number
  health_status?: ProviderHealthStatus
  confidence: number
  reasons: string[]
}

export type ProviderRouteRecommendation = {
  read_only: true
  recommended?: ProviderRouteCandidate
  scores: ProviderRouteScore[]
  reason: string
  confidence: number
  warnings: string[]
}

export type ProviderRouteScoreInput = {
  candidates: ProviderRouteCandidate[]
  agent?: string
  telemetryStore?: ProviderTelemetryStore
  healthStore?: ProviderHealthStore
  currentSelected?: ProviderRouteCandidate
}

function toKey(candidate: ProviderRouteCandidate) {
  return `${candidate.provider ?? ""}::${candidate.model ?? ""}`
}

function asRate(value: number | undefined) {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, Number(value)))
}

function clamp01(value: number) {
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

function latencyScore(p95: number) {
  if (!Number.isFinite(p95) || p95 <= 0) return 0.6
  return clamp01(1 / (1 + p95 / 2000))
}

function healthPenalty(status: ProviderHealthStatus | undefined) {
  if (status === "open") return 0.4
  if (status === "half_open") return 0.25
  if (status === "degraded") return 0.12
  return 0
}

function sampleConfidence(sampleSize: number) {
  if (!Number.isFinite(sampleSize) || sampleSize <= 0) return 0
  return clamp01(Math.sqrt(sampleSize / 20))
}

export function scoreProviderRouteCandidates(input: ProviderRouteScoreInput): ProviderRouteRecommendation {
  const warnings: string[] = []
  const deduped = [...new Map((input.candidates ?? []).map((candidate) => [toKey(candidate), candidate])).values()]
  if (deduped.length === 0) {
    return {
      read_only: true,
      scores: [],
      reason: "no route candidates",
      confidence: 0,
      warnings: ["no route candidates available for scoring"],
    }
  }
  if (!input.telemetryStore) {
    return {
      read_only: true,
      scores: deduped.map((candidate) => ({
        candidate,
        score: 0,
        sample_size: 0,
        success_rate: 0,
        fallback_used_rate: 0,
        retryable_failure_rate: 0,
        p95_latency_ms: 0,
        health_status: input.healthStore?.getHealth(candidate.provider ?? "", candidate.model)?.status,
        confidence: 0,
        reasons: ["telemetry unavailable"],
      })),
      recommended: input.currentSelected,
      reason: "telemetry unavailable",
      confidence: 0,
      warnings: ["provider telemetry store unavailable"],
    }
  }

  const scores = deduped.map((candidate) => {
    const provider = candidate.provider?.trim()
    const model = candidate.model?.trim()
    const stats = provider
      ? input.telemetryStore!.queryStats({
          provider,
          model,
          agent: input.agent,
        })
      : input.telemetryStore!.queryStats({
          model,
          agent: input.agent,
        })
    const bucket = stats.buckets[0]
    const sampleSize = bucket?.total_attempts ?? 0
    const successRate = asRate(bucket?.success_rate)
    const fallbackUsedRate = asRate(bucket?.fallback_used_rate)
    const retryableFailureRate = asRate(bucket?.retryable_failure_rate)
    const p95 = bucket?.p95_latency_ms ?? 0
    const healthStatus = provider ? input.healthStore?.getHealth(provider, model)?.status : undefined
    const confidence = sampleConfidence(sampleSize)
    const raw =
      successRate * 0.62 +
      latencyScore(p95) * 0.16 -
      fallbackUsedRate * 0.11 -
      retryableFailureRate * 0.18 -
      healthPenalty(healthStatus)
    const score = clamp01(raw) * (0.55 + confidence * 0.45)
    const reasons = [
      `success_rate=${successRate.toFixed(2)}`,
      `fallback_used_rate=${fallbackUsedRate.toFixed(2)}`,
      `retryable_failure_rate=${retryableFailureRate.toFixed(2)}`,
      `p95_latency_ms=${Math.round(p95)}`,
      `sample_size=${sampleSize}`,
      `health_status=${healthStatus ?? "unknown"}`,
      `confidence=${confidence.toFixed(2)}`,
    ]
    if (sampleSize < 3) warnings.push(`low sample size for ${provider ?? "unknown"}/${model ?? "unknown"}: ${sampleSize}`)
    return {
      candidate,
      score,
      sample_size: sampleSize,
      success_rate: successRate,
      fallback_used_rate: fallbackUsedRate,
      retryable_failure_rate: retryableFailureRate,
      p95_latency_ms: p95,
      health_status: healthStatus,
      confidence,
      reasons,
    } satisfies ProviderRouteScore
  })

  const ranked = scores.toSorted((left, right) => {
    if (right.score !== left.score) return right.score - left.score
    if (right.confidence !== left.confidence) return right.confidence - left.confidence
    return toKey(left.candidate).localeCompare(toKey(right.candidate))
  })
  const recommended = ranked[0]?.candidate
  const confidence = ranked[0]?.confidence ?? 0
  if (!recommended) {
    return {
      read_only: true,
      scores: ranked,
      reason: "no telemetry recommendation",
      confidence: 0,
      warnings,
    }
  }
  return {
    read_only: true,
    scores: ranked,
    recommended,
    reason: "recommendation derived from telemetry scoring (read-only)",
    confidence,
    warnings,
  }
}
