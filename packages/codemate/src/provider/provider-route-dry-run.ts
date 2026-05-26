import type { ProviderHealthStatus, ProviderHealthStore } from "@/provider/provider-health"
import type { ProviderRouteRecommendation } from "@/provider/provider-route-scoring"
import type { ProviderRouteDecision } from "@/provider/provider-routing"
import type { ProviderTelemetryStore } from "@/provider/provider-telemetry"

export type ProviderRouteDryRunBlocker =
  | "read_only"
  | "low_confidence"
  | "insufficient_samples"
  | "same_as_selected"
  | "unhealthy_recommendation"
  | "missing_recommendation"

export type ProviderRouteDryRunReport = {
  enabled: boolean
  read_only: true
  agent?: string
  task_role?: string
  selected: {
    provider?: string
    model?: string
    source?: string
  }
  recommended?: {
    provider?: string
    model?: string
    confidence: number
    reason: string
  }
  would_switch: boolean
  switch_blocked_by: ProviderRouteDryRunBlocker[]
  health?: {
    selected_status?: string
    recommended_status?: string
  }
  telemetry?: {
    selected_success_rate?: number
    recommended_success_rate?: number
    selected_p95_latency_ms?: number
    recommended_p95_latency_ms?: number
    sample_size?: number
  }
  warnings: string[]
  created_at: string
}

type BuildProviderRouteDryRunReportInput = {
  decision: ProviderRouteDecision
  recommendation?: ProviderRouteRecommendation
  healthStore?: ProviderHealthStore
  telemetryStore?: ProviderTelemetryStore
  minConfidence?: number
  minSamples?: number
  now?: Date
}

function normalizeText(value: string | undefined) {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function sameTarget(
  left: { provider?: string; model?: string } | undefined,
  right: { provider?: string; model?: string } | undefined,
) {
  return normalizeText(left?.provider) === normalizeText(right?.provider) && normalizeText(left?.model) === normalizeText(right?.model)
}

function includesBlocker(blockers: ProviderRouteDryRunBlocker[], blocker: ProviderRouteDryRunBlocker) {
  return blockers.includes(blocker)
}

function healthIsUnhealthy(status: ProviderHealthStatus | undefined) {
  return status === "open"
}

function firstBucketSampleSize(recommendation: ProviderRouteRecommendation | undefined) {
  return recommendation?.scores[0]?.sample_size
}

function scoreSampleSize(
  recommendation: ProviderRouteRecommendation | undefined,
  provider: string | undefined,
  model: string | undefined,
) {
  if (!recommendation) return undefined
  const score = recommendation.scores.find(
    (item) => normalizeText(item.candidate.provider) === normalizeText(provider) && normalizeText(item.candidate.model) === normalizeText(model),
  )
  return score?.sample_size
}

export function buildProviderRouteDryRunReport(input: BuildProviderRouteDryRunReportInput): ProviderRouteDryRunReport {
  const now = input.now ?? new Date()
  const minConfidence = Number.isFinite(input.minConfidence) ? Math.max(0, Math.min(1, input.minConfidence!)) : 0.65
  const minSamples = Number.isFinite(input.minSamples) ? Math.max(1, Math.floor(input.minSamples!)) : 5
  const decision = input.decision
  const recommendation = input.recommendation ?? decision.recommendation
  const selected = {
    provider: normalizeText(decision.selected.provider),
    model: normalizeText(decision.selected.model),
    source: decision.source,
  }
  const recommended = recommendation?.recommended
    ? {
        provider: normalizeText(recommendation.recommended.provider),
        model: normalizeText(recommendation.recommended.model),
        confidence: recommendation.confidence,
        reason: recommendation.reason,
      }
    : undefined
  const selectedHealth = selected.provider ? input.healthStore?.getHealth(selected.provider, selected.model)?.status : undefined
  const recommendedHealth = recommended?.provider
    ? input.healthStore?.getHealth(recommended.provider, recommended.model)?.status
    : undefined

  const selectedTelemetry = input.telemetryStore?.queryStats({
    provider: selected.provider,
    model: selected.model,
    agent: decision.agent,
  }).buckets[0]
  const recommendedTelemetry = recommended
    ? input.telemetryStore?.queryStats({
        provider: recommended.provider,
        model: recommended.model,
        agent: decision.agent,
      }).buckets[0]
    : undefined

  const selectedSamples =
    scoreSampleSize(recommendation, selected.provider, selected.model) ??
    selectedTelemetry?.total_attempts ??
    firstBucketSampleSize(recommendation) ??
    0
  const recommendedSamples =
    (recommended
      ? scoreSampleSize(recommendation, recommended.provider, recommended.model) ?? recommendedTelemetry?.total_attempts
      : undefined) ?? 0
  const effectiveSamples = recommended ? recommendedSamples : selectedSamples
  const blockers: ProviderRouteDryRunBlocker[] = []
  const warnings = [...decision.warnings, ...(recommendation?.warnings ?? [])]

  if (!recommended) blockers.push("missing_recommendation")
  if (recommended && sameTarget(selected, recommended)) blockers.push("same_as_selected")
  if (recommended && Number.isFinite(recommended.confidence) && recommended.confidence < minConfidence) blockers.push("low_confidence")
  if (recommended && effectiveSamples < minSamples) blockers.push("insufficient_samples")
  if (recommended && healthIsUnhealthy(recommendedHealth)) blockers.push("unhealthy_recommendation")

  let wouldSwitch = false
  if (
    recommended &&
    !sameTarget(selected, recommended) &&
    !includesBlocker(blockers, "low_confidence") &&
    !includesBlocker(blockers, "insufficient_samples") &&
    !includesBlocker(blockers, "unhealthy_recommendation")
  ) {
    wouldSwitch = true
    blockers.push("read_only")
  }

  return {
    enabled: decision.enabled,
    read_only: true,
    agent: decision.agent,
    selected,
    recommended,
    would_switch: wouldSwitch,
    switch_blocked_by: [...new Set(blockers)],
    health: {
      selected_status: selectedHealth,
      recommended_status: recommendedHealth,
    },
    telemetry: {
      selected_success_rate: selectedTelemetry?.success_rate,
      recommended_success_rate: recommendedTelemetry?.success_rate,
      selected_p95_latency_ms: selectedTelemetry?.p95_latency_ms,
      recommended_p95_latency_ms: recommendedTelemetry?.p95_latency_ms,
      sample_size: effectiveSamples,
    },
    warnings,
    created_at: now.toISOString(),
  }
}

