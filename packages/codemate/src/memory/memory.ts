import { Database } from "@/storage/db"
import { MemoryTable, MemoryAliasTable, MemoryChunkTable, MemoryChunkVecTable } from "./memory.sql"
import { MemoryID } from "./schema"
import { InstanceState } from "@/effect/instance-state"
import { NamedError } from "@codemate-ai/core/util/error"
import * as Log from "@codemate-ai/core/util/log"
import { eq, and, like, lt, asc, sql } from "drizzle-orm"
import { Effect, Context, Layer } from "effect"
import z from "zod"
import { MemorySearch, type SearchMode, type SearchIntent } from "./search"

const log = Log.create({ service: "memory" })

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const MemoryError = NamedError.create(
  "MemoryError",
  z.object({
    message: z.string(),
    code: z.enum(["not_found", "already_exists", "invalid_uri", "write_guard"]),
  }),
)

export type MemoryError = InstanceType<typeof MemoryError>

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MemoryInfo {
  id: MemoryID
  domain: string
  path: string
  content: string
  summary: string | null
  version: number
  vitality: number
  accessCount: number
  tags: string[]
  timeCreated: number
  timeUpdated: number
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface Interface {
  readonly create: (input: {
    domain: string
    path: string
    content: string
    summary?: string
    tags?: string[]
    sourceSessionID?: string
  }) => Effect.Effect<MemoryInfo, MemoryError>

  readonly read: (input: {
    domain: string
    path: string
  }) => Effect.Effect<MemoryInfo | undefined, MemoryError>

  readonly update: (input: {
    domain: string
    path: string
    content: string
    summary?: string
    tags?: string[]
  }) => Effect.Effect<MemoryInfo, MemoryError>

  readonly delete: (input: {
    domain: string
    path: string
  }) => Effect.Effect<void, MemoryError>

  readonly search: (input: {
    query: string
    domain?: string
    limit?: number
    mode?: SearchMode
    intent?: SearchIntent
  }) => Effect.Effect<MemoryInfo[], MemoryError>

  readonly list: (input: {
    domain?: string
    prefix?: string
  }) => Effect.Effect<MemoryInfo[], MemoryError>

  readonly compact: (input?: {
    domain?: string
  }) => Effect.Effect<{ compacted: number; consolidated: number }, MemoryError>

  readonly cleanup: () => Effect.Effect<{
    deprecatedRemoved: number
    lowVitalityRemoved: number
    orphanedChunksRemoved: number
    staleEmbeddingsRemoved: number
    totalRemoved: number
  }, MemoryError>
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class Service extends Context.Service<Service, Interface>()("@codemate/Memory") {}

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

function parseURI(uri: string): { domain: string; path: string } {
  const separatorIndex = uri.indexOf("://")
  if (separatorIndex === -1) {
    throw new MemoryError({ message: `Invalid URI format: ${uri}`, code: "invalid_uri" })
  }
  const domain = uri.slice(0, separatorIndex)
  const path = uri.slice(separatorIndex + 3)
  if (!domain || !path) {
    throw new MemoryError({ message: `Invalid URI format: ${uri}`, code: "invalid_uri" })
  }
  return { domain, path }
}

function resolveTags(tags?: string[] | null): string[] {
  if (!tags) return []
  return tags.filter(Boolean)
}

const VITALITY_BOOST = 0.05

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const memorySearch = yield* MemorySearch.Service

    // ---- create ----
    const create: Interface["create"] = Effect.fn("Memory.create")(function* (input) {
      const ctx = yield* InstanceState.context
      const projectId = ctx.project.id
      const now = Date.now()

      // Write guard: if a non-deprecated memory exists at same domain+path, update it
      const existing = yield* db((d) =>
        d
          .select()
          .from(MemoryTable)
          .where(
            and(
              eq(MemoryTable.project_id, projectId),
              eq(MemoryTable.domain, input.domain),
              eq(MemoryTable.path, input.path),
              eq(MemoryTable.deprecated, false),
            ),
          )
          .get(),
      )

      if (existing) {
        // Delegate to update — create a new version
        return yield* update({
          domain: input.domain,
          path: input.path,
          content: input.content,
          summary: input.summary,
          tags: input.tags,
        })
      }

      const id = MemoryID.descending()
      const tags = resolveTags(input.tags)

      yield* Effect.sync(() =>
        Database.transaction((tx) => {
          tx.insert(MemoryTable)
            .values({
              id,
              project_id: projectId,
              domain: input.domain,
              path: input.path,
              content: input.content,
              summary: input.summary ?? null,
              version: 1,
              deprecated: false,
              vitality: 1.0,
              access_count: 0,
              last_accessed: null,
              tags,
              source_session_id: input.sourceSessionID ?? null,
              time_created: now,
              time_updated: now,
            })
            .run()
        }),
      )

      log.info("created", { id, domain: input.domain, path: input.path })

      return {
        id,
        domain: input.domain,
        path: input.path,
        content: input.content,
        summary: input.summary ?? null,
        version: 1,
        vitality: 1.0,
        accessCount: 0,
        tags,
        timeCreated: now,
        timeUpdated: now,
      }
    })

    // ---- read ----
    const read: Interface["read"] = Effect.fn("Memory.read")(function* (input) {
      const ctx = yield* InstanceState.context
      const projectId = ctx.project.id

      // Try alias resolution first
      const alias = yield* db((d) =>
        d
          .select()
          .from(MemoryAliasTable)
          .where(
            and(
              eq(MemoryAliasTable.project_id, projectId),
              eq(MemoryAliasTable.alias, `${input.domain}://${input.path}`),
            ),
          )
          .get(),
      )

      const domain = alias ? alias.target_domain : input.domain
      const memPath = alias ? alias.target_path : input.path

      const row = yield* db((d) =>
        d
          .select()
          .from(MemoryTable)
          .where(
            and(
              eq(MemoryTable.project_id, projectId),
              eq(MemoryTable.domain, domain),
              eq(MemoryTable.path, memPath),
              eq(MemoryTable.deprecated, false),
            ),
          )
          .get(),
      )

      if (!row) return undefined

      // Boost vitality on read
      const boostedVitality = Math.min(1.0, row.vitality + VITALITY_BOOST)
      const now = Date.now()

      yield* Effect.sync(() =>
        Database.transaction((tx) => {
          tx.update(MemoryTable)
            .set({
              access_count: row.access_count + 1,
              last_accessed: now,
              vitality: boostedVitality,
              time_updated: now,
            })
            .where(eq(MemoryTable.id, row.id as MemoryID))
            .run()
        }),
      )

      return {
        ...toInfo(row),
        vitality: boostedVitality,
        accessCount: row.access_count + 1,
        timeUpdated: now,
      }
    })

    // ---- update (version chain model) ----
    const update: Interface["update"] = Effect.fn("Memory.update")(function* (input) {
      const ctx = yield* InstanceState.context
      const projectId = ctx.project.id
      const now = Date.now()

      // Read existing non-deprecated memory
      const existing = yield* db((d) =>
        d
          .select()
          .from(MemoryTable)
          .where(
            and(
              eq(MemoryTable.project_id, projectId),
              eq(MemoryTable.domain, input.domain),
              eq(MemoryTable.path, input.path),
              eq(MemoryTable.deprecated, false),
            ),
          )
          .get(),
      )

      if (!existing) {
        throw new MemoryError({
          message: `Memory not found: ${input.domain}://${input.path}`,
          code: "not_found",
        })
      }

      const newId = MemoryID.descending()
      const newVersion = existing.version + 1
      const tags = resolveTags(input.tags ?? (existing.tags as string[] | null))

      yield* Effect.sync(() =>
        Database.transaction((tx) => {
          // Create new version
          tx.insert(MemoryTable)
            .values({
              id: newId,
              project_id: projectId,
              domain: input.domain,
              path: input.path,
              content: input.content,
              summary: input.summary ?? existing.summary,
              version: newVersion,
              deprecated: false,
              vitality: existing.vitality,
              access_count: existing.access_count,
              last_accessed: existing.last_accessed,
              tags,
              source_session_id: existing.source_session_id,
              time_created: existing.time_created,
              time_updated: now,
            })
            .run()

          // Mark old record as deprecated, point to new one
          tx.update(MemoryTable)
            .set({
              deprecated: true,
              migrated_to: newId,
              time_updated: now,
            })
            .where(eq(MemoryTable.id, existing.id as MemoryID))
            .run()
        }),
      )

      log.info("updated", { id: newId, domain: input.domain, path: input.path, version: newVersion })

      return {
        id: newId,
        domain: input.domain,
        path: input.path,
        content: input.content,
        summary: input.summary ?? existing.summary,
        version: newVersion,
        vitality: existing.vitality,
        accessCount: existing.access_count,
        tags,
        timeCreated: existing.time_created,
        timeUpdated: now,
      }
    })

    // ---- delete ----
    const del: Interface["delete"] = Effect.fn("Memory.delete")(function* (input) {
      const ctx = yield* InstanceState.context
      const projectId = ctx.project.id
      const now = Date.now()

      const row = yield* db((d) =>
        d
          .select()
          .from(MemoryTable)
          .where(
            and(
              eq(MemoryTable.project_id, projectId),
              eq(MemoryTable.domain, input.domain),
              eq(MemoryTable.path, input.path),
              eq(MemoryTable.deprecated, false),
            ),
          )
          .get(),
      )

      if (!row) {
        throw new MemoryError({
          message: `Memory not found: ${input.domain}://${input.path}`,
          code: "not_found",
        })
      }

      yield* Effect.sync(() =>
        Database.transaction((tx) => {
          // Deprecate — the cleanup job physically removes old entries
          tx.update(MemoryTable)
            .set({ deprecated: true, time_updated: now })
            .where(eq(MemoryTable.id, row.id as MemoryID))
            .run()
        }),
      )

      log.info("deleted", { domain: input.domain, path: input.path })
    })

    // ---- search (delegates to MemorySearch) ----
    const search: Interface["search"] = Effect.fn("Memory.search")(function* (input) {
      const results = yield* memorySearch.search({
        query: input.query,
        domain: input.domain,
        limit: input.limit ?? 20,
        mode: input.mode ?? "hybrid",
        intent: input.intent,
      })

      return results.map((r) => r.memory)
    })

    // ---- list ----
    const list: Interface["list"] = Effect.fn("Memory.list")(function* (input) {
      const ctx = yield* InstanceState.context
      const projectId = ctx.project.id

      const conditions = [eq(MemoryTable.project_id, projectId), eq(MemoryTable.deprecated, false)]

      if (input.domain) {
        conditions.push(eq(MemoryTable.domain, input.domain))
      }

      if (input.prefix) {
        conditions.push(like(MemoryTable.path, `${input.prefix}%`))
      }

      const rows = yield* db((d) =>
        d
          .select()
          .from(MemoryTable)
          .where(and(...conditions))
          .orderBy(asc(MemoryTable.domain), asc(MemoryTable.path))
          .all(),
      )

      return rows.map(toInfo)
    })

    // ---- compact (reclaim old deprecated versions + consolidate fragments) ----
    const compact: Interface["compact"] = Effect.fn("Memory.compact")(function* (input) {
      const ctx = yield* InstanceState.context
      const projectId = ctx.project.id

      // Phase 1: Consolidate fragmented memories in same domain+path
      const consolidateConditions = [
        eq(MemoryTable.project_id, projectId),
        eq(MemoryTable.deprecated, false),
      ]

      if (input?.domain) {
        consolidateConditions.push(eq(MemoryTable.domain, input.domain))
      }

      const fragmentGroups = yield* db((d) =>
        d
          .select({
            domain: MemoryTable.domain,
            path: MemoryTable.path,
          })
          .from(MemoryTable)
          .where(and(...consolidateConditions))
          .groupBy(MemoryTable.domain, MemoryTable.path)
          .having(sql`count(*) > 1`)
          .all(),
      )

      let consolidated = 0
      const now = Date.now()

      for (const group of fragmentGroups) {
        const memories = yield* db((d) =>
          d
            .select()
            .from(MemoryTable)
            .where(
              and(
                eq(MemoryTable.project_id, projectId),
                eq(MemoryTable.domain, group.domain),
                eq(MemoryTable.path, group.path),
                eq(MemoryTable.deprecated, false),
              ),
            )
            .orderBy(sql`${MemoryTable.vitality} DESC`)
            .all(),
        )

        if (memories.length <= 1) continue

        const [keeper, ...rest] = memories
        if (!keeper) continue

        const mergedContent = [keeper.content, ...rest.map((m) => m.content)].filter(Boolean).join("\n---\n")
        const mergedSummary = keeper.summary ?? rest.find((m) => m.summary)?.summary ?? null

        yield* Effect.sync(() =>
          Database.transaction((tx) => {
            tx.update(MemoryTable)
              .set({ content: mergedContent, summary: mergedSummary, time_updated: now })
              .where(eq(MemoryTable.id, keeper.id as MemoryID))
              .run()

            for (const m of rest) {
              tx.update(MemoryTable)
                .set({ deprecated: true, migrated_to: keeper.id as MemoryID, time_updated: now })
                .where(eq(MemoryTable.id, m.id as MemoryID))
                .run()
            }
          }),
        )

        consolidated += rest.length
      }

      // Phase 2: Remove deprecated entries that have been migrated
      const compactConditions = [
        eq(MemoryTable.project_id, projectId),
        eq(MemoryTable.deprecated, true),
        sql`${MemoryTable.migrated_to} IS NOT NULL`,
      ]

      if (input?.domain) {
        compactConditions.push(eq(MemoryTable.domain, input.domain))
      }

      const rows = yield* db((d) =>
        d
          .select({ id: MemoryTable.id })
          .from(MemoryTable)
          .where(and(...compactConditions))
          .all(),
      )

      if (rows.length > 0) {
        yield* Effect.sync(() =>
          Database.transaction((tx) => {
            for (const row of rows) {
              tx.delete(MemoryTable)
                .where(eq(MemoryTable.id, row.id as MemoryID))
                .run()
            }
          }),
        )
      }

      log.info("compacted", { compacted: rows.length, consolidated })
      return { compacted: rows.length, consolidated }
    })

    // ---- cleanup (remove deprecated, low-vitality stale, orphaned chunks/embeddings) ----
    const cleanup: Interface["cleanup"] = Effect.fn("Memory.cleanup")(function* () {
      const ctx = yield* InstanceState.context
      const projectId = ctx.project.id
      const now = Date.now()

      // 1. Remove deprecated memories older than 30 days
      const deprecatedThreshold = now - 30 * 24 * 60 * 60 * 1000
      const deprecatedRows = yield* db((d) =>
        d
          .select({ id: MemoryTable.id })
          .from(MemoryTable)
          .where(
            and(
              eq(MemoryTable.project_id, projectId),
              eq(MemoryTable.deprecated, true),
              sql`${MemoryTable.time_updated} < ${deprecatedThreshold}`,
            ),
          )
          .all(),
      )

      if (deprecatedRows.length > 0) {
        yield* Effect.sync(() =>
          Database.transaction((tx) => {
            for (const row of deprecatedRows) {
              tx.delete(MemoryTable)
                .where(eq(MemoryTable.id, row.id as MemoryID))
                .run()
            }
          }),
        )
      }

      // 2. Remove low-vitality memories not accessed in 14+ days
      const staleThreshold = now - 14 * 24 * 60 * 60 * 1000
      const DECAY_THRESHOLD = 0.35
      const lowVitalityRows = yield* db((d) =>
        d
          .select({ id: MemoryTable.id })
          .from(MemoryTable)
          .where(
            and(
              eq(MemoryTable.project_id, projectId),
              eq(MemoryTable.deprecated, false),
              lt(MemoryTable.vitality, DECAY_THRESHOLD),
              sql`(${MemoryTable.last_accessed} IS NULL AND ${MemoryTable.time_updated} < ${staleThreshold})`,
            ),
          )
          .all(),
      )

      if (lowVitalityRows.length > 0) {
        yield* Effect.sync(() =>
          Database.transaction((tx) => {
            for (const row of lowVitalityRows) {
              tx.delete(MemoryTable)
                .where(eq(MemoryTable.id, row.id as MemoryID))
                .run()
            }
          }),
        )
      }

      // 3. Remove orphaned chunks (chunks whose parent memory no longer exists)
      const orphanedChunks = yield* db((d) =>
        d
          .select({ id: MemoryChunkTable.id })
          .from(MemoryChunkTable)
          .leftJoin(MemoryTable, eq(MemoryChunkTable.memory_id, MemoryTable.id))
          .where(sql`${MemoryTable.id} IS NULL`)
          .all(),
      )

      if (orphanedChunks.length > 0) {
        yield* Effect.sync(() =>
          Database.transaction((tx) => {
            for (const chunk of orphanedChunks) {
              tx.delete(MemoryChunkTable)
                .where(eq(MemoryChunkTable.id, chunk.id))
                .run()
            }
          }),
        )
      }

      // 4. Remove stale embeddings (embeddings whose parent memory no longer exists)
      const staleEmbeddings = yield* db((d) =>
        d
          .select({ memory_id: MemoryChunkVecTable.memory_id })
          .from(MemoryChunkVecTable)
          .leftJoin(MemoryTable, eq(MemoryChunkVecTable.memory_id, MemoryTable.id))
          .where(sql`${MemoryTable.id} IS NULL`)
          .all(),
      )

      if (staleEmbeddings.length > 0) {
        yield* Effect.sync(() =>
          Database.transaction((tx) => {
            for (const emb of staleEmbeddings) {
              tx.delete(MemoryChunkVecTable)
                .where(eq(MemoryChunkVecTable.memory_id, emb.memory_id as MemoryID))
                .run()
            }
          }),
        )
      }

      const stats = {
        deprecatedRemoved: deprecatedRows.length,
        lowVitalityRemoved: lowVitalityRows.length,
        orphanedChunksRemoved: orphanedChunks.length,
        staleEmbeddingsRemoved: staleEmbeddings.length,
        totalRemoved: deprecatedRows.length + lowVitalityRows.length + orphanedChunks.length + staleEmbeddings.length,
      }

      log.info("cleanup", stats)
      return stats
    })

    return Service.of({
      create,
      read,
      update,
      delete: del,
      search,
      list,
      compact,
      cleanup,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(MemorySearch.defaultLayer))

export * as Memory from "./memory"
