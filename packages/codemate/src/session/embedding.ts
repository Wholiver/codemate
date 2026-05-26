export type EmbeddingVector = number[]

export interface EmbeddingProvider {
  readonly providerName: string
  readonly dimensions: number
  embedText(text: string): Promise<EmbeddingVector>
  embedBatch(texts: string[]): Promise<EmbeddingVector[]>
}

export type EmbeddingProviderKind = "off" | "deterministic" | "openai-compatible" | "local-http"

export type EmbeddingProviderConfig = {
  enabled: boolean
  provider: EmbeddingProviderKind
  dimensions?: number
  openaiCompatible?: {
    baseUrl?: string
    apiKeyEnv?: string
    model?: string
    timeoutMs?: number
    endpoint?: string
  }
  localHttp?: {
    url?: string
    model?: string
    timeoutMs?: number
  }
}

export type EmbeddableMemoryRecord = {
  kind: string
  scope: string
  text: string
  tags: string[]
  metadata?: Record<string, unknown>
}

type HybridScoreWeights = {
  keyword?: number
  semantic?: number
}

const DEFAULT_EMBEDDING_DIMENSIONS = 64
const DEFAULT_EMBEDDING_TIMEOUT_MS = 10_000
const PRIVATE_KEY_BLOCK_PATTERN = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/gi
const CERTIFICATE_PEM_BLOCK_PATTERN = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gi
const TOKEN_ASSIGNMENT_PATTERN =
  /(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|bearer|token|secret|password)\b\s*[:=]\s*)([^\s,;]+)/gi
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._-]{8,}\b/gi
const OPENAI_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{10,}\b/g
const BINARY_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/

const SAFE_METADATA_KEYS = [
  "summary",
  "applies_when",
  "do",
  "dont",
  "lesson_type",
  "failure_signal",
  "repair_action",
  "success_signal",
  "outcome",
  "intent_anchor",
] as const

function compactText(input: string, max = 420) {
  const normalized = input.replace(/\s+/g, " ").trim()
  if (!normalized) return ""
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, Math.max(0, max - 15)).trimEnd()}...[truncated]`
}

function redactSensitiveText(input: string, maxChars = 420) {
  if (!input) return ""
  if (BINARY_PATTERN.test(input)) return "[REDACTED_BINARY_CONTENT]"
  return compactText(
    input
      .replace(PRIVATE_KEY_BLOCK_PATTERN, "[REDACTED_PRIVATE_KEY_BLOCK]")
      .replace(CERTIFICATE_PEM_BLOCK_PATTERN, "[REDACTED_CERTIFICATE_PEM_BLOCK]")
      .replace(TOKEN_ASSIGNMENT_PATTERN, (_m, prefix: string) => `${prefix}[REDACTED]`)
      .replace(BEARER_TOKEN_PATTERN, "Bearer [REDACTED]")
      .replace(OPENAI_KEY_PATTERN, "[REDACTED_API_KEY]"),
    maxChars,
  )
}

function safeMetadataLines(metadata: Record<string, unknown> | undefined) {
  if (!metadata) return [] as string[]
  return SAFE_METADATA_KEYS.flatMap((key) => {
    const value = metadata[key]
    if (typeof value === "string") {
      const next = redactSensitiveText(value, 320)
      if (!next) return []
      return [`${key}: ${next}`]
    }
    if (Array.isArray(value)) {
      const values = [
        ...new Set(
          value
            .filter((item): item is string => typeof item === "string")
            .map((item) => redactSensitiveText(item, 180))
            .filter(Boolean),
        ),
      ]
      if (values.length === 0) return []
      return [`${key}: ${values.join("; ")}`]
    }
    return []
  })
}

function normalizeTextForEmbedding(input: string) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff\s]+/g, " ")
    .split(/\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

function fnv1a32(input: string) {
  let hash = 2166136261
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function ngrams(token: string) {
  if (token.length <= 3) return [token]
  return Array.from({ length: token.length - 2 }, (_, index) => token.slice(index, index + 3))
}

function normalizePositiveDimensions(value: number | undefined, warnings: string[]) {
  if (value === undefined) return undefined
  if (!Number.isFinite(value) || value <= 0) {
    warnings.push(`invalid embedding dimensions "${String(value)}"; fallback to ${DEFAULT_EMBEDDING_DIMENSIONS}`)
    return DEFAULT_EMBEDDING_DIMENSIONS
  }
  return Math.max(8, Math.floor(value))
}

function normalizeTimeoutMs(value: number | undefined) {
  if (!Number.isFinite(value) || (value ?? 0) <= 0) return DEFAULT_EMBEDDING_TIMEOUT_MS
  return Math.max(100, Math.floor(value ?? DEFAULT_EMBEDDING_TIMEOUT_MS))
}

function compact(value: string | undefined) {
  const trimmed = value?.trim()
  if (!trimmed) return
  return trimmed
}

function joinUrl(baseUrl: string, endpoint: string) {
  const left = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl
  const right = endpoint.startsWith("/") ? endpoint : `/${endpoint}`
  return `${left}${right}`
}

function asRecord(value: unknown) {
  if (!value || typeof value !== "object") return
  return value as Record<string, unknown>
}

function isAbortError(error: unknown) {
  if (error instanceof DOMException && error.name === "AbortError") return true
  return !!(error && typeof error === "object" && "name" in error && error.name === "AbortError")
}

function parseVector(value: unknown) {
  if (!Array.isArray(value)) return
  const vector = value.map((item) => (typeof item === "number" && Number.isFinite(item) ? item : Number.NaN))
  if (vector.some((item) => !Number.isFinite(item))) return
  return vector
}

function parseEmbeddingResponse(body: unknown): EmbeddingVector[] | undefined {
  const top = asRecord(body)
  if (!top) return
  const single = parseVector(top.embedding)
  if (single) return [single]
  if (Array.isArray(top.embeddings)) {
    const vectors = top.embeddings.map((item) => parseVector(item)).filter((item): item is EmbeddingVector => !!item)
    if (vectors.length > 0) return vectors
  }
  if (Array.isArray(top.data)) {
    const vectors = top.data
      .map((item) => parseVector(asRecord(item)?.embedding))
      .filter((item): item is EmbeddingVector => !!item)
    if (vectors.length > 0) return vectors
  }
  return
}

async function parseHttpBody(response: Response, providerName: string) {
  if (!response.ok) {
    const statusText = compact(response.statusText)
    throw new Error(`${providerName} embedding HTTP ${response.status}${statusText ? ` ${statusText}` : ""}`)
  }
  const text = await response.text().catch(() => "")
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${providerName} embedding response is not valid JSON`)
  }
}

async function postJson(input: {
  providerName: string
  url: string
  body: Record<string, unknown>
  headers?: Record<string, string>
  timeoutMs: number
}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs)
  try {
    return await fetch(input.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(input.headers ?? {}),
      },
      body: JSON.stringify(input.body),
      signal: controller.signal,
    })
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error(`${input.providerName} embedding request timed out after ${input.timeoutMs}ms`)
    }
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${input.providerName} embedding request failed: ${redactSensitiveText(message, 180)}`)
  } finally {
    clearTimeout(timeout)
  }
}

function matchExpectedDimensions(input: { providerName: string; vectors: EmbeddingVector[]; expected?: number }) {
  if (!input.expected || input.vectors.length === 0) return input.vectors
  const mismatch = input.vectors.find((vector) => vector.length !== input.expected)
  if (mismatch) {
    throw new Error(
      `${input.providerName} embedding dimensions mismatch: expected ${input.expected}, received ${mismatch.length}`,
    )
  }
  return input.vectors
}

export function normalizeVector(vector: EmbeddingVector) {
  if (vector.length === 0) return []
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
  if (!Number.isFinite(norm) || norm <= 0) return vector.map(() => 0)
  return vector.map((value) => value / norm)
}

export function cosineSimilarity(a: EmbeddingVector, b: EmbeddingVector) {
  if (a.length === 0 || b.length === 0) return 0
  if (a.length !== b.length) return 0
  const normalizedA = normalizeVector(a)
  const normalizedB = normalizeVector(b)
  const dot = normalizedA.reduce((sum, value, index) => sum + value * (normalizedB[index] ?? 0), 0)
  if (!Number.isFinite(dot)) return 0
  if (dot > 1) return 1
  if (dot < -1) return -1
  return dot
}

export function buildMemoryEmbeddingText(record: EmbeddableMemoryRecord) {
  const lines = [
    `kind: ${record.kind}`,
    `scope: ${record.scope}`,
    `text: ${redactSensitiveText(record.text, 520)}`,
    `tags: ${record.tags.join(", ")}`,
    ...safeMetadataLines(record.metadata),
  ].filter((line) => !line.endsWith(": "))
  return lines.join("\n")
}

export function hybridMemoryScore(keywordScore: number, semanticScore: number, weights?: HybridScoreWeights) {
  const keywordWeight = Number.isFinite(weights?.keyword) ? Number(weights?.keyword) : 0.7
  const semanticWeight = Number.isFinite(weights?.semantic) ? Number(weights?.semantic) : 0.3
  const total = keywordWeight + semanticWeight
  if (!Number.isFinite(total) || total <= 0) return 0
  return keywordScore * (keywordWeight / total) + semanticScore * (semanticWeight / total)
}

export class DeterministicEmbeddingProvider implements EmbeddingProvider {
  readonly providerName: string
  readonly dimensions: number
  private readonly salt: string

  constructor(input?: { dimensions?: number; providerName?: string; salt?: string }) {
    this.dimensions = Math.max(8, Math.floor(input?.dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS))
    this.providerName = input?.providerName?.trim() || "deterministic-test"
    this.salt = input?.salt?.trim() || "codemate-deterministic-embedding"
  }

  async embedText(text: string) {
    const source = normalizeTextForEmbedding(text)
    if (source.length === 0) return Array.from({ length: this.dimensions }, () => 0)
    const vector = Array.from({ length: this.dimensions }, () => 0)
    source.forEach((token, tokenIndex) => {
      ngrams(token).forEach((gram, gramIndex) => {
        const hash = fnv1a32(`${this.salt}|${gram}|${tokenIndex}|${gramIndex}`)
        const slotA = hash % this.dimensions
        const slotB = (hash >>> 7) % this.dimensions
        const sign = (hash & 1) === 0 ? 1 : -1
        const magnitude = 0.5 + ((hash >>> 8) % 1024) / 1024
        vector[slotA] += sign * magnitude
        vector[slotB] += sign * (magnitude / 2)
      })
    })
    return normalizeVector(vector)
  }

  async embedBatch(texts: string[]) {
    return Promise.all(texts.map((text) => this.embedText(text)))
  }
}

export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly providerName: string
  private readonly url: string
  private readonly apiKey: string
  private readonly model: string
  private readonly timeoutMs: number
  private readonly lockedDimensions?: number
  private resolvedDimensions: number

  constructor(input: {
    baseUrl: string
    apiKey: string
    model: string
    endpoint?: string
    timeoutMs?: number
    dimensions?: number
    providerName?: string
  }) {
    this.providerName = input.providerName?.trim() || "openai-compatible"
    this.url = joinUrl(input.baseUrl, input.endpoint?.trim() || "/embeddings")
    this.apiKey = input.apiKey
    this.model = input.model
    this.timeoutMs = normalizeTimeoutMs(input.timeoutMs)
    const dimensions = Math.max(8, Math.floor(input.dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS))
    this.resolvedDimensions = dimensions
    this.lockedDimensions = input.dimensions ? dimensions : undefined
  }

  get dimensions() {
    return this.resolvedDimensions
  }

  private applyVectors(vectors: EmbeddingVector[]) {
    const matched = matchExpectedDimensions({
      providerName: this.providerName,
      vectors,
      expected: this.lockedDimensions,
    })
    if (!this.lockedDimensions) {
      const first = matched[0]
      if (first && first.length > 0) this.resolvedDimensions = first.length
    }
    return matched
  }

  async embedText(text: string) {
    const result = await this.embedBatch([text])
    return result[0] ?? []
  }

  async embedBatch(texts: string[]) {
    if (texts.length === 0) return []
    const response = await postJson({
      providerName: this.providerName,
      url: this.url,
      timeoutMs: this.timeoutMs,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
      },
      body: {
        model: this.model,
        input: texts,
      },
    })
    const body = await parseHttpBody(response, this.providerName)
    const vectors = parseEmbeddingResponse(body)
    if (!vectors || vectors.length === 0) {
      throw new Error(`${this.providerName} embedding response missing vectors`)
    }
    if (vectors.length !== texts.length) {
      throw new Error(`${this.providerName} embedding response count mismatch: expected ${texts.length}, received ${vectors.length}`)
    }
    return this.applyVectors(vectors)
  }
}

export class LocalHttpEmbeddingProvider implements EmbeddingProvider {
  readonly providerName: string
  private readonly url: string
  private readonly model?: string
  private readonly timeoutMs: number
  private readonly lockedDimensions?: number
  private resolvedDimensions: number

  constructor(input: {
    url: string
    model?: string
    timeoutMs?: number
    dimensions?: number
    providerName?: string
  }) {
    this.providerName = input.providerName?.trim() || "local-http"
    this.url = input.url
    this.model = compact(input.model)
    this.timeoutMs = normalizeTimeoutMs(input.timeoutMs)
    const dimensions = Math.max(8, Math.floor(input.dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS))
    this.resolvedDimensions = dimensions
    this.lockedDimensions = input.dimensions ? dimensions : undefined
  }

  get dimensions() {
    return this.resolvedDimensions
  }

  private applyVectors(vectors: EmbeddingVector[]) {
    const matched = matchExpectedDimensions({
      providerName: this.providerName,
      vectors,
      expected: this.lockedDimensions,
    })
    if (!this.lockedDimensions) {
      const first = matched[0]
      if (first && first.length > 0) this.resolvedDimensions = first.length
    }
    return matched
  }

  async embedText(text: string) {
    const result = await this.embedBatch([text])
    return result[0] ?? []
  }

  async embedBatch(texts: string[]) {
    if (texts.length === 0) return []
    const response = await postJson({
      providerName: this.providerName,
      url: this.url,
      timeoutMs: this.timeoutMs,
      body: {
        ...(this.model ? { model: this.model } : {}),
        input: texts,
      },
    })
    const body = await parseHttpBody(response, this.providerName)
    const vectors = parseEmbeddingResponse(body)
    if (!vectors || vectors.length === 0) {
      throw new Error(`${this.providerName} embedding response missing vectors`)
    }
    if (vectors.length !== texts.length) {
      throw new Error(`${this.providerName} embedding response count mismatch: expected ${texts.length}, received ${vectors.length}`)
    }
    return this.applyVectors(vectors)
  }
}

export function createEmbeddingProvider(config: EmbeddingProviderConfig | undefined) {
  const warnings: string[] = []
  if (!config || config.enabled !== true || config.provider === "off") {
    return { provider: undefined, warnings } as { provider?: EmbeddingProvider; warnings: string[] }
  }

  const dimensions = normalizePositiveDimensions(config.dimensions, warnings)
  if (config.provider === "deterministic") {
    return {
      provider: new DeterministicEmbeddingProvider({ dimensions }),
      warnings,
    } as { provider?: EmbeddingProvider; warnings: string[] }
  }

  if (config.provider === "openai-compatible") {
    const baseUrl = compact(config.openaiCompatible?.baseUrl)
    const apiKeyEnv = compact(config.openaiCompatible?.apiKeyEnv)
    const model = compact(config.openaiCompatible?.model)
    const apiKey = apiKeyEnv ? compact(process.env[apiKeyEnv]) : undefined
    if (!baseUrl) warnings.push('embedding openai-compatible requires openaiCompatible.baseUrl; provider disabled')
    if (!apiKeyEnv) warnings.push('embedding openai-compatible requires openaiCompatible.apiKeyEnv; provider disabled')
    if (!model) warnings.push('embedding openai-compatible requires openaiCompatible.model; provider disabled')
    if (apiKeyEnv && !apiKey) warnings.push(`embedding openai-compatible missing env ${apiKeyEnv}; provider disabled`)
    if (!baseUrl || !apiKey || !model) {
      return { provider: undefined, warnings } as { provider?: EmbeddingProvider; warnings: string[] }
    }
    return {
      provider: new OpenAICompatibleEmbeddingProvider({
        baseUrl,
        apiKey,
        model,
        endpoint: compact(config.openaiCompatible?.endpoint),
        timeoutMs: config.openaiCompatible?.timeoutMs,
        dimensions,
      }),
      warnings,
    } as { provider?: EmbeddingProvider; warnings: string[] }
  }

  if (config.provider === "local-http") {
    const url = compact(config.localHttp?.url)
    if (!url) {
      warnings.push('embedding local-http requires localHttp.url; provider disabled')
      return { provider: undefined, warnings } as { provider?: EmbeddingProvider; warnings: string[] }
    }
    return {
      provider: new LocalHttpEmbeddingProvider({
        url,
        model: compact(config.localHttp?.model),
        timeoutMs: config.localHttp?.timeoutMs,
        dimensions,
      }),
      warnings,
    } as { provider?: EmbeddingProvider; warnings: string[] }
  }

  warnings.push(`unsupported embedding provider "${String(config.provider)}"; provider disabled`)
  return { provider: undefined, warnings } as { provider?: EmbeddingProvider; warnings: string[] }
}
