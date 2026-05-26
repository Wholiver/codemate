export type ProviderRouteAttemptStatus = "success" | "failure" | "skipped"

export type ProviderRouteErrorCategory =
  | "network"
  | "timeout"
  | "rate_limit"
  | "server_error"
  | "provider_unavailable"
  | "model_unavailable"
  | "validation_error"
  | "permission_denied"
  | "cancelled"
  | "unknown"

export type ProviderRouteAttempt = {
  provider?: string
  model?: string
  agent?: string
  status: ProviderRouteAttemptStatus
  error_category?: ProviderRouteErrorCategory
  retryable?: boolean
  latency_ms?: number
  fallback_index: number
  created_at: string
  skipped_due_to_circuit?: boolean
  circuit_status?: ProviderHealthStatus
  skip_reason?: string
}

export type ProviderHealthStatus = "healthy" | "degraded" | "open" | "half_open"

export type ProviderHealthState = {
  provider: string
  model?: string
  status: ProviderHealthStatus
  success_count: number
  failure_count: number
  consecutive_failures: number
  last_success_at?: string
  last_failure_at?: string
  opened_at?: string
  half_open_at?: string
  updated_at: string
}

export type ProviderCircuitBreakerConfig = {
  enabled: boolean
  failureThreshold: number
  openMs: number
  halfOpenMaxAttempts: number
  minAttempts?: number
}

export const DEFAULT_PROVIDER_CIRCUIT_BREAKER_CONFIG: ProviderCircuitBreakerConfig = {
  enabled: false,
  failureThreshold: 3,
  openMs: 60_000,
  halfOpenMaxAttempts: 1,
  minAttempts: 3,
}

export interface ProviderHealthStore {
  recordAttempt(attempt: ProviderRouteAttempt): void
  getHealth(provider: string, model?: string): ProviderHealthState | undefined
  listHealth(): ProviderHealthState[]
  shouldSkip(
    provider: string,
    model?: string,
    now?: Date,
  ): {
    skip: boolean
    reason?: string
    status?: ProviderHealthStatus
  }
}

type InternalProviderHealthState = ProviderHealthState & {
  attempts_total: number
  half_open_attempts: number
}

function asPositiveInt(value: number | undefined, fallback: number) {
  if (!Number.isFinite(value) || (value ?? 0) <= 0) return fallback
  return Math.max(1, Math.floor(value ?? fallback))
}

function asNonNegativeInt(value: number | undefined, fallback: number) {
  if (!Number.isFinite(value) || (value ?? 0) < 0) return fallback
  return Math.max(0, Math.floor(value ?? fallback))
}

function toISO(now: Date) {
  return now.toISOString()
}

function toMillis(value: string | undefined) {
  if (!value) return 0
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return 0
  return parsed
}

function keyFor(provider: string, model?: string) {
  return `${provider.trim()}::${model?.trim() ?? ""}`
}

function nowDate(input?: Date) {
  return input ?? new Date()
}

function opensCircuitForFailure(input: { category?: ProviderRouteErrorCategory; retryable?: boolean }) {
  if (input.category === "cancelled") return false
  if (input.category === "permission_denied") return false
  if (input.category === "validation_error") return false
  if (input.category === "provider_unavailable" || input.category === "model_unavailable") return true
  return input.retryable === true
}

export function normalizeCircuitBreakerConfig(
  input?: Partial<ProviderCircuitBreakerConfig>,
  warnings: string[] = [],
): ProviderCircuitBreakerConfig {
  const enabled = input?.enabled === true
  const failureThreshold = asPositiveInt(input?.failureThreshold, DEFAULT_PROVIDER_CIRCUIT_BREAKER_CONFIG.failureThreshold)
  const openMs = asPositiveInt(input?.openMs, DEFAULT_PROVIDER_CIRCUIT_BREAKER_CONFIG.openMs)
  const halfOpenMaxAttempts = asPositiveInt(
    input?.halfOpenMaxAttempts,
    DEFAULT_PROVIDER_CIRCUIT_BREAKER_CONFIG.halfOpenMaxAttempts,
  )
  const minAttempts = asNonNegativeInt(input?.minAttempts, DEFAULT_PROVIDER_CIRCUIT_BREAKER_CONFIG.minAttempts ?? 0)
  if (input?.failureThreshold !== undefined && failureThreshold !== input.failureThreshold) {
    warnings.push(`invalid circuitBreaker.failureThreshold "${String(input.failureThreshold)}"; fallback to ${failureThreshold}`)
  }
  if (input?.openMs !== undefined && openMs !== input.openMs) {
    warnings.push(`invalid circuitBreaker.openMs "${String(input.openMs)}"; fallback to ${openMs}`)
  }
  if (input?.halfOpenMaxAttempts !== undefined && halfOpenMaxAttempts !== input.halfOpenMaxAttempts) {
    warnings.push(
      `invalid circuitBreaker.halfOpenMaxAttempts "${String(input.halfOpenMaxAttempts)}"; fallback to ${halfOpenMaxAttempts}`,
    )
  }
  if (input?.minAttempts !== undefined && minAttempts !== input.minAttempts) {
    warnings.push(`invalid circuitBreaker.minAttempts "${String(input.minAttempts)}"; fallback to ${minAttempts}`)
  }
  return {
    enabled,
    failureThreshold,
    openMs,
    halfOpenMaxAttempts,
    minAttempts,
  } satisfies ProviderCircuitBreakerConfig
}

export class InMemoryProviderHealthStore implements ProviderHealthStore {
  private readonly config: ProviderCircuitBreakerConfig
  private readonly map = new Map<string, InternalProviderHealthState>()

  constructor(input?: { config?: Partial<ProviderCircuitBreakerConfig> }) {
    this.config = normalizeCircuitBreakerConfig(input?.config)
  }

  private getOrCreate(provider: string, model: string | undefined, now: Date) {
    const key = keyFor(provider, model)
    const existing = this.map.get(key)
    if (existing) return existing
    const state = {
      provider: provider.trim(),
      model: model?.trim() || undefined,
      status: "healthy",
      success_count: 0,
      failure_count: 0,
      consecutive_failures: 0,
      updated_at: toISO(now),
      attempts_total: 0,
      half_open_attempts: 0,
    } satisfies InternalProviderHealthState
    this.map.set(key, state)
    return state
  }

  private setState(state: InternalProviderHealthState) {
    this.map.set(keyFor(state.provider, state.model), state)
  }

  private moveOpenToHalfOpen(state: InternalProviderHealthState, now: Date) {
    return {
      ...state,
      status: "half_open",
      half_open_at: toISO(now),
      half_open_attempts: 0,
      updated_at: toISO(now),
    } satisfies InternalProviderHealthState
  }

  recordAttempt(attempt: ProviderRouteAttempt) {
    const provider = attempt.provider?.trim()
    if (!provider) return
    const now = nowDate(attempt.created_at ? new Date(attempt.created_at) : undefined)
    const state = this.getOrCreate(provider, attempt.model, now)
    const current = this.shouldSkip(provider, attempt.model, now)
    const preState =
      current.status === "half_open"
        ? this.map.get(keyFor(provider, attempt.model)) ?? state
        : state
    if (attempt.status === "skipped") {
      this.setState({
        ...preState,
        updated_at: toISO(now),
      })
      return
    }
    if (attempt.status === "success") {
      this.setState({
        ...preState,
        status: "healthy",
        success_count: preState.success_count + 1,
        consecutive_failures: 0,
        attempts_total: preState.attempts_total + 1,
        half_open_attempts: 0,
        last_success_at: toISO(now),
        updated_at: toISO(now),
      })
      return
    }
    const failureNext = {
      ...preState,
      failure_count: preState.failure_count + 1,
      attempts_total: preState.attempts_total + 1,
      consecutive_failures: preState.consecutive_failures + 1,
      last_failure_at: toISO(now),
      updated_at: toISO(now),
      status: preState.status === "healthy" ? ("degraded" as const) : preState.status,
    } satisfies InternalProviderHealthState
    const circuitRelevant = opensCircuitForFailure({
      category: attempt.error_category,
      retryable: attempt.retryable,
    })
    if (!this.config.enabled || !circuitRelevant) {
      this.setState(failureNext)
      return
    }
    if (failureNext.status === "half_open") {
      this.setState({
        ...failureNext,
        status: "open",
        opened_at: toISO(now),
        updated_at: toISO(now),
      })
      return
    }
    const minAttempts = Math.max(1, this.config.minAttempts ?? 1)
    const shouldOpen =
      failureNext.consecutive_failures >= this.config.failureThreshold && failureNext.attempts_total >= minAttempts
    this.setState(
      shouldOpen
        ? ({
            ...failureNext,
            status: "open",
            opened_at: toISO(now),
            updated_at: toISO(now),
          } satisfies InternalProviderHealthState)
        : failureNext,
    )
  }

  getHealth(provider: string, model?: string) {
    const state = this.map.get(keyFor(provider, model))
    if (!state) return
    const { attempts_total: _attemptsTotal, half_open_attempts: _halfOpenAttempts, ...rest } = state
    return rest
  }

  listHealth() {
    return [...this.map.values()]
      .map((state) => {
        const { attempts_total: _attemptsTotal, half_open_attempts: _halfOpenAttempts, ...rest } = state
        return rest
      })
      .toSorted((left, right) => {
        const updatedDelta = Date.parse(right.updated_at) - Date.parse(left.updated_at)
        if (updatedDelta !== 0) return updatedDelta
        return keyFor(left.provider, left.model).localeCompare(keyFor(right.provider, right.model))
      })
  }

  shouldSkip(provider: string, model?: string, nowInput?: Date) {
    if (!this.config.enabled) return { skip: false as const }
    const now = nowDate(nowInput)
    const key = keyFor(provider, model)
    const state = this.map.get(key)
    if (!state) return { skip: false as const }
    if (state.status === "open") {
      const openedMs = toMillis(state.opened_at || state.updated_at)
      const elapsed = openedMs > 0 ? now.getTime() - openedMs : 0
      if (elapsed < this.config.openMs) {
        return {
          skip: true as const,
          reason: `circuit open (${Math.max(0, this.config.openMs - elapsed)}ms remaining)`,
          status: "open" as const,
        }
      }
      const halfOpen = this.moveOpenToHalfOpen(state, now)
      this.setState(halfOpen)
      return { skip: false as const, status: "half_open" as const }
    }
    if (state.status === "half_open") {
      if (state.half_open_attempts >= this.config.halfOpenMaxAttempts) {
        return {
          skip: true as const,
          reason: "half-open attempt limit reached",
          status: "half_open" as const,
        }
      }
      this.setState({
        ...state,
        half_open_attempts: state.half_open_attempts + 1,
        updated_at: toISO(now),
      })
      return { skip: false as const, status: "half_open" as const }
    }
    return { skip: false as const, status: state.status }
  }
}

type ProviderRouteAttemptSummary = {
  total: number
  successes: number
  failures: number
  skipped: number
  fallback_used: boolean
  final_provider?: string
  final_model?: string
  error_categories: string[]
}

export function summarizeProviderRouteAttempts(attempts: ProviderRouteAttempt[]): ProviderRouteAttemptSummary {
  const total = attempts.length
  const successes = attempts.filter((item) => item.status === "success").length
  const failures = attempts.filter((item) => item.status === "failure").length
  const skipped = attempts.filter((item) => item.status === "skipped").length
  const lastSuccess = attempts.findLast((item) => item.status === "success")
  const fallback_used = attempts.some((item) => item.fallback_index > 0 && item.status === "success")
  const error_categories = [...new Set(attempts.flatMap((item) => (item.error_category ? [item.error_category] : [])))]
  return {
    total,
    successes,
    failures,
    skipped,
    fallback_used,
    final_provider: lastSuccess?.provider,
    final_model: lastSuccess?.model,
    error_categories,
  }
}

let defaultProviderHealthStore: InMemoryProviderHealthStore | undefined

export function getDefaultProviderHealthStore() {
  if (!defaultProviderHealthStore) {
    defaultProviderHealthStore = new InMemoryProviderHealthStore({
      config: DEFAULT_PROVIDER_CIRCUIT_BREAKER_CONFIG,
    })
  }
  return defaultProviderHealthStore
}

export function resetDefaultProviderHealthStore(input?: { config?: Partial<ProviderCircuitBreakerConfig> }) {
  defaultProviderHealthStore = new InMemoryProviderHealthStore({
    config: input?.config ?? DEFAULT_PROVIDER_CIRCUIT_BREAKER_CONFIG,
  })
  return defaultProviderHealthStore
}
