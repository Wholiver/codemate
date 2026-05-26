import type {
  AgentMemoryIndex,
  AgentMemoryListOptions,
  AgentMemoryRecord,
  AgentMemorySearchOptions,
  AgentMemoryStats,
} from "@/session/agent-memory-index"
import {
  buildMemoryEmbeddingText,
  cosineSimilarity,
  type EmbeddingProvider,
  hybridMemoryScore,
  type EmbeddingVector,
} from "@/session/embedding"

export type HybridAgentMemoryIndexOptions = {
  keywordWeight?: number
  semanticWeight?: number
  candidateLimit?: number
  candidateMultiplier?: number
  persistEmbeddingsOnSearch?: boolean
}

function asPositiveInt(value: number | undefined, fallback: number) {
  if (!Number.isFinite(value)) return fallback
  if ((value ?? 0) <= 0) return fallback
  return Math.max(1, Math.floor(value ?? fallback))
}

function embeddingText(record: AgentMemoryRecord) {
  return buildMemoryEmbeddingText({
    kind: record.kind,
    scope: record.scope,
    text: record.text,
    tags: record.tags,
    metadata: record.metadata,
  })
}

function validVector(vector: unknown, dimensions: number): vector is EmbeddingVector {
  if (!Array.isArray(vector)) return false
  if (vector.length !== dimensions) return false
  return vector.every((value) => typeof value === "number" && Number.isFinite(value))
}

function toSemanticScore(queryVector: EmbeddingVector, vector: EmbeddingVector | undefined) {
  if (!vector || vector.length !== queryVector.length) return 0
  return (cosineSimilarity(queryVector, vector) + 1) / 2
}

function toRankScore(index: number, total: number) {
  if (total <= 1) return 1
  return (total - index) / total
}

function toMillis(value: string) {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return 0
  return parsed
}

export class HybridAgentMemoryIndex implements AgentMemoryIndex {
  private readonly base: AgentMemoryIndex
  private readonly embeddingProvider: EmbeddingProvider
  private readonly options: HybridAgentMemoryIndexOptions

  constructor(base: AgentMemoryIndex, embeddingProvider: EmbeddingProvider, options: HybridAgentMemoryIndexOptions = {}) {
    this.base = base
    this.embeddingProvider = embeddingProvider
    this.options = options
  }

  private targetLimit(limit: number | undefined) {
    const desired = asPositiveInt(limit, 10)
    const explicit = asPositiveInt(this.options.candidateLimit, 0)
    if (explicit > 0) return Math.max(desired, explicit)
    const multiplier = asPositiveInt(this.options.candidateMultiplier, 4)
    return Math.max(desired, desired * multiplier)
  }

  private async embedRecord(record: AgentMemoryRecord) {
    const vector = await this.embeddingProvider
      .embedText(embeddingText(record))
      .then((value) => (validVector(value, this.embeddingProvider.dimensions) ? value : undefined))
      .catch(() => undefined)
    if (!vector) return
    return {
      vector,
      provider: this.embeddingProvider.providerName,
      dimensions: this.embeddingProvider.dimensions,
      updated_at: new Date().toISOString(),
    } satisfies NonNullable<AgentMemoryRecord["embedding"]>
  }

  private async ensureEmbeddings(records: AgentMemoryRecord[]) {
    const withExisting = new Map(
      records
        .map((record) => [record.id, record.embedding?.vector] as const)
        .filter((entry): entry is readonly [string, EmbeddingVector] =>
          validVector(entry[1], this.embeddingProvider.dimensions),
        ),
    )
    const missing = records.filter((record) => !withExisting.has(record.id))
    if (missing.length === 0) return withExisting
    const texts = missing.map((record) => embeddingText(record))
    const vectors = await this.embeddingProvider
      .embedBatch(texts)
      .then((batch) =>
        batch.map((vector) => (validVector(vector, this.embeddingProvider.dimensions) ? vector : undefined)),
      )
      .catch(() => [])
    const embedded = missing
      .map((record, index) => ({ record, vector: vectors[index] }))
      .filter((item): item is { record: AgentMemoryRecord; vector: EmbeddingVector } => !!item.vector)
    embedded.forEach((item) => withExisting.set(item.record.id, item.vector))
    if (embedded.length === 0 || this.options.persistEmbeddingsOnSearch === false) return withExisting
    await Promise.allSettled(
      embedded.map((item) =>
        this.base.upsert({
          ...item.record,
          embedding: {
            vector: item.vector,
            provider: this.embeddingProvider.providerName,
            dimensions: this.embeddingProvider.dimensions,
            updated_at: new Date().toISOString(),
          },
        }),
      ),
    )
    return withExisting
  }

  async upsert(record: AgentMemoryRecord) {
    const persisted = await this.base.upsert(record)
    const embedding = await this.embedRecord(persisted)
    if (!embedding) return persisted
    return this.base
      .upsert({
        ...persisted,
        embedding,
      })
      .catch(() => persisted)
  }

  async search(query: string, options: AgentMemorySearchOptions = {}) {
    const limit = asPositiveInt(options.limit, 10)
    const keywordCandidates = await this.base.search(query, {
      ...options,
      limit: this.targetLimit(limit),
    })
    if (!query.trim()) return keywordCandidates.slice(0, limit)
    if (keywordCandidates.length === 0) return []
    const queryVector = await this.embeddingProvider
      .embedText(query)
      .then((vector) => (validVector(vector, this.embeddingProvider.dimensions) ? vector : undefined))
      .catch(() => undefined)
    if (!queryVector) return keywordCandidates.slice(0, limit)
    const vectors = await this.ensureEmbeddings(keywordCandidates)
    return keywordCandidates
      .map((record, index) => {
        const keywordScore = toRankScore(index, keywordCandidates.length)
        const semanticScore = toSemanticScore(queryVector, vectors.get(record.id))
        return {
          record,
          score: hybridMemoryScore(keywordScore, semanticScore, {
            keyword: this.options.keywordWeight,
            semantic: this.options.semanticWeight,
          }),
          semanticScore,
        }
      })
      .toSorted((left, right) => {
        if (right.score !== left.score) return right.score - left.score
        if (right.semanticScore !== left.semanticScore) return right.semanticScore - left.semanticScore
        if (right.record.confidence !== left.record.confidence) return right.record.confidence - left.record.confidence
        const updatedDelta = toMillis(right.record.updated_at) - toMillis(left.record.updated_at)
        if (updatedDelta !== 0) return updatedDelta
        return left.record.id.localeCompare(right.record.id)
      })
      .map((item) => item.record)
      .slice(0, limit)
  }

  async delete(id: string) {
    return this.base.delete(id)
  }

  async stats() {
    return this.base.stats()
  }

  async list(options: AgentMemoryListOptions = {}) {
    return this.base.list(options)
  }
}

export class VectorAgentMemoryIndex extends HybridAgentMemoryIndex {}
