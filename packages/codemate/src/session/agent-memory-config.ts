import type { AgentMemoryIndex } from "@/session/agent-memory-index"
import { InMemoryAgentMemoryIndex, JsonlAgentMemoryIndex } from "@/session/agent-memory-index"
import { HybridAgentMemoryIndex } from "@/session/agent-memory-hybrid-index"
import { HnswAgentMemoryIndex, detectHnswAvailability, type HnswVectorAdapter } from "@/session/agent-memory-hnsw-index"
import { createEmbeddingProvider, type EmbeddingProvider, type EmbeddingProviderKind } from "@/session/embedding"

export type AgentMemoryBackendKind =
  | "off"
  | "jsonl"
  | "memory"
  | "hybrid-jsonl"
  | "hybrid-memory"
  | "hnsw-jsonl"
  | "hnsw-memory"
  | "agentdb"
  | "agentdb-hybrid"

export type AgentMemoryConfig = {
  enabled: boolean
  backend: AgentMemoryBackendKind
  embedding?: {
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
  hybrid?: {
    keywordWeight?: number
    semanticWeight?: number
    candidateMultiplier?: number
    candidateLimit?: number
  }
}

export type AgentMemoryConfigInput = {
  enabled?: boolean
  backend?: AgentMemoryBackendKind | string
  embedding?: {
    enabled?: boolean
    provider?: EmbeddingProviderKind | string
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
  hybrid?: {
    keywordWeight?: number
    semanticWeight?: number
    candidateMultiplier?: number
    candidateLimit?: number
  }
}

const DEFAULT_EMBEDDING_DIMENSIONS = 64
const DEFAULT_KEYWORD_WEIGHT = 0.7
const DEFAULT_SEMANTIC_WEIGHT = 0.3
const DEFAULT_CANDIDATE_MULTIPLIER = 4
const DEFAULT_CANDIDATE_LIMIT = 40

const BACKENDS: AgentMemoryBackendKind[] = [
  "off",
  "jsonl",
  "memory",
  "hybrid-jsonl",
  "hybrid-memory",
  "hnsw-jsonl",
  "hnsw-memory",
  "agentdb",
  "agentdb-hybrid",
]
const EMBEDDING_PROVIDERS: EmbeddingProviderKind[] = ["off", "deterministic", "openai-compatible", "local-http"]

export const DEFAULT_AGENT_MEMORY_CONFIG: AgentMemoryConfig = {
  enabled: true,
  backend: "jsonl",
  embedding: {
    enabled: false,
    provider: "off",
    dimensions: DEFAULT_EMBEDDING_DIMENSIONS,
  },
  hybrid: {
    keywordWeight: DEFAULT_KEYWORD_WEIGHT,
    semanticWeight: DEFAULT_SEMANTIC_WEIGHT,
    candidateMultiplier: DEFAULT_CANDIDATE_MULTIPLIER,
    candidateLimit: DEFAULT_CANDIDATE_LIMIT,
  },
}

function asRecord(input: unknown) {
  if (!input || typeof input !== "object") return {}
  return input as Record<string, unknown>
}

function asPositiveInt(value: unknown, fallback: number) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback
  return Math.max(1, Math.floor(value))
}

function asNonNegativeNumber(value: unknown, fallback: number) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fallback
  return value
}

function asOptionalString(value: unknown) {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function normalizeAgentMemoryConfig(config?: AgentMemoryConfigInput) {
  const warnings: string[] = []
  const source = asRecord(config)
  const backendValue = source.backend
  const backend =
    typeof backendValue === "string" && BACKENDS.includes(backendValue as AgentMemoryBackendKind)
      ? (backendValue as AgentMemoryBackendKind)
      : backendValue === undefined
        ? DEFAULT_AGENT_MEMORY_CONFIG.backend
        : (() => {
            warnings.push(`invalid agent memory backend "${String(backendValue)}"; fallback to "jsonl"`)
            return "jsonl" as const
          })()
  const enabledValue = source.enabled
  const enabled = typeof enabledValue === "boolean" ? enabledValue : DEFAULT_AGENT_MEMORY_CONFIG.enabled

  const embeddingSource = asRecord(source.embedding)
  const embeddingEnabledValue = embeddingSource.enabled
  const embeddingEnabled =
    typeof embeddingEnabledValue === "boolean" ? embeddingEnabledValue : (DEFAULT_AGENT_MEMORY_CONFIG.embedding?.enabled ?? false)
  const providerValue = embeddingSource.provider
  const provider =
    typeof providerValue === "string" && EMBEDDING_PROVIDERS.includes(providerValue as EmbeddingProviderKind)
      ? (providerValue as EmbeddingProviderKind)
      : providerValue === undefined
        ? (DEFAULT_AGENT_MEMORY_CONFIG.embedding?.provider ?? "off")
        : (() => {
            warnings.push(`unsupported embedding provider "${String(providerValue)}"; fallback to "off"`)
            return "off" as const
          })()
  const dimensionsValue = embeddingSource.dimensions
  const dimensions =
    typeof dimensionsValue === "number" && Number.isFinite(dimensionsValue) && dimensionsValue > 0
      ? Math.max(8, Math.floor(dimensionsValue))
      : dimensionsValue === undefined
        ? DEFAULT_EMBEDDING_DIMENSIONS
        : (() => {
            warnings.push(`invalid embedding dimensions "${String(dimensionsValue)}"; fallback to ${DEFAULT_EMBEDDING_DIMENSIONS}`)
            return DEFAULT_EMBEDDING_DIMENSIONS
          })()

  const openaiCompatibleSource = asRecord(embeddingSource.openaiCompatible)
  const localHttpSource = asRecord(embeddingSource.localHttp)

  const hybridSource = asRecord(source.hybrid)
  const keywordWeightValue = hybridSource.keywordWeight
  const semanticWeightValue = hybridSource.semanticWeight
  const keywordWeight = asNonNegativeNumber(keywordWeightValue, DEFAULT_KEYWORD_WEIGHT)
  const semanticWeight = asNonNegativeNumber(semanticWeightValue, DEFAULT_SEMANTIC_WEIGHT)
  if (keywordWeightValue !== undefined && keywordWeight === DEFAULT_KEYWORD_WEIGHT && keywordWeightValue !== DEFAULT_KEYWORD_WEIGHT) {
    warnings.push(`invalid hybrid keywordWeight "${String(keywordWeightValue)}"; fallback to ${DEFAULT_KEYWORD_WEIGHT}`)
  }
  if (semanticWeightValue !== undefined && semanticWeight === DEFAULT_SEMANTIC_WEIGHT && semanticWeightValue !== DEFAULT_SEMANTIC_WEIGHT) {
    warnings.push(`invalid hybrid semanticWeight "${String(semanticWeightValue)}"; fallback to ${DEFAULT_SEMANTIC_WEIGHT}`)
  }
  const normalizedKeywordWeight = keywordWeight + semanticWeight <= 0 ? DEFAULT_KEYWORD_WEIGHT : keywordWeight
  const normalizedSemanticWeight = keywordWeight + semanticWeight <= 0 ? DEFAULT_SEMANTIC_WEIGHT : semanticWeight
  if (keywordWeight + semanticWeight <= 0) {
    warnings.push("hybrid weights sum to zero; fallback to default weights 0.7/0.3")
  }
  const candidateMultiplierValue = hybridSource.candidateMultiplier
  const candidateLimitValue = hybridSource.candidateLimit
  const candidateMultiplier = asPositiveInt(candidateMultiplierValue, DEFAULT_CANDIDATE_MULTIPLIER)
  const candidateLimit = asPositiveInt(candidateLimitValue, DEFAULT_CANDIDATE_LIMIT)
  if (candidateMultiplierValue !== undefined && candidateMultiplier === DEFAULT_CANDIDATE_MULTIPLIER && candidateMultiplierValue !== DEFAULT_CANDIDATE_MULTIPLIER) {
    warnings.push(
      `invalid hybrid candidateMultiplier "${String(candidateMultiplierValue)}"; fallback to ${DEFAULT_CANDIDATE_MULTIPLIER}`,
    )
  }
  if (candidateLimitValue !== undefined && candidateLimit === DEFAULT_CANDIDATE_LIMIT && candidateLimitValue !== DEFAULT_CANDIDATE_LIMIT) {
    warnings.push(`invalid hybrid candidateLimit "${String(candidateLimitValue)}"; fallback to ${DEFAULT_CANDIDATE_LIMIT}`)
  }

  const normalized = {
    enabled,
    backend,
    embedding: {
      enabled: embeddingEnabled,
      provider,
      dimensions,
      openaiCompatible: {
        baseUrl: asOptionalString(openaiCompatibleSource.baseUrl),
        apiKeyEnv: asOptionalString(openaiCompatibleSource.apiKeyEnv),
        model: asOptionalString(openaiCompatibleSource.model),
        endpoint: asOptionalString(openaiCompatibleSource.endpoint),
        timeoutMs: typeof openaiCompatibleSource.timeoutMs === "number" ? openaiCompatibleSource.timeoutMs : undefined,
      },
      localHttp: {
        url: asOptionalString(localHttpSource.url),
        model: asOptionalString(localHttpSource.model),
        timeoutMs: typeof localHttpSource.timeoutMs === "number" ? localHttpSource.timeoutMs : undefined,
      },
    },
    hybrid: {
      keywordWeight: normalizedKeywordWeight,
      semanticWeight: normalizedSemanticWeight,
      candidateMultiplier,
      candidateLimit,
    },
  } satisfies AgentMemoryConfig
  return { config: normalized, warnings }
}

function resolveEmbeddingProvider(config: AgentMemoryConfig["embedding"]) {
  return createEmbeddingProvider({
    enabled: config?.enabled === true,
    provider: config?.provider ?? "off",
    dimensions: config?.dimensions,
    openaiCompatible: config?.openaiCompatible,
    localHttp: config?.localHttp,
  })
}

function detectAgentDbAvailability() {
  return {
    available: false,
    reason:
      "agentdb package is alpha with heavyweight optional native/transformers backends and no stable low-level memory CRUD contract for this runtime",
  }
}

export function createAgentMemoryIndex(projectRoot: string, config?: AgentMemoryConfigInput) {
  const normalized = normalizeAgentMemoryConfig(config)
  const warnings = [...normalized.warnings]
  if (!normalized.config.enabled || normalized.config.backend === "off") {
    return { index: undefined, config: normalized.config, warnings } as {
      index?: AgentMemoryIndex
      config: AgentMemoryConfig
      warnings: string[]
    }
  }

  const createJsonl = () => new JsonlAgentMemoryIndex({ projectRoot })
  const createMemory = () => new InMemoryAgentMemoryIndex()
  const withEmbeddingProvider = (fallbackBackend: "jsonl" | "memory") => {
    const resolved = resolveEmbeddingProvider(normalized.config.embedding)
    warnings.push(...resolved.warnings)
    if (!resolved.provider) {
      warnings.push(`embedding provider unavailable; fallback to "${fallbackBackend}"`)
    }
    return resolved.provider
  }
  const createHybrid = (base: AgentMemoryIndex, embeddingProvider: EmbeddingProvider) =>
    new HybridAgentMemoryIndex(base, embeddingProvider, {
      keywordWeight: normalized.config.hybrid?.keywordWeight,
      semanticWeight: normalized.config.hybrid?.semanticWeight,
      candidateMultiplier: normalized.config.hybrid?.candidateMultiplier,
      candidateLimit: normalized.config.hybrid?.candidateLimit,
    })
  const createHnsw = (base: AgentMemoryIndex, embeddingProvider: EmbeddingProvider) => {
    const adapter: HnswVectorAdapter | undefined = undefined
    const availability = detectHnswAvailability({ adapter })
    if (!availability.available) {
      warnings.push(`hnsw unavailable, falling back to hybrid: ${availability.reason ?? "unknown reason"}`)
      return createHybrid(base, embeddingProvider)
    }
    return new HnswAgentMemoryIndex(base, embeddingProvider, {
      adapter,
      hnswEnabled: true,
      projectRoot,
      keywordWeight: normalized.config.hybrid?.keywordWeight,
      semanticWeight: normalized.config.hybrid?.semanticWeight,
      candidateMultiplier: normalized.config.hybrid?.candidateMultiplier,
      candidateLimit: normalized.config.hybrid?.candidateLimit,
    })
  }

  if (normalized.config.backend === "jsonl") {
    return { index: createJsonl(), config: normalized.config, warnings }
  }
  if (normalized.config.backend === "memory") {
    return { index: createMemory(), config: normalized.config, warnings }
  }
  if (normalized.config.backend === "hybrid-jsonl") {
    if (!normalized.config.embedding?.enabled) {
      warnings.push('hybrid-jsonl requested with embedding disabled; fallback to "jsonl"')
      return { index: createJsonl(), config: normalized.config, warnings }
    }
    const provider = withEmbeddingProvider("jsonl")
    if (!provider) return { index: createJsonl(), config: normalized.config, warnings }
    return { index: createHybrid(createJsonl(), provider), config: normalized.config, warnings }
  }
  if (normalized.config.backend === "hybrid-memory") {
    if (!normalized.config.embedding?.enabled) {
      warnings.push('hybrid-memory requested with embedding disabled; fallback to "memory"')
      return { index: createMemory(), config: normalized.config, warnings }
    }
    const provider = withEmbeddingProvider("memory")
    if (!provider) return { index: createMemory(), config: normalized.config, warnings }
    return { index: createHybrid(createMemory(), provider), config: normalized.config, warnings }
  }
  if (normalized.config.backend === "hnsw-jsonl") {
    if (!normalized.config.embedding?.enabled) {
      warnings.push('hnsw-jsonl requested with embedding disabled; fallback to "jsonl"')
      return { index: createJsonl(), config: normalized.config, warnings }
    }
    const provider = withEmbeddingProvider("jsonl")
    if (!provider) return { index: createJsonl(), config: normalized.config, warnings }
    return { index: createHnsw(createJsonl(), provider), config: normalized.config, warnings }
  }
  if (normalized.config.backend === "hnsw-memory") {
    if (!normalized.config.embedding?.enabled) {
      warnings.push('hnsw-memory requested with embedding disabled; fallback to "memory"')
      return { index: createMemory(), config: normalized.config, warnings }
    }
    const provider = withEmbeddingProvider("memory")
    if (!provider) return { index: createMemory(), config: normalized.config, warnings }
    return { index: createHnsw(createMemory(), provider), config: normalized.config, warnings }
  }
  if (normalized.config.backend === "agentdb") {
    const availability = detectAgentDbAvailability()
    warnings.push(`agentdb unavailable, falling back to "jsonl": ${availability.reason}`)
    return { index: createJsonl(), config: normalized.config, warnings }
  }
  if (normalized.config.backend === "agentdb-hybrid") {
    const availability = detectAgentDbAvailability()
    warnings.push(`agentdb unavailable for hybrid mode: ${availability.reason}`)
    if (!normalized.config.embedding?.enabled) {
      warnings.push('agentdb-hybrid requested with embedding disabled; fallback to "jsonl"')
      return { index: createJsonl(), config: normalized.config, warnings }
    }
    const provider = withEmbeddingProvider("jsonl")
    if (!provider) return { index: createJsonl(), config: normalized.config, warnings }
    return { index: createHnsw(createJsonl(), provider), config: normalized.config, warnings }
  }
  warnings.push(`unsupported backend "${normalized.config.backend}"; fallback to "jsonl"`)
  return { index: createJsonl(), config: normalized.config, warnings }
}
