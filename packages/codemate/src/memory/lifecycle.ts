import { Database } from "@/storage/db"
import { MemoryTable, MemoryChunkTable, MemoryChunkVecTable } from "./memory.sql"
import { MemoryID } from "./schema"
import { InstanceState } from "@/effect/instance-state"
import { MemoryVitality, DECAY_THRESHOLD } from "./vitality"
import * as Log from "@codemate-ai/core/util/log"
import { eq, and, lt, sql } from "drizzle-orm"
import { Effect, Context, Layer } from "effect"

const log = Log.create({ service: "memory.lifecycle" })

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOW_VITALITY_STALE_DAYS = 14
const DEPRECATED_MAX_AGE_DAYS = 30

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const db = <T>(fn: (d: Parameters<typeof Database.use>[0] extends (trx: infer D) => any ? D : never) => T) =>
  Effect.sync(() => Database.use(fn))

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CleanupStats {
  deprecatedRemoved: number
  lowVitalityRemoved: number
  orphanedChunksRemoved: number
  staleEmbeddingsRemoved: number
  totalRemoved: number
}

export interface LifecycleStatus {
  totalMemories: number
  activeMemories: number
  deprecatedMemories: number
  averageVitality: number
  decayCandidates: number
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface Interface {
  readonly runDecay: (input?: { halfLifeDays?: number }) => Effect.Effect<{ updated: number }>
  readonly runConsolidation: (input?: { domain?: string }) => Effect.Effect<{ consolidated: number }>
  readonly runCleanup: () => Effect.Effect<CleanupStats>
  readonly runAll: () => Effect.Effect<{
    decay: { updated: number }
    consolidated: number
    cleanup: CleanupStats
  }>
  readonly getStatus: () => Effect.Effect<LifecycleStatus>
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class Service extends Context.Service<Service, Interface>()("@codemate/MemoryLifecycle") {}

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const vitality = yield* MemoryVitality.Service

    // ---- runDecay ----
    const runDecay: Interface["runDecay"] = Effect.fn("MemoryLifecycle.runDecay")(function* (input) {
      return yield* vitality.applyDecay(input)
    })

    // ---- runConsolidation ----
    const runConsolidation: Interface["runConsolidation"] = Effect.fn("MemoryLifecycle.runConsolidation")(function* (
      input,
    ) {
      const ctx = yield* InstanceState.context
      const projectId = ctx.project.id
      const domain = input?.domain

      // Find non-deprecated memories grouped by domain+path that have multiple versions
      const conditions = [
        eq(MemoryTable.project_id, projectId),
        eq(MemoryTable.deprecated, false),
      ]

      if (domain) {
        conditions.push(eq(MemoryTable.domain, domain))
      }

      const rows = yield* db((d) =>
        d
          .select({
            domain: MemoryTable.domain,
            path: MemoryTable.path,
          })
          .from(MemoryTable)
          .where(and(...conditions))
          .groupBy(MemoryTable.domain, MemoryTable.path)
          .having(sql`count(*) > 1`)
          .all(),
      )

      if (rows.length === 0) return { consolidated: 0 }

      let consolidated = 0

      for (const group of rows) {
        // Get all non-deprecated memories in this domain+path, ordered by vitality desc
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

        // Keep the most vital one, merge content from others
        const [keeper, ...rest] = memories
        if (!keeper) continue

        const mergedContent = [
          keeper.content,
          ...rest.map((m) => m.content),
        ]
          .filter(Boolean)
          .join("\n---\n")

        const mergedSummary = keeper.summary ?? rest.find((m) => m.summary)?.summary ?? null

        // Update the keeper with merged content
        const now = Date.now()
        yield* Effect.sync(() =>
          Database.transaction((tx) => {
            tx.update(MemoryTable)
              .set({
                content: mergedContent,
                summary: mergedSummary,
                time_updated: now,
              })
              .where(eq(MemoryTable.id, keeper.id as MemoryID))
              .run()

            // Deprecate the rest
            for (const m of rest) {
              tx.update(MemoryTable)
                .set({
                  deprecated: true,
                  migrated_to: keeper.id as MemoryID,
                  time_updated: now,
                })
                .where(eq(MemoryTable.id, m.id as MemoryID))
                .run()
            }
          }),
        )

        consolidated += rest.length
        log.info("consolidated", {
          domain: group.domain,
          path: group.path,
          merged: rest.length,
        })
      }

      return { consolidated }
    })

    // ---- runCleanup ----
    const runCleanup: Interface["runCleanup"] = Effect.fn("MemoryLifecycle.runCleanup")(function* () {
      const ctx = yield* InstanceState.context
      const projectId = ctx.project.id
      const now = Date.now()

      // 1. Remove deprecated memories older than 30 days
      const deprecatedThreshold = now - DEPRECATED_MAX_AGE_DAYS * 24 * 60 * 60 * 1000
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
      const staleThreshold = now - LOW_VITALITY_STALE_DAYS * 24 * 60 * 60 * 1000
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

      const stats: CleanupStats = {
        deprecatedRemoved: deprecatedRows.length,
        lowVitalityRemoved: lowVitalityRows.length,
        orphanedChunksRemoved: orphanedChunks.length,
        staleEmbeddingsRemoved: staleEmbeddings.length,
        totalRemoved: deprecatedRows.length + lowVitalityRows.length + orphanedChunks.length + staleEmbeddings.length,
      }

      log.info("cleanup complete", stats)
      return stats
    })

    // ---- runAll ----
    const runAll: Interface["runAll"] = Effect.fn("MemoryLifecycle.runAll")(function* () {
      const decay = yield* runDecay()
      const consolidated = yield* runConsolidation()
      const cleanup = yield* runCleanup()

      log.info("full lifecycle pass complete", {
        decayUpdated: decay.updated,
        consolidated: consolidated.consolidated,
        totalRemoved: cleanup.totalRemoved,
      })

      return { decay, consolidated: consolidated.consolidated, cleanup }
    })

    // ---- getStatus ----
    const getStatus: Interface["getStatus"] = Effect.fn("MemoryLifecycle.getStatus")(function* () {
      const ctx = yield* InstanceState.context
      const projectId = ctx.project.id

      const stats = yield* db((d) => {
        const total = d
          .select({ count: sql<number>`count(*)` })
          .from(MemoryTable)
          .where(eq(MemoryTable.project_id, projectId))
          .get()

        const active = d
          .select({ count: sql<number>`count(*)` })
          .from(MemoryTable)
          .where(
            and(
              eq(MemoryTable.project_id, projectId),
              eq(MemoryTable.deprecated, false),
            ),
          )
          .get()

        const deprecated = d
          .select({ count: sql<number>`count(*)` })
          .from(MemoryTable)
          .where(
            and(
              eq(MemoryTable.project_id, projectId),
              eq(MemoryTable.deprecated, true),
            ),
          )
          .get()

        const avgVitality = d
          .select({ avg: sql<number>`coalesce(avg(${MemoryTable.vitality}), 0)` })
          .from(MemoryTable)
          .where(
            and(
              eq(MemoryTable.project_id, projectId),
              eq(MemoryTable.deprecated, false),
            ),
          )
          .get()

        const decayCandidates = d
          .select({ count: sql<number>`count(*)` })
          .from(MemoryTable)
          .where(
            and(
              eq(MemoryTable.project_id, projectId),
              eq(MemoryTable.deprecated, false),
              lt(MemoryTable.vitality, DECAY_THRESHOLD),
            ),
          )
          .get()

        return { total, active, deprecated, avgVitality, decayCandidates }
      })

      return {
        totalMemories: stats.total?.count ?? 0,
        activeMemories: stats.active?.count ?? 0,
        deprecatedMemories: stats.deprecated?.count ?? 0,
        averageVitality: stats.avgVitality?.avg ?? 0,
        decayCandidates: stats.decayCandidates?.count ?? 0,
      }
    })

    return Service.of({ runDecay, runConsolidation, runCleanup, runAll, getStatus })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(MemoryVitality.defaultLayer))

export * as MemoryLifecycle from "./lifecycle"
