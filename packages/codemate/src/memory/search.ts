import { Database } from "@/storage/db"
import { MemoryTable, MemoryChunkVecTable } from "./memory.sql"
import { MemoryID } from "./schema"
import { InstanceState } from "@/effect/instance-state"
import { eq, and } from "drizzle-orm"
import { Effect, Context, Layer } from "effect"
import type { MemoryInfo } from "./memory"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SearchMode = "keyword" | "semantic" | "hybrid"

export type SearchIntent = "factual" | "exploratory" | "temporal" | "default"

export interface SearchOptions {
  query: string
  domain?: string
  limit?: number
  mode?: SearchMode
  intent?: SearchIntent
  weights?: { keyword: number; semantic: number }
}

export interface SearchResult {
  memory: MemoryInfo
  score: number
  matchType: "keyword" | "semantic" | "hybrid"
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EMBEDDING_DIM = 128
const NGRAM_SIZE = 3
const HASH_PRIME = 31
const HASH_MOD = 1_000_003 // Large prime for hashing

const INTENT_WEIGHTS: Record<SearchIntent, { keyword: number; semantic: number }> = {
  factual: { keyword: 0.7, semantic: 0.3 },
  exploratory: { keyword: 0.3, semantic: 0.7 },
  temporal: { keyword: 0.6, semantic: 0.4 },
  default: { keyword: 0.4, semantic: 0.6 },
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const db = <T>(fn: (d: Parameters<typeof Database.use>[0] extends (trx: infer D) => any ? D : never) => T) =>
  Effect.sync(() => Database.use(fn))

function toInfo(row: typeof MemoryTable.$inferSelect): MemoryInfo {
  return {
    id: row.id as MemoryID,
    domain: row.domain,
    path: row.path,
    content: row.content,
    summary: row.summary,
    version: row.version,
    vitality: row.vitality,
    accessCount: row.access_count,
    tags: row.tags ?? [],
    timeCreated: row.time_created,
    timeUpdated: row.time_updated,
  }
}

// ---------------------------------------------------------------------------
// Embedding Generation (LSH-style n-gram hashing)
// ---------------------------------------------------------------------------

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function generateNGrams(text: string, size: number): string[] {
  const normalized = normalizeText(text)
  if (normalized.length < size) return [normalized]

  const grams: string[] = []
  for (let i = 0; i <= normalized.length - size; i++) {
    grams.push(normalized.slice(i, i + size))
  }
  return grams
}

function hashNGram(ngram: string): number {
  let hash = 0
  for (let i = 0; i < ngram.length; i++) {
    hash = (hash * HASH_PRIME + ngram.charCodeAt(i)) % HASH_MOD
  }
  return hash
}

function generateEmbedding(text: string): Float32Array {
  const embedding = new Float32Array(EMBEDDING_DIM)
  const ngrams = generateNGrams(text, NGRAM_SIZE)

  if (ngrams.length === 0) return embedding

  for (const ngram of ngrams) {
    const hash = hashNGram(ngram)
    const index = hash % EMBEDDING_DIM
    const sign = (hash & 1) === 0 ? 1 : -1
    embedding[index] += sign
  }

  // Normalize to unit vector
  let norm = 0
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    norm += embedding[i] * embedding[i]
  }
  norm = Math.sqrt(norm)

  if (norm > 0) {
    for (let i = 0; i < EMBEDDING_DIM; i++) {
      embedding[i] /= norm
    }
  }

  return embedding
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0

  let dotProduct = 0
  let normA = 0
  let normB = 0

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB)
  return denominator === 0 ? 0 : dotProduct / denominator
}

// ---------------------------------------------------------------------------
// Keyword Search
// ---------------------------------------------------------------------------

function computeKeywordScore(memory: MemoryInfo, query: string): number {
  const normalizedQuery = query.toLowerCase()
  const normalizedContent = memory.content.toLowerCase()
  const normalizedSummary = memory.summary?.toLowerCase() ?? ""
  const tags = memory.tags.map((t) => t.toLowerCase())

  let score = 0

  // Exact match in content (highest weight)
  if (normalizedContent.includes(normalizedQuery)) {
    score += 1.0
  }

  // Exact match in summary
  if (normalizedSummary.includes(normalizedQuery)) {
    score += 0.8
  }

  // Exact match in tags
  if (tags.some((t) => t.includes(normalizedQuery) || normalizedQuery.includes(t))) {
    score += 0.9
  }

  // Partial word matches
  const queryWords = normalizedQuery.split(/\s+/).filter((w) => w.length > 2)
  const contentWords = normalizedContent.split(/\s+/)
  const summaryWords = normalizedSummary.split(/\s+/)

  for (const qWord of queryWords) {
    if (contentWords.some((cWord) => cWord.includes(qWord) || qWord.includes(cWord))) {
      score += 0.3
    }
    if (summaryWords.some((sWord) => sWord.includes(qWord) || qWord.includes(sWord))) {
      score += 0.2
    }
  }

  // Apply vitality weight (boost popular/recent memories)
  score *= 0.7 + memory.vitality * 0.3

  // Apply recency weight (10% boost for memories updated in last 7 days)
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
  if (memory.timeUpdated > sevenDaysAgo) {
    score *= 1.1
  }

  return Math.min(score, 1.0)
}

// ---------------------------------------------------------------------------
// Semantic Search
// ---------------------------------------------------------------------------

function computeSemanticScore(queryEmbedding: Float32Array, memoryEmbedding: Float32Array): number {
  const similarity = cosineSimilarity(queryEmbedding, memoryEmbedding)
  // Map from [-1, 1] to [0, 1]
  return (similarity + 1) / 2
}

// ---------------------------------------------------------------------------
// Intent Classification
// ---------------------------------------------------------------------------

function classifyIntent(query: string): SearchIntent {
  const lowerQuery = query.toLowerCase()

  // Temporal indicators
  const temporalPatterns = [
    /\b(today|yesterday|last|recent|latest|newest|oldest|before|after|since|until)\b/,
    /\b\d{4}[-/]\d{2}[-/]\d{2}\b/,
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/,
  ]
  if (temporalPatterns.some((p) => p.test(lowerQuery))) {
    return "temporal"
  }

  // Factual indicators (specific questions, definitions)
  const factualPatterns = [
    /^(what|who|where|when|which|how many|how much)\b/,
    /\b(definition|meaning|explain|describe)\b/,
    /\b(is|are|was|were)\b.*\?$/,
  ]
  if (factualPatterns.some((p) => p.test(lowerQuery))) {
    return "factual"
  }

  // Exploratory indicators (broad topics, concepts)
  const exploratoryPatterns = [
    /\b(related|similar|like|about|regarding|concerning)\b/,
    /\b(pattern|approach|strategy|method|technique)\b/,
    /\b(compare|contrast|difference|similarity)\b/,
  ]
  if (exploratoryPatterns.some((p) => p.test(lowerQuery))) {
    return "exploratory"
  }

  return "default"
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface Interface {
  readonly search: (options: SearchOptions) => Effect.Effect<SearchResult[]>
  readonly generateAndStoreEmbedding: (memoryId: MemoryID, text: string) => Effect.Effect<void>
  readonly getEmbedding: (memoryId: MemoryID) => Effect.Effect<Float32Array | null>
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class Service extends Context.Service<Service, Interface>()("@codemate/MemorySearch") {}

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // ---- generateAndStoreEmbedding ----
    const generateAndStoreEmbedding: Interface["generateAndStoreEmbedding"] = Effect.fn(
      "MemorySearch.generateAndStoreEmbedding",
    )(function* (memoryId, text) {
      const embedding = generateEmbedding(text)
      const embeddingJson = JSON.stringify(Array.from(embedding))

      yield* db((d) =>
        d
          .insert(MemoryChunkVecTable)
          .values({
            memory_id: memoryId,
            embedding: embeddingJson,
          })
          .onConflictDoUpdate({
            target: MemoryChunkVecTable.memory_id,
            set: { embedding: embeddingJson },
          })
          .run(),
      )
    })

    // ---- getEmbedding ----
    const getEmbedding: Interface["getEmbedding"] = Effect.fn("MemorySearch.getEmbedding")(function* (memoryId) {
      const row = yield* db((d) =>
        d
          .select()
          .from(MemoryChunkVecTable)
          .where(eq(MemoryChunkVecTable.memory_id, memoryId))
          .get(),
      )

      if (!row) return null

      const embeddingArray = JSON.parse(row.embedding) as number[]
      return new Float32Array(embeddingArray)
    })

    // ---- search ----
    const search: Interface["search"] = Effect.fn("MemorySearch.search")(function* (options) {
      const ctx = yield* InstanceState.context
      const projectId = ctx.project.id
      const limit = options.limit ?? 20
      const mode = options.mode ?? "hybrid"
      const intent = options.intent ?? classifyIntent(options.query)
      const weights = options.weights ?? INTENT_WEIGHTS[intent]

      // Build base conditions
      const conditions = [eq(MemoryTable.project_id, projectId), eq(MemoryTable.deprecated, false)]

      if (options.domain) {
        conditions.push(eq(MemoryTable.domain, options.domain))
      }

      // Fetch candidate memories
      const rows = yield* db((d) =>
        d
          .select()
          .from(MemoryTable)
          .where(and(...conditions))
          .all(),
      )

      const memories = rows.map(toInfo)
      if (memories.length === 0) return []

      // Generate query embedding once
      const queryEmbedding = generateEmbedding(options.query)

      // Score each memory
      const scoredResults: SearchResult[] = []

      for (const memory of memories) {
        let score = 0
        let matchType: SearchResult["matchType"] = mode

        if (mode === "keyword" || mode === "hybrid") {
          const keywordScore = computeKeywordScore(memory, options.query)

          if (mode === "keyword") {
            score = keywordScore
          } else {
            // Hybrid: get semantic score too
            const memoryEmbedding = yield* getEmbedding(memory.id)
            const semanticScore = memoryEmbedding
              ? computeSemanticScore(queryEmbedding, memoryEmbedding)
              : 0

            score = keywordScore * weights.keyword + semanticScore * weights.semantic
            matchType = "hybrid"
          }
        } else if (mode === "semantic") {
          const memoryEmbedding = yield* getEmbedding(memory.id)
          const semanticScore = memoryEmbedding
            ? computeSemanticScore(queryEmbedding, memoryEmbedding)
            : 0

          score = semanticScore
          matchType = "semantic"
        }

        // Only include results with meaningful scores
        if (score > 0.01) {
          scoredResults.push({ memory, score, matchType })
        }
      }

      // Sort by score descending, then by vitality
      scoredResults.sort((a, b) => {
        const scoreDiff = b.score - a.score
        if (Math.abs(scoreDiff) > 0.001) return scoreDiff
        return b.memory.vitality - a.memory.vitality
      })

      return scoredResults.slice(0, limit)
    })

    return Service.of({ search, generateAndStoreEmbedding, getEmbedding })
  }),
)

export const defaultLayer = layer

export * as MemorySearch from "./search"
