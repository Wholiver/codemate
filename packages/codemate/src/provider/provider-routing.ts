import {
  DEFAULT_PROVIDER_CIRCUIT_BREAKER_CONFIG,
  getDefaultProviderHealthStore,
  normalizeCircuitBreakerConfig,
  type ProviderCircuitBreakerConfig,
  type ProviderHealthStatus,
  type ProviderHealthStore,
} from "@/provider/provider-health"
import {
  normalizeProviderTelemetryStoreConfig,
  resolveProviderTelemetryStore,
  type ProviderTelemetryStoreConfigInput,
  type ProviderTelemetryStore,
} from "@/provider/provider-telemetry"
import {
  scoreProviderRouteCandidates,
  type ProviderRouteCandidate,
  type ProviderRouteRecommendation,
} from "@/provider/provider-route-scoring"

export type ProviderRouteAgent =
  | "orchestrator"
  | "planner"
  | "research"
  | "coder"
  | "tester"
  | "reviewer"
  | "writer"
  | "selfcheck"

export type ProviderRouteTarget = {
  provider?: string
  model?: string
  reason?: string
}

export type ProviderRouteRule = {
  provider?: string
  model?: string
  fallback?: ProviderRouteTarget[]
  maxRetries?: number
  timeoutMs?: number
  enabled?: boolean
}

export type ProviderRoutingConfig = {
  enabled: boolean
  defaultProvider?: string
  defaultModel?: string
  routes?: Partial<Record<ProviderRouteAgent, ProviderRouteRule>>
  fallback?: ProviderRouteTarget[]
  strict?: boolean
  circuitBreaker?: Partial<ProviderCircuitBreakerConfig>
  outcome_routing?: Partial<ProviderOutcomeRoutingConfig>
  telemetry?: ProviderTelemetryStoreConfigInput
}

export type ProviderOutcomeRoutingMode = "off" | "dry_run" | "enabled"

export type ProviderOutcomeRoutingConfig = {
  mode: ProviderOutcomeRoutingMode
  minConfidence?: number
  minSamples?: number
}

export type ProviderRouteDecision = {
  enabled: boolean
  agent: ProviderRouteAgent
  selected: ProviderRouteTarget
  fallback: ProviderRouteTarget[]
  maxRetries: number
  timeoutMs?: number
  reason: string
  warnings: string[]
  source: "disabled" | "agent-route" | "default-route" | "current-provider" | "fallback"
  circuit_breaker: ProviderCircuitBreakerConfig
  skipped_due_to_circuit: Array<{
    provider?: string
    model?: string
    reason?: string
    status?: ProviderHealthStatus
  }>
  fallback_used_due_to_health: boolean
  recommendation?: ProviderRouteRecommendation
  outcome_routing: {
    mode: ProviderOutcomeRoutingMode
    effective_mode: "off" | "dry_run"
    minConfidence: number
    minSamples: number
  }
}

export type ProviderFallbackPlan = {
  primary: ProviderRouteTarget
  fallback: ProviderRouteTarget[]
  maxRetries: number
  timeoutMs?: number
}

export type ProviderRouteResolveInput = {
  agent: ProviderRouteAgent
  taskRole?: string
  currentProvider?: string
  currentModel?: string
  config?: Partial<ProviderRoutingConfig>
  availableProviders?: string[]
  availableModels?: Record<string, string[]>
  healthStore?: ProviderHealthStore
  telemetryStore?: ProviderTelemetryStore
  projectRoot?: string
  now?: Date
}

export const DEFAULT_PROVIDER_ROUTING_CONFIG: ProviderRoutingConfig = {
  enabled: false,
  routes: {},
  circuitBreaker: DEFAULT_PROVIDER_CIRCUIT_BREAKER_CONFIG,
  outcome_routing: {
    mode: "off",
    minConfidence: 0.65,
    minSamples: 5,
  },
  telemetry: {
    enabled: false,
    store: "memory",
  },
}

const DEFAULT_MAX_RETRIES = 1

function compact(input: string | undefined) {
  const value = input?.trim()
  if (!value) return
  return value
}

function keyForTarget(target: ProviderRouteTarget) {
  return `${target.provider ?? ""}::${target.model ?? ""}`
}

function normalizeTarget(target: ProviderRouteTarget | undefined) {
  if (!target) return
  const provider = compact(target.provider)
  const model = compact(target.model)
  const reason = compact(target.reason)
  if (!provider && !model) return
  return { provider, model, reason } satisfies ProviderRouteTarget
}

function normalizeTargets(input: ProviderRouteTarget[] | undefined) {
  return uniqueTargets(
    (input ?? []).flatMap((item) => {
      const normalized = normalizeTarget(item)
      if (!normalized) return []
      return [normalized]
    }),
  )
}

function uniqueTargets(input: ProviderRouteTarget[]) {
  const seen = new Set<string>()
  return input.filter((target) => {
    const key = keyForTarget(target)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function parseRetries(value: number | undefined, warnings: string[]) {
  if (value === undefined) return DEFAULT_MAX_RETRIES
  if (!Number.isFinite(value) || value <= 0) {
    warnings.push(`invalid maxRetries "${String(value)}"; fallback to ${DEFAULT_MAX_RETRIES}`)
    return DEFAULT_MAX_RETRIES
  }
  return Math.max(1, Math.floor(value))
}

function parseTimeout(value: number | undefined, warnings: string[]) {
  if (value === undefined) return undefined
  if (!Number.isFinite(value) || value <= 0) {
    warnings.push(`invalid timeoutMs "${String(value)}"; timeout disabled`)
    return undefined
  }
  return Math.floor(value)
}

function providerKnown(provider: string | undefined, availableProviders: string[] | undefined) {
  if (!provider) return true
  if (!availableProviders || availableProviders.length === 0) return true
  return availableProviders.includes(provider)
}

function modelKnown(provider: string | undefined, model: string | undefined, availableModels: Record<string, string[]> | undefined) {
  if (!model) return true
  if (!provider) return true
  if (!availableModels) return true
  const models = availableModels[provider]
  if (!models || models.length === 0) return false
  return models.includes(model)
}

function fillModelIfMissing(input: ProviderRouteTarget, availableModels: Record<string, string[]> | undefined) {
  if (input.model) return input
  if (!input.provider) return input
  const fallbackModel = availableModels?.[input.provider]?.[0]
  if (!fallbackModel) return input
  return { ...input, model: fallbackModel } satisfies ProviderRouteTarget
}

function normalizeConfig(input?: Partial<ProviderRoutingConfig>) {
  const warnings: string[] = []
  const enabled = typeof input?.enabled === "boolean" ? input.enabled : DEFAULT_PROVIDER_ROUTING_CONFIG.enabled
  const defaultProvider = compact(input?.defaultProvider)
  const defaultModel = compact(input?.defaultModel)
  const strict = input?.strict === true
  const fallback = normalizeTargets(input?.fallback)
  const circuitBreaker = normalizeCircuitBreakerConfig(input?.circuitBreaker, warnings)
  const outcomeModeRaw = input?.outcome_routing?.mode
  const outcomeMode: ProviderOutcomeRoutingMode =
    outcomeModeRaw === "off" || outcomeModeRaw === "dry_run" || outcomeModeRaw === "enabled" ? outcomeModeRaw : "off"
  if (outcomeModeRaw !== undefined && outcomeModeRaw !== outcomeMode) {
    warnings.push(`invalid outcome_routing.mode "${String(outcomeModeRaw)}"; fallback to "off"`)
  }
  const minConfidenceRaw = input?.outcome_routing?.minConfidence
  const minConfidence =
    typeof minConfidenceRaw === "number" && Number.isFinite(minConfidenceRaw) ? Math.max(0, Math.min(1, minConfidenceRaw)) : 0.65
  if (minConfidenceRaw !== undefined && minConfidenceRaw !== minConfidence) {
    warnings.push(`invalid outcome_routing.minConfidence "${String(minConfidenceRaw)}"; clamped to ${minConfidence}`)
  }
  const minSamplesRaw = input?.outcome_routing?.minSamples
  const minSamples =
    typeof minSamplesRaw === "number" && Number.isFinite(minSamplesRaw) ? Math.max(1, Math.floor(minSamplesRaw)) : 5
  if (minSamplesRaw !== undefined && minSamplesRaw !== minSamples) {
    warnings.push(`invalid outcome_routing.minSamples "${String(minSamplesRaw)}"; clamped to ${minSamples}`)
  }
  const telemetry = normalizeProviderTelemetryStoreConfig(input?.telemetry, {
    routingEnabled: enabled,
    warnings,
  })
  const routes = (Object.entries(input?.routes ?? {}) as [ProviderRouteAgent, ProviderRouteRule | undefined][])
    .filter((entry): entry is [ProviderRouteAgent, ProviderRouteRule] => !!entry[1])
    .reduce<Partial<Record<ProviderRouteAgent, ProviderRouteRule>>>((acc, [agent, rule]) => {
      const provider = compact(rule.provider)
      const model = compact(rule.model)
      const maxRetries = rule.maxRetries
      const timeoutMs = rule.timeoutMs
      acc[agent] = {
        provider,
        model,
        enabled: rule.enabled,
        maxRetries,
        timeoutMs,
        fallback: normalizeTargets(rule.fallback),
      }
      return acc
    }, {})
  return {
    config: {
      enabled,
      defaultProvider,
      defaultModel,
      strict,
      fallback,
      circuitBreaker,
      outcome_routing: {
        mode: outcomeMode,
        minConfidence,
        minSamples,
      },
      telemetry,
      routes,
    } satisfies ProviderRoutingConfig,
    warnings,
  }
}

function matchSelected(target: ProviderRouteTarget, selected: ProviderRouteTarget) {
  if (!selected.provider && !selected.model) return false
  return (target.provider ?? selected.provider) === selected.provider && (target.model ?? selected.model) === selected.model
}

function fallbackFromSources(input: {
  routeFallback?: ProviderRouteTarget[]
  globalFallback?: ProviderRouteTarget[]
  selected: ProviderRouteTarget
  strict: boolean
  availableProviders?: string[]
  availableModels?: Record<string, string[]>
  warnings: string[]
}) {
  const merged = uniqueTargets([...(input.routeFallback ?? []), ...(input.globalFallback ?? [])])
  const withoutSelected = merged.filter((item) => !matchSelected(item, input.selected))
  if (!input.strict) return withoutSelected
  return withoutSelected.filter((item) => {
    const knownProvider = providerKnown(item.provider, input.availableProviders)
    if (!knownProvider) {
      input.warnings.push(`fallback provider "${item.provider}" is unavailable; removed by strict mode`)
      return false
    }
    const knownModel = modelKnown(item.provider, item.model, input.availableModels)
    if (!knownModel) {
      input.warnings.push(`fallback model "${item.provider}/${item.model}" is unavailable; removed by strict mode`)
      return false
    }
    return true
  })
}

function stableReason(source: ProviderRouteDecision["source"], agent: ProviderRouteAgent) {
  if (source === "disabled") return "provider routing disabled"
  if (source === "agent-route") return `agent route matched for ${agent}`
  if (source === "default-route") return "using default provider route"
  if (source === "fallback") return "primary route invalid; fallback selected"
  return "using current provider/model"
}

export function resolveProviderRoute(input: ProviderRouteResolveInput): ProviderRouteDecision {
  const normalized = normalizeConfig(input.config)
  const warnings = [...normalized.warnings]
  const currentProvider = compact(input.currentProvider)
  const currentModel = compact(input.currentModel)
  const currentTarget = {
    provider: currentProvider,
    model: currentModel,
  } satisfies ProviderRouteTarget
  if (!normalized.config.enabled) {
    return {
      enabled: false,
      agent: input.agent,
      selected: currentTarget,
      fallback: [],
      maxRetries: DEFAULT_MAX_RETRIES,
      timeoutMs: undefined,
      reason: stableReason("disabled", input.agent),
      warnings,
      source: "disabled",
      circuit_breaker: normalized.config.circuitBreaker ?? DEFAULT_PROVIDER_CIRCUIT_BREAKER_CONFIG,
      skipped_due_to_circuit: [],
      fallback_used_due_to_health: false,
      recommendation: undefined,
      outcome_routing: {
        mode: normalized.config.outcome_routing?.mode ?? "off",
        effective_mode: "off",
        minConfidence: normalized.config.outcome_routing?.minConfidence ?? 0.65,
        minSamples: normalized.config.outcome_routing?.minSamples ?? 5,
      },
    }
  }

  const routeRule = normalized.config.routes?.[input.agent]
  const routeEnabled = routeRule?.enabled !== false
  const hasAgentRoute = !!routeRule && routeEnabled && (!!routeRule.provider || !!routeRule.model)
  const hasDefaultRoute = !!normalized.config.defaultProvider || !!normalized.config.defaultModel
  const source: ProviderRouteDecision["source"] = hasAgentRoute
    ? "agent-route"
    : hasDefaultRoute
      ? "default-route"
      : "current-provider"
  const seed = source === "agent-route" ? routeRule : undefined
  const providerFromSource = compact(seed?.provider) ?? compact(normalized.config.defaultProvider) ?? currentProvider
  const modelFromSource = compact(seed?.model) ?? compact(normalized.config.defaultModel) ?? currentModel
  const selectedSeed = fillModelIfMissing({ provider: providerFromSource, model: modelFromSource }, input.availableModels)
  const selectedProviderKnown = providerKnown(selectedSeed.provider, input.availableProviders)
  const selectedModelKnown = modelKnown(selectedSeed.provider, selectedSeed.model, input.availableModels)
  if (!selectedProviderKnown) warnings.push(`selected provider "${selectedSeed.provider}" is unavailable`)
  if (!selectedModelKnown) warnings.push(`selected model "${selectedSeed.provider}/${selectedSeed.model}" is unavailable`)
  const strictInvalid = normalized.config.strict && (!selectedProviderKnown || !selectedModelKnown)
  const strictFallbackSource = strictInvalid ? uniqueTargets([...(routeRule?.fallback ?? []), ...(normalized.config.fallback ?? [])])[0] : undefined
  const selected = strictInvalid
    ? fillModelIfMissing(normalizeTarget(strictFallbackSource) ?? currentTarget, input.availableModels)
    : selectedSeed
  const selectedSource =
    strictInvalid && selected !== currentTarget && !!selected.provider && !!selected.model ? "fallback" : strictInvalid ? "current-provider" : source
  if (strictInvalid) warnings.push("strict mode disabled invalid primary route")
  const routeMaxRetries = parseRetries(routeRule?.maxRetries, warnings)
  const timeoutMs = parseTimeout(routeRule?.timeoutMs, warnings)
  const fallback = fallbackFromSources({
    routeFallback: routeRule?.fallback,
    globalFallback: normalized.config.fallback,
    selected,
    strict: normalized.config.strict === true,
    availableProviders: input.availableProviders,
    availableModels: input.availableModels,
    warnings,
  })
  const healthStore = input.healthStore ?? getDefaultProviderHealthStore()
  const telemetryStoreResolved = input.telemetryStore
    ? { store: input.telemetryStore, warnings: [] as string[] }
    : resolveProviderTelemetryStore({
        routingEnabled: normalized.config.enabled,
        telemetry: normalized.config.telemetry,
        projectRoot: input.projectRoot,
      })
  warnings.push(...telemetryStoreResolved.warnings)
  const telemetryStore = telemetryStoreResolved.store
  const circuitBreaker = normalized.config.circuitBreaker ?? DEFAULT_PROVIDER_CIRCUIT_BREAKER_CONFIG
  const healthAwareCandidates = [selected, ...fallback]
  const healthVerdicts: Array<{
    target: ProviderRouteTarget
    skip: boolean
    reason?: string
    status?: ProviderHealthStatus
  }> = circuitBreaker.enabled
    ? healthAwareCandidates.map((target) => {
        const provider = target.provider?.trim()
        if (!provider) {
          return {
            target,
            skip: false,
          }
        }
        const verdict = healthStore.shouldSkip(provider, target.model, input.now)
        return {
          target,
          skip: verdict.skip,
          reason: verdict.reason,
          status: verdict.status,
        }
      })
    : healthAwareCandidates.map((target) => ({ target, skip: false }))
  const skippedDueToCircuit = healthVerdicts.flatMap((item) =>
    item.skip
      ? [
          {
            provider: item.target.provider,
            model: item.target.model,
            reason: item.reason,
            status: item.status,
          },
        ]
      : [],
  )
  const healthFiltered = healthVerdicts.flatMap((item) => (item.skip ? [] : [item.target]))
  const healthSelected = healthFiltered[0] ?? selected
  const healthFallback = healthFiltered.slice(1)
  const fallbackUsedDueToHealth =
    healthFiltered.length > 0 &&
    (healthSelected.provider !== selected.provider || healthSelected.model !== selected.model) &&
    skippedDueToCircuit.some((item) => item.provider === selected.provider && item.model === selected.model)
  if (fallbackUsedDueToHealth) {
    warnings.push("primary route skipped due to circuit status; selected healthy fallback target")
  }
  if (circuitBreaker.enabled && healthFiltered.length === 0) {
    warnings.push("all route targets are currently skipped by circuit breaker")
  }
  const configuredOutcomeMode = normalized.config.outcome_routing?.mode ?? "off"
  const effectiveOutcomeMode: "off" | "dry_run" = configuredOutcomeMode === "off" ? "off" : "dry_run"
  if (configuredOutcomeMode === "enabled") {
    warnings.push("outcome routing enabled mode is not implemented; falling back to dry_run")
  }
  const recommendationCandidates: ProviderRouteCandidate[] = [
    ...new Map(
      healthAwareCandidates.map((candidate, index) => [
        `${candidate.provider ?? ""}::${candidate.model ?? ""}`,
        { ...candidate, source: index === 0 ? "selected" : "fallback" } satisfies ProviderRouteCandidate,
      ]),
    ).values(),
  ]
  const recommendation =
    effectiveOutcomeMode === "dry_run" && recommendationCandidates.length > 0
      ? scoreProviderRouteCandidates({
          candidates: recommendationCandidates,
          agent: input.agent,
          telemetryStore,
          healthStore,
          currentSelected: { provider: healthSelected.provider, model: healthSelected.model, source: "selected" },
        })
      : undefined
  return {
    enabled: true,
    agent: input.agent,
    selected: healthSelected,
    fallback: healthFallback,
    maxRetries: routeMaxRetries,
    timeoutMs,
    reason: stableReason(selectedSource, input.agent),
    warnings,
    source: fallbackUsedDueToHealth ? "fallback" : selectedSource,
    circuit_breaker: circuitBreaker,
    skipped_due_to_circuit: skippedDueToCircuit,
    fallback_used_due_to_health: fallbackUsedDueToHealth,
    recommendation,
    outcome_routing: {
      mode: configuredOutcomeMode,
      effective_mode: effectiveOutcomeMode,
      minConfidence: normalized.config.outcome_routing?.minConfidence ?? 0.65,
      minSamples: normalized.config.outcome_routing?.minSamples ?? 5,
    },
  }
}

export function createRecommendedProviderRoutes(): ProviderRoutingConfig {
  return {
    enabled: false,
    strict: false,
    routes: {
      orchestrator: { enabled: true, maxRetries: 1 },
      planner: { enabled: true, maxRetries: 1, timeoutMs: 120000 },
      research: { enabled: true, maxRetries: 1, timeoutMs: 180000 },
      coder: { enabled: true, maxRetries: 1 },
      tester: { enabled: true, maxRetries: 1 },
      reviewer: { enabled: true, maxRetries: 1 },
      writer: { enabled: true, maxRetries: 1 },
      selfcheck: { enabled: true, maxRetries: 1 },
    },
    fallback: [],
  }
}

export async function runWithProviderFallback<T>(
  plan: ProviderFallbackPlan,
  runAttempt: (target: ProviderRouteTarget, attempt: number) => Promise<T>,
  input?: { isRetryable?: (error: unknown) => boolean },
) {
  const attempts = [plan.primary, ...plan.fallback]
  const maxAttempts = Math.max(1, plan.maxRetries)
  const visited: { target: ProviderRouteTarget; success: boolean; error?: unknown }[] = []
  for (let index = 0; index < attempts.length; index += 1) {
    const target = attempts[index]
    for (let retry = 0; retry < maxAttempts; retry += 1) {
      try {
        const result = await runAttempt(target, retry)
        visited.push({ target, success: true })
        return { ok: true as const, result, visited, target }
      } catch (error) {
        visited.push({ target, success: false, error })
        const retryable = input?.isRetryable ? input.isRetryable(error) : true
        if (!retryable) {
          return {
            ok: false as const,
            error,
            visited,
          }
        }
        if (retry + 1 >= maxAttempts) break
      }
    }
  }
  return {
    ok: false as const,
    error: visited.at(-1)?.error,
    visited,
  }
}

export function providerRouteDecisionMetadata(decision: ProviderRouteDecision) {
  return {
    selected_provider: decision.selected.provider,
    selected_model: decision.selected.model,
    fallback_count: decision.fallback.length,
    source: decision.source,
    reason: decision.reason,
    warnings: decision.warnings,
    circuit_breaker_enabled: decision.circuit_breaker.enabled,
    skipped_due_to_circuit: decision.skipped_due_to_circuit.map((item) => `${item.provider ?? ""}/${item.model ?? ""}`),
    fallback_used_due_to_health: decision.fallback_used_due_to_health,
    outcome_routing_mode: decision.outcome_routing.mode,
    outcome_routing_effective_mode: decision.outcome_routing.effective_mode,
    recommendation: decision.recommendation
      ? {
          read_only: decision.recommendation.read_only,
          recommended_provider: decision.recommendation.recommended?.provider,
          recommended_model: decision.recommendation.recommended?.model,
          confidence: decision.recommendation.confidence,
          reason: decision.recommendation.reason,
          warnings: decision.recommendation.warnings,
          top_scores: decision.recommendation.scores.slice(0, 3).map((item) => ({
            provider: item.candidate.provider,
            model: item.candidate.model,
            score: item.score,
            confidence: item.confidence,
            sample_size: item.sample_size,
          })),
        }
      : undefined,
  }
}

export function asProviderRouteAgent(agent: string): ProviderRouteAgent {
  if (agent === "orchestrator") return "orchestrator"
  if (agent === "planner") return "planner"
  if (agent === "research") return "research"
  if (agent === "coder") return "coder"
  if (agent === "tester") return "tester"
  if (agent === "reviewer") return "reviewer"
  if (agent === "writer") return "writer"
  if (agent === "selfcheck") return "selfcheck"
  return "orchestrator"
}
