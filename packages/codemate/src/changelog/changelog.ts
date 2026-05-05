import { Database } from "@/storage/db"
import { InstanceState } from "@/effect/instance-state"
import { NamedError } from "@codemate-ai/core/util/error"
import { and, desc, eq } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import z from "zod"
import { ChangelogTable } from "./changelog.sql"
import { ChangelogID } from "./schema"

export const ChangelogError = NamedError.create(
  "ChangelogError",
  z.object({
    message: z.string(),
    code: z.enum(["not_found", "write_failed"]),
  }),
)

export type ChangelogError = InstanceType<typeof ChangelogError>

export interface ChangelogEntry {
  id: ChangelogID
  projectID: string
  sessionID: string
  messageID: string
  files: string[]
  summary: string
  timeCreated: number
  timeUpdated: number
}

export interface Interface {
  readonly append: (input: {
    files: string[]
    summary: string
    sessionID: string
    messageID: string
  }) => Effect.Effect<ChangelogEntry, ChangelogError>

  readonly list: (input?: { limit?: number; offset?: number }) => Effect.Effect<ChangelogEntry[], ChangelogError>

  readonly read: (input: { id: string }) => Effect.Effect<ChangelogEntry | undefined, ChangelogError>

  readonly delete: (input: { id: string }) => Effect.Effect<void, ChangelogError>
}

export class Service extends Context.Service<Service, Interface>()("@codemate/Changelog") {}

const db = <T>(fn: (d: Parameters<typeof Database.use>[0] extends (trx: infer D) => any ? D : never) => T) =>
  Effect.sync(() => Database.use(fn))

function toEntry(row: typeof ChangelogTable.$inferSelect): ChangelogEntry {
  return {
    id: row.id,
    projectID: row.project_id,
    sessionID: row.session_id,
    messageID: row.message_id,
    files: row.files ?? [],
    summary: row.summary,
    timeCreated: row.time_created,
    timeUpdated: row.time_updated,
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const append: Interface["append"] = Effect.fn("Changelog.append")(function* (input) {
      const ctx = yield* InstanceState.context
      const now = Date.now()
      const entry = {
        id: ChangelogID.descending(),
        project_id: ctx.project.id,
        session_id: input.sessionID,
        message_id: input.messageID,
        files: input.files,
        summary: input.summary,
        time_created: now,
        time_updated: now,
      } satisfies typeof ChangelogTable.$inferInsert

      yield* db((d) => d.insert(ChangelogTable).values(entry).run())

      return toEntry(entry)
    })

    const list: Interface["list"] = Effect.fn("Changelog.list")(function* (input) {
      const ctx = yield* InstanceState.context
      return yield* db((d) =>
        d
          .select()
          .from(ChangelogTable)
          .where(eq(ChangelogTable.project_id, ctx.project.id))
          .orderBy(desc(ChangelogTable.time_created))
          .limit(input?.limit ?? 50)
          .offset(input?.offset ?? 0)
          .all()
          .map(toEntry),
      )
    })

    const read: Interface["read"] = Effect.fn("Changelog.read")(function* (input) {
      const ctx = yield* InstanceState.context
      const row = yield* db((d) =>
        d
          .select()
          .from(ChangelogTable)
          .where(and(eq(ChangelogTable.project_id, ctx.project.id), eq(ChangelogTable.id, input.id as ChangelogID)))
          .get(),
      )
      return row ? toEntry(row) : undefined
    })

    const remove: Interface["delete"] = Effect.fn("Changelog.delete")(function* (input) {
      const ctx = yield* InstanceState.context
      yield* db((d) =>
        d
          .delete(ChangelogTable)
          .where(and(eq(ChangelogTable.project_id, ctx.project.id), eq(ChangelogTable.id, input.id as ChangelogID)))
          .run(),
      )
    })

    return Service.of({ append, list, read, delete: remove })
  }),
)

export const defaultLayer = layer

export * as Changelog from "./changelog"
