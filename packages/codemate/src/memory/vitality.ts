import { Database } from "@/storage/db"
import { MemoryTable } from "./memory.sql"
import { MemoryID } from "./schema"
import { InstanceState } from "@/effect/instance-state"
import * as Log from "@codemate-ai/core/util/log"
import { eq, and, lt, sql } from "drizzle-orm"
import { Effect, Context, Layer } from "effect"

const log = Log.create({ service: "memory.vitality" })

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_HALF_LIFE_DAYS = 30
export const DECAY_THRESHOLD = 0.35

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const db = <T>(fn: (d: Parameters<typeof Database.use>[0] extends (trx: infer D) => any ? D : never) => T) =>
  Effect.sync(() => Database.use(fn))

/**
 * Calculate decayed vitality for a memory.
 *
 * Uses exponential decay: vitality = initial_vitality * 2^(-age_days / half_life)
 * where age_days is time since last access (or creation if never accessed).
 */
export function getDecayedVitality(params: {
  vitality: number
  lastAccessed: number | null
  timeCreated: number
  halfLifeDays?: number
}): number {
  const halfLife = params.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS
  const referenceTime = params.lastAccessed ?? params.timeCreated
  const ageDays = (Date.now() - referenceTime) / (24 * 60 * 60 * 1000)

  // No decay for memories accessed today
  if (ageDays <= 0) return params.vitality

  return params.vitality * Math.pow(2, -ageDays / halfLife)
}

/**
 * Batch-apply vitality decay to all non-deprecated memories in the project.
 * Returns the count of updated memories.
 */
export function applyDecayBatch(params: {
  projectId: string
  halfLifeDays?: number
}): number {
  const halfLife = params.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS
  const now = Date.now()

  const rows = Database.use((d) =>
    d
      .select({
        id: MemoryTable.id,
        vitality: MemoryTable.vitality,
        last_accessed: MemoryTable.last_accessed,
        time_created: MemoryTable.time_created,
      })
      .from(MemoryTable)
      .where(
        and(
          eq(MemoryTable.project_id, params.projectId),
          eq(MemoryTable.deprecated, false),
        ),
      )
      .all(),
  )

  if (rows.length === 0) return 0

  let updated = 0
  Database.transaction((tx) => {
    for (const row of rows) {
      const decayed = getDecayedVitality({
        vitality: row.vitality,
        lastAccessed: row.last_accessed,
        timeCreated: row.time_created,
        halfLifeDays: halfLife,
      })

      // Only update if vitality changed meaningfully
      if (Math.abs(decayed - row.vitality) > 0.001) {
        tx.update(MemoryTable)
          .set({ vitality: decayed, time_updated: now })
          .where(eq(MemoryTable.id, row.id as MemoryID))
          .run()
        updated++
      }
    }
  })

  return updated
}

/**
 * Get count of memories below the decay threshold that are cleanup candidates.
 */
export function getDecayCandidates(projectId: string): number {
  const rows = Database.use((d) =>
    d
      .select({ id: MemoryTable.id })
      .from(MemoryTable)
      .where(
        and(
          eq(MemoryTable.project_id, projectId),
          eq(MemoryTable.deprecated, false),
          lt(MemoryTable.vitality, DECAY_THRESHOLD),
        ),
      )
      .all(),
  )

  return rows.length
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface Interface {
  readonly applyDecay: (input?: { halfLifeDays?: number }) => Effect.Effect<{ updated: number }>
  readonly getVitality: (input: {
    vitality: number
    lastAccessed: number | null
    timeCreated: number
  }) => Effect.Effect<number>
  readonly getCandidates: () => Effect.Effect<number>
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class Service extends Context.Service<Service, Interface>()("@codemate/MemoryVitality") {}

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const applyDecay: Interface["applyDecay"] = Effect.fn("MemoryVitality.applyDecay")(function* (input) {
      const ctx = yield* InstanceState.context
      const projectId = ctx.project.id
      const halfLifeDays = input?.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS

      const updated = applyDecayBatch({ projectId, halfLifeDays })
      log.info("decay applied", { updated, halfLifeDays })
      return { updated }
    })

    const getVitality: Interface["getVitality"] = Effect.fn("MemoryVitality.getVitality")(function* (input) {
      return getDecayedVitality({
        vitality: input.vitality,
        lastAccessed: input.lastAccessed,
        timeCreated: input.timeCreated,
      })
    })

    const getCandidates: Interface["getCandidates"] = Effect.fn("MemoryVitality.getCandidates")(function* () {
      const ctx = yield* InstanceState.context
      return getDecayCandidates(ctx.project.id)
    })

    return Service.of({ applyDecay, getVitality, getCandidates })
  }),
)

export const defaultLayer = layer

export * as MemoryVitality from "./vitality"
