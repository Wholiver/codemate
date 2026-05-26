import * as Log from "@codemate-ai/core/util/log"
import path from "node:path"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import type { ProviderRouteAttempt, ProviderRouteErrorCategory } from "@/provider/provider-health"

const log = Log.create({ service: "provider-telemetry" })

export type ProviderTelemetryDimension = "provider" | "model" | "agent" | "error_category"

export type ProviderTelemetryQuery = {
  provider?: string
  model?: string
  agent?: string
  error_category?: ProviderRouteErrorCategory
  since?: string | Date
  until?: string | Date
  window_ms?: number
  now?: Date
  group_by?: ProviderTelemetryDimension[]
}

export type ProviderTelemetryBucket = {
  provider?: string
  model?: string
  agent?: string
  error_category?: ProviderRouteErrorCategory
  total_attempts: number
  successes: number
  failures: number
  skipped: number
  success_rate: number
  failure_rate: number
  fallback_used_rate: number
  retryable_failure_rate: number
  p50_latency_ms: number
  p95_latency_ms: number
  last_success_at?: string
  last_failure_at?: string
}

export type ProviderTelemetryStats = {
  total_attempts: number
  generated_at: string
  query: ProviderTelemetryQuery
  buckets: ProviderTelemetryBucket[]
}

export interface ProviderTelemetryStore {
  recordAttempt(attempt: ProviderRouteAttempt): void
  queryStats(query?: ProviderTelemetryQuery): ProviderTelemetryStats
  reset(): void
}

export type ProviderTelemetryStoreKind = "memory" | "jsonl"

export type ProviderTelemetryStoreConfigInput = {
  enabled?: boolean
  store?: ProviderTelemetryStoreKind | string
}

export type ProviderTelemetryStoreConfig = {
  enabled: boolean
  store: ProviderTelemetryStoreKind
}

type ProviderTelemetryRecord = {
  provider?: string
  model?: string
  agent?: string
  status: ProviderRouteAttempt["status"]
  error_category?: ProviderRouteErrorCategory
  retryable?: boolean
  latency_ms?: number
  fallback_index: number
  created_at: string
}

const DEFAULT_PROVIDER_TELEMETRY_STORE_KIND: ProviderTelemetryStoreKind = "memory"

function toMillis(input: string | Date | undefined) {
  if (!input) return
  const value = input instanceof Date ? input.getTime() : Date.parse(input)
  if (!Number.isFinite(value)) return
  return value
}

function normalizeText(input: string | undefined) {
  const value = input?.trim()
  if (!value) return
  return value
}

function asArray<T>(input: T[] | undefined) {
  if (!input || input.length === 0) return [] as T[]
  return [...new Set(input)]
}

function percentile(values: number[], p: number) {
  if (values.length === 0) return 0
  const sorted = [...values].toSorted((a, b) => a - b)
  if (sorted.length === 1) return sorted[0] ?? 0
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[rank] ?? 0
}

function safeRate(numerator: number, denominator: number) {
  if (denominator <= 0) return 0
  return numerator / denominator
}

function keyFor(record: ProviderTelemetryRecord, dimensions: ProviderTelemetryDimension[]) {
  if (dimensions.length === 0) return "__all__"
  return dimensions
    .map((dimension) => {
      if (dimension === "provider") return `provider:${record.provider ?? ""}`
      if (dimension === "model") return `model:${record.model ?? ""}`
      if (dimension === "agent") return `agent:${record.agent ?? ""}`
      return `error_category:${record.error_category ?? ""}`
    })
    .join("|")
}

function isWithinWindow(record: ProviderTelemetryRecord, query: ProviderTelemetryQuery, now: Date) {
  const timestamp = toMillis(record.created_at)
  if (timestamp === undefined) return false
  const since = query.window_ms && query.window_ms > 0 ? now.getTime() - query.window_ms : toMillis(query.since)
  const until = toMillis(query.until)
  if (since !== undefined && timestamp < since) return false
  if (until !== undefined && timestamp > until) return false
  return true
}

function buildBucket(records: ProviderTelemetryRecord[], dimensions: ProviderTelemetryDimension[]) {
  const first = records[0]
  if (!first) {
    return {
      total_attempts: 0,
      successes: 0,
      failures: 0,
      skipped: 0,
      success_rate: 0,
      failure_rate: 0,
      fallback_used_rate: 0,
      retryable_failure_rate: 0,
      p50_latency_ms: 0,
      p95_latency_ms: 0,
    } satisfies ProviderTelemetryBucket
  }
  const total = records.length
  const successes = records.filter((item) => item.status === "success").length
  const failures = records.filter((item) => item.status === "failure").length
  const skipped = records.filter((item) => item.status === "skipped").length
  const fallbackUsed = records.filter((item) => item.fallback_index > 0).length
  const retryableFailures = records.filter((item) => item.status === "failure" && item.retryable === true).length
  const latencies = records.flatMap((item) => {
    if (typeof item.latency_ms !== "number" || !Number.isFinite(item.latency_ms)) return []
    if (item.latency_ms < 0) return []
    return [item.latency_ms]
  })
  const lastSuccess = records
    .filter((item) => item.status === "success")
    .map((item) => item.created_at)
    .toSorted((a, b) => Date.parse(b) - Date.parse(a))[0]
  const lastFailure = records
    .filter((item) => item.status === "failure")
    .map((item) => item.created_at)
    .toSorted((a, b) => Date.parse(b) - Date.parse(a))[0]
  return {
    provider: dimensions.includes("provider") ? first.provider : undefined,
    model: dimensions.includes("model") ? first.model : undefined,
    agent: dimensions.includes("agent") ? first.agent : undefined,
    error_category: dimensions.includes("error_category") ? first.error_category : undefined,
    total_attempts: total,
    successes,
    failures,
    skipped,
    success_rate: safeRate(successes, total),
    failure_rate: safeRate(failures, total),
    fallback_used_rate: safeRate(fallbackUsed, total),
    retryable_failure_rate: safeRate(retryableFailures, total),
    p50_latency_ms: percentile(latencies, 50),
    p95_latency_ms: percentile(latencies, 95),
    last_success_at: lastSuccess,
    last_failure_at: lastFailure,
  } satisfies ProviderTelemetryBucket
}

function sanitizeAttempt(attempt: ProviderRouteAttempt): ProviderTelemetryRecord | undefined {
  const createdAt = normalizeText(attempt.created_at)
  if (!createdAt) return
  return {
    provider: normalizeText(attempt.provider),
    model: normalizeText(attempt.model),
    agent: normalizeText(attempt.agent),
    status: attempt.status,
    error_category: attempt.error_category,
    retryable: attempt.retryable,
    latency_ms: typeof attempt.latency_ms === "number" && Number.isFinite(attempt.latency_ms) ? attempt.latency_ms : undefined,
    fallback_index: Number.isFinite(attempt.fallback_index) ? Math.max(0, Math.floor(attempt.fallback_index)) : 0,
    created_at: createdAt,
  }
}

function isTelemetryStatus(value: unknown): value is ProviderRouteAttempt["status"] {
  return value === "success" || value === "failure" || value === "skipped"
}

function asRecord(value: unknown) {
  if (!value || typeof value !== "object") return
  return value as Record<string, unknown>
}

function toTelemetryRecord(value: unknown): ProviderTelemetryRecord | undefined {
  const base = asRecord(value)
  if (!base) return
  const status = base.status
  if (!isTelemetryStatus(status)) return
  const createdAt = typeof base.created_at === "string" ? normalizeText(base.created_at) : undefined
  if (!createdAt) return
  const fallbackIndex = typeof base.fallback_index === "number" && Number.isFinite(base.fallback_index) ? Math.max(0, Math.floor(base.fallback_index)) : 0
  const errorCategory =
    typeof base.error_category === "string"
      ? (base.error_category as ProviderRouteErrorCategory)
      : undefined
  return {
    provider: typeof base.provider === "string" ? normalizeText(base.provider) : undefined,
    model: typeof base.model === "string" ? normalizeText(base.model) : undefined,
    agent: typeof base.agent === "string" ? normalizeText(base.agent) : undefined,
    status,
    error_category: errorCategory,
    retryable: typeof base.retryable === "boolean" ? base.retryable : undefined,
    latency_ms: typeof base.latency_ms === "number" && Number.isFinite(base.latency_ms) ? base.latency_ms : undefined,
    fallback_index: fallbackIndex,
    created_at: createdAt,
  }
}

function buildStats(recordsInput: ProviderTelemetryRecord[], query: ProviderTelemetryQuery = {}) {
  const now = query.now ?? new Date()
  const dimensions = asArray(query.group_by)
  const records = recordsInput
    .filter((record) => isWithinWindow(record, query, now))
    .filter((record) => !query.provider || record.provider === query.provider)
    .filter((record) => !query.model || record.model === query.model)
    .filter((record) => !query.agent || record.agent === query.agent)
    .filter((record) => !query.error_category || record.error_category === query.error_category)
  const grouped = records.reduce<Map<string, ProviderTelemetryRecord[]>>((acc, record) => {
    const key = keyFor(record, dimensions)
    const prev = acc.get(key)
    if (prev) {
      prev.push(record)
    } else {
      acc.set(key, [record])
    }
    return acc
  }, new Map())
  const buckets = [...grouped.values()]
    .map((group) => buildBucket(group, dimensions))
    .toSorted((left, right) => right.total_attempts - left.total_attempts)
  return {
    total_attempts: records.length,
    generated_at: new Date().toISOString(),
    query,
    buckets,
  } satisfies ProviderTelemetryStats
}

function warning(message: string) {
  log.warn(message)
}

export function pathProjectProviderTelemetry(projectRoot: string) {
  return path.join(projectRoot, ".codemate", "provider-telemetry.jsonl")
}

export function normalizeProviderTelemetryStoreConfig(
  input: ProviderTelemetryStoreConfigInput | undefined,
  options: { routingEnabled?: boolean; warnings?: string[] } = {},
): ProviderTelemetryStoreConfig {
  const warnings = options.warnings ?? []
  const routingEnabled = options.routingEnabled === true
  const enabled = typeof input?.enabled === "boolean" ? input.enabled : routingEnabled
  const storeRaw = input?.store
  const store: ProviderTelemetryStoreKind =
    storeRaw === "memory" || storeRaw === "jsonl"
      ? storeRaw
      : storeRaw === undefined
        ? DEFAULT_PROVIDER_TELEMETRY_STORE_KIND
        : (() => {
            warnings.push(`invalid provider_routing.telemetry.store "${String(storeRaw)}"; fallback to "${DEFAULT_PROVIDER_TELEMETRY_STORE_KIND}"`)
            return DEFAULT_PROVIDER_TELEMETRY_STORE_KIND
          })()
  return {
    enabled,
    store,
  }
}

export class InMemoryProviderTelemetryStore implements ProviderTelemetryStore {
  private readonly attempts: ProviderTelemetryRecord[] = []

  recordAttempt(attempt: ProviderRouteAttempt) {
    const normalized = sanitizeAttempt(attempt)
    if (!normalized) return
    this.attempts.push(normalized)
  }

  queryStats(query: ProviderTelemetryQuery = {}) {
    return buildStats(this.attempts, query)
  }

  reset() {
    this.attempts.length = 0
  }
}

export class JsonlProviderTelemetryStore implements ProviderTelemetryStore {
  private readonly filePath: string
  private readonly onWarning: (message: string) => void

  constructor(input: { filePath: string; onWarning?: (message: string) => void }) {
    this.filePath = input.filePath
    this.onWarning = input.onWarning ?? warning
  }

  private readAllRecords() {
    if (!existsSync(this.filePath)) return [] as ProviderTelemetryRecord[]
    let text = ""
    try {
      text = readFileSync(this.filePath, "utf8")
    } catch (error) {
      this.onWarning(`provider telemetry read failed: ${error instanceof Error ? error.message : String(error)}`)
      return []
    }
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line, index) => {
        try {
          const parsed = JSON.parse(line)
          const record = toTelemetryRecord(parsed)
          if (!record) {
            this.onWarning(`provider telemetry corrupt line ${index + 1}: invalid schema`)
            return []
          }
          return [record]
        } catch {
          this.onWarning(`provider telemetry corrupt line ${index + 1}: JSON parse failed`)
          return []
        }
      })
  }

  recordAttempt(attempt: ProviderRouteAttempt) {
    const normalized = sanitizeAttempt(attempt)
    if (!normalized) return
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true })
      appendFileSync(this.filePath, `${JSON.stringify(normalized)}\n`, "utf8")
    } catch (error) {
      this.onWarning(`provider telemetry append failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  queryStats(query: ProviderTelemetryQuery = {}) {
    return buildStats(this.readAllRecords(), query)
  }

  reset() {
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true })
      writeFileSync(this.filePath, "", "utf8")
    } catch (error) {
      this.onWarning(`provider telemetry reset failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

type ProviderTelemetryStoreResolveInput = {
  routingEnabled?: boolean
  telemetry?: ProviderTelemetryStoreConfigInput
  projectRoot?: string
}

type ProviderTelemetryStoreResolveResult = {
  store: ProviderTelemetryStore
  config: ProviderTelemetryStoreConfig
  warnings: string[]
  filePath?: string
}

let defaultProviderTelemetryStore: InMemoryProviderTelemetryStore | undefined
const jsonlProviderTelemetryStores = new Map<string, JsonlProviderTelemetryStore>()

export function getDefaultProviderTelemetryStore() {
  if (!defaultProviderTelemetryStore) {
    defaultProviderTelemetryStore = new InMemoryProviderTelemetryStore()
  }
  return defaultProviderTelemetryStore
}

export function resolveProviderTelemetryStore(input: ProviderTelemetryStoreResolveInput = {}): ProviderTelemetryStoreResolveResult {
  const warnings: string[] = []
  const config = normalizeProviderTelemetryStoreConfig(input.telemetry, {
    routingEnabled: input.routingEnabled,
    warnings,
  })
  if (config.store === "jsonl") {
    const projectRoot = input.projectRoot?.trim()
    if (!projectRoot) {
      warnings.push('provider_routing.telemetry.store="jsonl" requires project root; fallback to "memory"')
    } else {
      const filePath = pathProjectProviderTelemetry(projectRoot)
      let store = jsonlProviderTelemetryStores.get(filePath)
      if (!store) {
        store = new JsonlProviderTelemetryStore({ filePath })
        jsonlProviderTelemetryStores.set(filePath, store)
      }
      return {
        store,
        config,
        warnings,
        filePath,
      }
    }
  }
  return {
    store: getDefaultProviderTelemetryStore(),
    config,
    warnings,
  }
}

export function resetDefaultProviderTelemetryStore() {
  defaultProviderTelemetryStore = new InMemoryProviderTelemetryStore()
  jsonlProviderTelemetryStores.clear()
  return defaultProviderTelemetryStore
}
