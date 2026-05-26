import { mkdir, readFile, writeFile } from "fs/promises"
import path from "path"
import type {
  AgentMemoryIndex,
  AgentMemoryListOptions,
  AgentMemoryRecord,
  AgentMemorySearchOptions,
  AgentMemoryStats,
} from "@/session/agent-memory-index"
import { HybridAgentMemoryIndex, type HybridAgentMemoryIndexOptions } from "@/session/agent-memory-hybrid-index"
import { buildMemoryEmbeddingText, type EmbeddingProvider, hybridMemoryScore, type EmbeddingVector } from "@/session/embedding"
import { HNSW } from "hnsw"

export type HnswAvailability = {
  available: boolean
  reason?: string
}

export type HnswVectorCandidate = {
  id: string
  score: number
}

export interface HnswVectorAdapter {
  readonly adapterName: string
  readonly dimensions: number
  upsert(input: { id: string; vector: EmbeddingVector }): Promise<void>
  search(input: { vector: EmbeddingVector; limit: number }): Promise<HnswVectorCandidate[]>
  delete(id: string): Promise<void>
}

type PersistedHnswState = {
  version: 1
  provider: string
  dimensions: number
  nextLabel: number
  idToLabel: Array<[string, number]>
  tombstones: number[]
  indexedUpdatedAt: Array<[string, string]>
  index: ReturnType<HNSW["toJSON"]>
}

export type HnswAgentMemoryIndexOptions = HybridAgentMemoryIndexOptions & {
  adapter?: HnswVectorAdapter
  hnswEnabled?: boolean
  projectRoot?: string
  persistencePath?: string
  onWarning?: (message: string, error?: unknown) => void
}

const HNSW_PERSIST_FILENAME = "agent-memory-hnsw.json"

function asPositiveInt(value: number | undefined, fallback: number) {
  if (!Number.isFinite(value)) return fallback
  if ((value ?? 0) <= 0) return fallback
  return Math.max(1, Math.floor(value ?? fallback))
}

function validVector(vector: unknown, dimensions: number): vector is EmbeddingVector {
  if (!Array.isArray(vector)) return false
  if (vector.length !== dimensions) return false
  return vector.every((value) => typeof value === "number" && Number.isFinite(value))
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

function normalizeSemanticScore(value: number) {
  if (!Number.isFinite(value)) return 0
  if (value >= -1 && value <= 1) return (value + 1) / 2
  if (value < 0) return 0
  if (value > 1) return 1
  return value
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

function asArray<T>(value: T | T[] | undefined) {
  if (!value) return [] as T[]
  return Array.isArray(value) ? value : [value]
}

function includeBySearchOptions(record: AgentMemoryRecord, options: AgentMemorySearchOptions = {}) {
  const includeInactive = options.includeInactive ?? false
  if (!includeInactive && record.status !== "active") return false
  if (options.scope && record.scope !== options.scope) return false
  const kinds = asArray(options.kind)
  if (kinds.length > 0 && !kinds.includes(record.kind)) return false
  const statuses = asArray(options.status)
  if (statuses.length > 0 && !statuses.includes(record.status)) return false
  if (options.agent && record.agent !== options.agent) return false
  if (options.run_id && record.run_id !== options.run_id) return false
  if (options.task_id && record.task_id !== options.task_id) return false
  if (options.tags?.length) {
    const loweredTags = record.tags.map((item) => item.toLowerCase())
    const loweredText = record.text.toLowerCase()
    const tagMatched = options.tags.some((tag) => loweredTags.includes(tag.toLowerCase()) || loweredText.includes(tag.toLowerCase()))
    if (!tagMatched) return false
  }
  const minGlobal = options.minConfidenceGlobal ?? 0.8
  const minProject = options.minConfidenceProject ?? 0
  if (record.scope === "global" && record.confidence < minGlobal) return false
  if (record.scope === "project" && record.confidence < minProject) return false
  return true
}

function safeWarning(options: HnswAgentMemoryIndexOptions | undefined, message: string, error?: unknown) {
  if (typeof options?.onWarning === "function") {
    try {
      options.onWarning(message, error)
      return
    } catch {
      return
    }
  }
  if (error) {
    // eslint-disable-next-line no-console
    console.warn(`[agent-memory-hnsw] ${message}:`, error)
    return
  }
  // eslint-disable-next-line no-console
  console.warn(`[agent-memory-hnsw] ${message}`)
}

function compactError(error: unknown) {
  if (!error) return "unknown error"
  if (error instanceof Error && error.message.trim()) return error.message.trim()
  return String(error)
}

function resolvePersistencePath(options: HnswAgentMemoryIndexOptions) {
  const configured = options.persistencePath?.trim()
  if (configured) return configured
  if (!options.projectRoot?.trim()) return
  return path.join(options.projectRoot, ".codemate", HNSW_PERSIST_FILENAME)
}

function resolveHnswAvailability(input?: { adapter?: HnswVectorAdapter; enabled?: boolean }) {
  if (input?.enabled === false) {
    return { available: false, reason: "hnsw explicitly disabled" } satisfies HnswAvailability
  }
  if (input?.adapter) {
    return { available: true } satisfies HnswAvailability
  }
  try {
    // Probe constructor availability in runtime.
    new HNSW(16, 100, 8, "cosine")
    return { available: true } satisfies HnswAvailability
  } catch (error) {
    return { available: false, reason: `hnsw package unavailable: ${compactError(error)}` } satisfies HnswAvailability
  }
}

export function detectHnswAvailability(input?: { adapter?: HnswVectorAdapter; enabled?: boolean }) {
  return resolveHnswAvailability(input)
}

export class HnswAgentMemoryIndex implements AgentMemoryIndex {
  private readonly base: AgentMemoryIndex
  private readonly embeddingProvider: EmbeddingProvider
  private readonly options: HnswAgentMemoryIndexOptions
  private readonly fallback: HybridAgentMemoryIndex
  private readonly adapter?: HnswVectorAdapter
  readonly availability: HnswAvailability

  private readonly persistencePath?: string
  private engine?: HNSW
  private nextLabel = 1
  private readonly idToLabel = new Map<string, number>()
  private readonly labelToId = new Map<number, string>()
  private readonly tombstones = new Set<number>()
  private readonly indexedUpdatedAt = new Map<string, string>()
  private initPromise?: Promise<void>

  constructor(base: AgentMemoryIndex, embeddingProvider: EmbeddingProvider, options: HnswAgentMemoryIndexOptions = {}) {
    this.base = base
    this.embeddingProvider = embeddingProvider
    this.options = options
    this.fallback = new HybridAgentMemoryIndex(base, embeddingProvider, options)
    this.adapter = options.adapter
    this.availability = resolveHnswAvailability({ adapter: options.adapter, enabled: options.hnswEnabled })
    this.persistencePath = resolvePersistencePath(options)
  }

  private targetLimit(limit: number | undefined) {
    const desired = asPositiveInt(limit, 10)
    const explicit = asPositiveInt(this.options.candidateLimit, 0)
    if (explicit > 0) return Math.max(desired, explicit)
    const multiplier = asPositiveInt(this.options.candidateMultiplier, 4)
    return Math.max(desired, desired * multiplier)
  }

  private async embeddedVector(record: AgentMemoryRecord) {
    if (validVector(record.embedding?.vector, this.embeddingProvider.dimensions)) return record.embedding.vector
    return this.embeddingProvider
      .embedText(embeddingText(record))
      .then((vector) => (validVector(vector, this.embeddingProvider.dimensions) ? vector : undefined))
      .catch(() => undefined)
  }

  private createEngine() {
    return new HNSW(16, 200, this.embeddingProvider.dimensions, "cosine", 120)
  }

  private async ensureInitialized() {
    if (!this.availability.available || this.adapter) return
    if (this.initPromise) {
      await this.initPromise
      return
    }
    this.initPromise = this.initializeInternal()
    await this.initPromise
  }

  private async initializeInternal() {
    this.engine = this.createEngine()
    const loaded = await this.tryLoadPersistedState()
    if (!loaded) {
      await this.rebuildFromBase("initialization")
      return
    }
    const baseRecords = await this.base.list({ includeInactive: true })
    const stale = baseRecords.some((record) => this.indexedUpdatedAt.get(record.id) !== record.updated_at)
    const missing = baseRecords.some((record) => !this.idToLabel.has(record.id))
    const extra = [...this.idToLabel.keys()].some((id) => !baseRecords.some((record) => record.id === id))
    if (stale || missing || extra) {
      safeWarning(this.options, "persisted HNSW snapshot stale; rebuilding from base store")
      await this.rebuildFromBase("snapshot stale")
    }
  }

  private toPersistedState(): PersistedHnswState | undefined {
    if (!this.engine) return
    return {
      version: 1,
      provider: this.embeddingProvider.providerName,
      dimensions: this.embeddingProvider.dimensions,
      nextLabel: this.nextLabel,
      idToLabel: [...this.idToLabel.entries()],
      tombstones: [...this.tombstones.values()],
      indexedUpdatedAt: [...this.indexedUpdatedAt.entries()],
      index: this.engine.toJSON(),
    }
  }

  private async persistState() {
    if (!this.persistencePath) return
    const state = this.toPersistedState()
    if (!state) return
    try {
      await mkdir(path.dirname(this.persistencePath), { recursive: true })
      await writeFile(this.persistencePath, `${JSON.stringify(state)}\n`, "utf8")
    } catch (error) {
      safeWarning(this.options, "failed to persist HNSW snapshot", error)
    }
  }

  private clearState() {
    this.engine = this.createEngine()
    this.nextLabel = 1
    this.idToLabel.clear()
    this.labelToId.clear()
    this.tombstones.clear()
    this.indexedUpdatedAt.clear()
  }

  private async tryLoadPersistedState() {
    if (!this.persistencePath || !this.engine) return false
    let raw = ""
    try {
      raw = await readFile(this.persistencePath, "utf8")
    } catch {
      return false
    }
    if (!raw.trim()) return false
    let parsed: PersistedHnswState | undefined
    try {
      parsed = JSON.parse(raw) as PersistedHnswState
    } catch (error) {
      safeWarning(this.options, "invalid persisted HNSW snapshot JSON; rebuilding", error)
      return false
    }
    if (!parsed || parsed.version !== 1) return false
    if (parsed.dimensions !== this.embeddingProvider.dimensions) {
      safeWarning(
        this.options,
        `persisted HNSW dimensions mismatch (${parsed.dimensions} != ${this.embeddingProvider.dimensions}); rebuilding`,
      )
      return false
    }
    try {
      this.engine = HNSW.fromJSON(parsed.index)
      this.nextLabel = asPositiveInt(parsed.nextLabel, 1)
      this.idToLabel.clear()
      this.labelToId.clear()
      this.tombstones.clear()
      this.indexedUpdatedAt.clear()
      for (const [id, label] of parsed.idToLabel ?? []) {
        if (!id || !Number.isFinite(label)) continue
        this.idToLabel.set(id, label)
        this.labelToId.set(label, id)
      }
      for (const label of parsed.tombstones ?? []) {
        if (!Number.isFinite(label)) continue
        this.tombstones.add(label)
      }
      for (const [id, updatedAt] of parsed.indexedUpdatedAt ?? []) {
        if (!id || typeof updatedAt !== "string") continue
        this.indexedUpdatedAt.set(id, updatedAt)
      }
      return true
    } catch (error) {
      safeWarning(this.options, "failed to restore persisted HNSW snapshot; rebuilding", error)
      return false
    }
  }

  private async rebuildFromBase(reason: string) {
    if (!this.availability.available || this.adapter) return
    this.clearState()
    const records = await this.base.list({ includeInactive: true })
    const points: Array<{ id: number; vector: EmbeddingVector }> = []
    for (const record of records) {
      const vector = await this.embeddedVector(record)
      if (!vector) continue
      const label = this.nextLabel
      this.nextLabel += 1
      this.idToLabel.set(record.id, label)
      this.labelToId.set(label, record.id)
      this.indexedUpdatedAt.set(record.id, record.updated_at)
      points.push({ id: label, vector })
    }
    try {
      if (!this.engine) this.engine = this.createEngine()
      if (points.length > 0) {
        await this.engine.buildIndex(points)
      }
      await this.persistState()
    } catch (error) {
      safeWarning(this.options, `HNSW rebuild failed (${reason}); semantic path disabled`, error)
      this.availability.available = false
      this.availability.reason = `hnsw rebuild failed: ${compactError(error)}`
    }
  }

  private async semanticCandidates(queryVector: EmbeddingVector, limit: number) {
    if (!this.availability.available) return [] as HnswVectorCandidate[]
    if (this.adapter) {
      return this.adapter.search({ vector: queryVector, limit }).catch(() => [] as HnswVectorCandidate[])
    }
    await this.ensureInitialized()
    if (!this.engine) return [] as HnswVectorCandidate[]
    const raw = this.engine.searchKNN(queryVector, limit, { efSearch: Math.max(limit, 80) })
    const byId = new Map<string, number>()
    for (const hit of raw) {
      const id = this.labelToId.get(hit.id)
      if (!id) continue
      if (this.tombstones.has(hit.id)) continue
      const score = normalizeSemanticScore(hit.score)
      const prev = byId.get(id)
      if (prev === undefined || score > prev) byId.set(id, score)
    }
    return [...byId.entries()].map(([id, score]) => ({ id, score }))
  }

  async upsert(record: AgentMemoryRecord) {
    if (!this.availability.available) return this.fallback.upsert(record)
    const persisted = await this.base.upsert(record)
    const vector = await this.embeddedVector(persisted)
    if (!vector) return persisted

    if (this.adapter) {
      try {
        await this.adapter.upsert({ id: persisted.id, vector })
      } catch {
        return this.fallback.upsert(persisted).catch(() => persisted)
      }
      return persisted
    }

    try {
      await this.ensureInitialized()
      if (!this.engine) return persisted
      const previous = this.idToLabel.get(persisted.id)
      if (previous !== undefined) this.tombstones.add(previous)
      const label = this.nextLabel
      this.nextLabel += 1
      await this.engine.addPoint(label, vector)
      this.idToLabel.set(persisted.id, label)
      this.labelToId.set(label, persisted.id)
      this.indexedUpdatedAt.set(persisted.id, persisted.updated_at)
      await this.persistState()
      return persisted
    } catch (error) {
      safeWarning(this.options, "HNSW upsert failed; rebuilding index and falling back for this attempt", error)
      await this.rebuildFromBase("upsert failure")
      return persisted
    }
  }

  async search(query: string, options: AgentMemorySearchOptions = {}) {
    if (!this.availability.available) return this.fallback.search(query, options)
    const limit = asPositiveInt(options.limit, 10)
    if (!query.trim()) return this.fallback.search(query, options)

    const keywordCandidates = await this.base.search(query, {
      ...options,
      limit: this.targetLimit(limit),
    })

    const queryVector = await this.embeddingProvider
      .embedText(query)
      .then((vector) => (validVector(vector, this.embeddingProvider.dimensions) ? vector : undefined))
      .catch(() => undefined)
    if (!queryVector) return keywordCandidates.slice(0, limit)

    const semanticCandidates = await this.semanticCandidates(queryVector, this.targetLimit(limit))
    if (semanticCandidates.length === 0) return keywordCandidates.slice(0, limit)

    const semanticScoreById = new Map(
      semanticCandidates
        .filter((item) => item.id?.trim())
        .map((item) => [item.id.trim(), normalizeSemanticScore(item.score)] as const),
    )
    const allRecords = await this.base.list({ includeInactive: true })
    const byId = new Map(allRecords.map((item) => [item.id, item] as const))
    const merged = [
      ...new Set([
        ...keywordCandidates.map((item) => item.id),
        ...semanticCandidates.map((item) => item.id).filter(Boolean),
      ]),
    ]
      .map((id) => byId.get(id))
      .filter((item): item is AgentMemoryRecord => !!item)
      .filter((item) => includeBySearchOptions(item, options))
    if (merged.length === 0) return []

    const keywordRankById = new Map(keywordCandidates.map((item, index) => [item.id, toRankScore(index, keywordCandidates.length)] as const))
    return merged
      .map((record) => ({
        record,
        score: hybridMemoryScore(keywordRankById.get(record.id) ?? 0, semanticScoreById.get(record.id) ?? 0, {
          keyword: this.options.keywordWeight,
          semantic: this.options.semanticWeight,
        }),
        semanticScore: semanticScoreById.get(record.id) ?? 0,
      }))
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
    const removed = await this.base.delete(id)
    if (!removed) return false
    if (!this.availability.available) return true

    if (this.adapter) {
      await this.adapter
        .delete(id)
        .then(() => true)
        .catch(() => true)
      return true
    }

    try {
      await this.ensureInitialized()
      const label = this.idToLabel.get(id)
      if (label !== undefined) {
        this.tombstones.add(label)
        this.idToLabel.delete(id)
        this.indexedUpdatedAt.delete(id)
      }
      await this.persistState()
    } catch (error) {
      safeWarning(this.options, "HNSW delete bookkeeping failed", error)
    }
    return true
  }

  async stats(): Promise<AgentMemoryStats> {
    return this.base.stats()
  }

  async list(options: AgentMemoryListOptions = {}): Promise<AgentMemoryRecord[]> {
    return this.base.list(options)
  }
}
