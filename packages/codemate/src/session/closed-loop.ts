import path from "path"
import { Session } from "@/session/session"
import { ProjectTable } from "@/project/project.sql"
import { SessionID, MessageID } from "@/session/schema"
import type { MessageV2 } from "@/session/message-v2"
import { Storage } from "@/storage/storage"
import { Database } from "@/storage/db"
import { InstanceState } from "@/effect/instance-state"
import { AppFileSystem } from "@codemate-ai/core/filesystem"
import { Global } from "@codemate-ai/core/global"
import { Config } from "@/config/config"
import { Process } from "@/util/process"
import { errorMessage } from "@/util/error"
import { eq } from "drizzle-orm"
import { ulid } from "ulid"
import { Context, Effect, Layer, Schema, Types } from "effect"
import { NonNegativeInt, withStatics } from "@codemate-ai/core/schema"
import { zod } from "@codemate-ai/core/effect-zod"

const DRIFT_INTERVAL = 5

export const SessionIntentAnchor = Schema.Struct({
  text: Schema.String,
  source_message_id: MessageID,
  created_at: NonNegativeInt,
})
  .annotate({ identifier: "SessionIntentAnchor" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type SessionIntentAnchor = Types.DeepMutable<Schema.Schema.Type<typeof SessionIntentAnchor>>

export const TaskNode = Schema.Struct({
  id: Schema.String,
  task_role: Schema.Literals(["planner", "coder", "tester", "research", "reviewer", "writer"]),
  agent: Schema.String,
  description: Schema.String,
  blockedBy: Schema.mutable(Schema.Array(Schema.String)),
  needsResearch: Schema.optional(Schema.Boolean),
  tags: Schema.mutable(Schema.Array(Schema.String)),
})
  .annotate({ identifier: "TaskNode" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type TaskNode = Types.DeepMutable<Schema.Schema.Type<typeof TaskNode>>

export const TaskGraph = Schema.Struct({
  nodes: Schema.mutable(Schema.Array(TaskNode)),
})
  .annotate({ identifier: "TaskGraph" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type TaskGraph = Types.DeepMutable<Schema.Schema.Type<typeof TaskGraph>>

export const DriftCheckResult = Schema.Struct({
  is_drift: Schema.Boolean,
  reason: Schema.String,
  evidence: Schema.mutable(Schema.Array(Schema.String)),
  confidence: Schema.Number,
})
  .annotate({ identifier: "DriftCheckResult" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type DriftCheckResult = Types.DeepMutable<Schema.Schema.Type<typeof DriftCheckResult>>

const LessonScope = Schema.Literals(["project", "global", "both"])

export const ResearchLessonRecord = Schema.Struct({
  id: Schema.String,
  scope: LessonScope,
  tags: Schema.mutable(Schema.Array(Schema.String)),
  stack: Schema.mutable(Schema.Array(Schema.String)),
  fingerprint: Schema.String,
  lesson: Schema.String,
  detail: Schema.String,
  fix: Schema.String,
  created_at: NonNegativeInt,
  project_id: Schema.optional(Schema.String),
})
  .annotate({ identifier: "ResearchLessonRecord" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ResearchLessonRecord = Types.DeepMutable<Schema.Schema.Type<typeof ResearchLessonRecord>>

export const ReusableLessonRecord = Schema.Struct({
  scope: Schema.Literals(["project", "global"]),
  tags: Schema.mutable(Schema.Array(Schema.String)),
  stack: Schema.mutable(Schema.Array(Schema.String)),
  fingerprint: Schema.String,
  lesson: Schema.String,
  detail: Schema.String,
  fix: Schema.String,
  created_at: NonNegativeInt,
})
  .annotate({ identifier: "ReusableLessonRecord" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ReusableLessonRecord = Types.DeepMutable<Schema.Schema.Type<typeof ReusableLessonRecord>>

const SelfCheckCommandResult = Schema.Struct({
  command: Schema.String,
  exit_code: Schema.Number,
  output: Schema.String,
})

export const SelfCheckReport = Schema.Struct({
  success: Schema.Boolean,
  inferred: Schema.Boolean,
  max_rounds: NonNegativeInt,
  results: Schema.mutable(Schema.Array(SelfCheckCommandResult)),
})
  .annotate({ identifier: "SelfCheckReport" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type SelfCheckReport = Types.DeepMutable<Schema.Schema.Type<typeof SelfCheckReport>>

export const SessionLessonStats = Schema.Struct({
  learned: NonNegativeInt,
  total: NonNegativeInt,
})
  .annotate({ identifier: "SessionLessonStats" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type SessionLessonStats = Types.DeepMutable<Schema.Schema.Type<typeof SessionLessonStats>>

const SupermemoryScope = Schema.Literals(["user", "project"])

const SupermemoryRecord = Schema.Struct({
  id: Schema.String,
  content: Schema.String,
  scope: SupermemoryScope,
  tags: Schema.mutable(Schema.Array(Schema.String)),
  created_at: NonNegativeInt,
  user: Schema.optional(Schema.String),
  project_id: Schema.optional(Schema.String),
})

type SupermemoryRecord = Types.DeepMutable<Schema.Schema.Type<typeof SupermemoryRecord>>

type WorkflowState = {
  intent_anchor?: SessionIntentAnchor
  intent_anchor_refresh_requested?: boolean
  lessons_written?: number
  drift?: {
    last_checked_completed_subtasks: number
  }
  completed_subtasks?: string[]
  selfcheck?: {
    rounds: number
  }
}

function compressIntentAnchor(input: string) {
  const normalized = input.replace(/\s+/g, " ").trim()
  if (!normalized) return ""
  const sentence = normalized
    .split(/(?<=[。！？.!?])\s+/)
    .map((x) => x.trim())
    .find((x) => x.length > 0)
  const text = sentence ?? normalized
  if (text.length <= 180) return text
  return text.slice(0, 180).trim()
}

function fingerprintOf(input: { topic: string; stack?: string[]; tags?: string[] }) {
  const text = `${input.topic} ${(input.stack ?? []).join(" ")} ${(input.tags ?? []).join(" ")}`
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff\s]+/g, " ")
  const tokens = [...new Set(text.split(/\s+/).filter((x) => x.length > 1))].slice(0, 12)
  return tokens.join("|")
}

function parseJsonl<T = unknown>(text: string): T[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as T]
      } catch {
        return []
      }
    })
}

function tokenize(text: string) {
  return text
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/g)
    .map((x) => x.trim())
    .filter((x) => x.length > 1)
}

function taskKey(task: MessageV2.SubtaskPart) {
  if (typeof task.task_id === "string" && task.task_id.trim()) return task.task_id.trim()
  if (typeof task.id === "string") return task.id
  return `${task.task_role}:${task.agent}:${task.description}:${task.prompt}`
}

export interface Interface {
  readonly resolveIntentAnchor: (input: {
    sessionID: SessionID
    messages: MessageV2.WithParts[]
  }) => Effect.Effect<SessionIntentAnchor | undefined>
  readonly intentReminder: (anchor: SessionIntentAnchor) => string
  readonly requestIntentAnchorRefresh: (sessionID: SessionID) => Effect.Effect<void>
  readonly recordLessonWrite: (input: { sessionID: SessionID; count: number }) => Effect.Effect<void>
  readonly lessonStats: (sessionID: SessionID) => Effect.Effect<SessionLessonStats>
  readonly driftCheckpoint: (input: { sessionID: SessionID; completedSubtasks: number }) => Effect.Effect<number | undefined>
  readonly markDriftChecked: (input: { sessionID: SessionID; completedSubtasks: number }) => Effect.Effect<void>
  readonly listCompletedSubtasks: (sessionID: SessionID) => Effect.Effect<string[]>
  readonly markSubtaskCompleted: (input: { sessionID: SessionID; taskKey: string }) => Effect.Effect<void>
  readonly taskKey: (task: MessageV2.SubtaskPart) => string
  readonly taskLayers: (input: {
    pending: MessageV2.SubtaskPart[]
    completed: string[]
  }) => { layers: MessageV2.SubtaskPart[][]; unresolved: MessageV2.SubtaskPart[] }
  readonly appendProjectLesson: (input: { sessionID: SessionID; record: Record<string, unknown> }) => Effect.Effect<void>
  readonly appendGlobalLesson: (record: Record<string, unknown>) => Effect.Effect<void>
  readonly appendChangelog: (input: { sessionID: SessionID; title: string; body: string }) => Effect.Effect<void>
  readonly readRecentChangelog: (input: { sessionID: SessionID; limit?: number; maxChars?: number }) => Effect.Effect<string | undefined>
  readonly searchReusableLessons: (input: { sessionID: SessionID; query: string; topK?: number }) => Effect.Effect<ReusableLessonRecord[]>
  readonly findResearchLesson: (input: {
    topic: string
    stack?: string[]
    tags?: string[]
    refresh?: boolean
  }) => Effect.Effect<ResearchLessonRecord | undefined>
  readonly saveResearchLesson: (input: {
    topic: string
    lesson: string
    detail: string
    fix: string
    stack?: string[]
    tags?: string[]
  }) => Effect.Effect<ResearchLessonRecord>
  readonly fingerprint: (input: { topic: string; stack?: string[]; tags?: string[] }) => string
  readonly inferSelfCheck: (input?: { cwd?: string }) => Effect.Effect<{ cwd: string; commands: string[] }>
  readonly runSelfCheck: (input: { cwd: string; commands?: string[]; maxRounds?: number }) => Effect.Effect<SelfCheckReport>
  readonly selfCheckRounds: (sessionID: SessionID) => Effect.Effect<number>
  readonly bumpSelfCheckRounds: (input: { sessionID: SessionID; reset?: boolean }) => Effect.Effect<number>
  readonly supermemoryAdd: (input: {
    content: string
    scope: "user" | "project"
    tags?: string[]
  }) => Effect.Effect<SupermemoryRecord>
  readonly supermemorySearch: (input: {
    query: string
    scope?: "user" | "project"
    topK?: number
  }) => Effect.Effect<SupermemoryRecord[]>
  readonly supermemoryList: (input?: { scope?: "user" | "project" }) => Effect.Effect<SupermemoryRecord[]>
  readonly supermemoryForget: (input: { id?: string; query?: string }) => Effect.Effect<number>
  readonly supermemoryProfile: () => Effect.Effect<Record<string, unknown>>
}

export class Service extends Context.Service<Service, Interface>()("@codemate/SessionClosedLoop") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    const session = yield* Session.Service
    const fs = yield* AppFileSystem.Service
    const config = yield* Config.Service

    const sessionKey = (sessionID: SessionID) => ["workflow", "session", sessionID]

    const stateOf = Effect.fn("SessionClosedLoop.stateOf")(function* (sessionID: SessionID) {
      return yield* storage.read<WorkflowState>(sessionKey(sessionID)).pipe(
        Effect.catch(() =>
          Effect.succeed<WorkflowState>({
            drift: { last_checked_completed_subtasks: 0 },
            completed_subtasks: [],
            selfcheck: { rounds: 0 },
          }),
        ),
      )
    })

    const writeState = Effect.fn("SessionClosedLoop.writeState")(function* (sessionID: SessionID, next: WorkflowState) {
      yield* storage
        .write(sessionKey(sessionID), {
          ...next,
          drift: next.drift ?? { last_checked_completed_subtasks: 0 },
          completed_subtasks: next.completed_subtasks ?? [],
          selfcheck: next.selfcheck ?? { rounds: 0 },
        } satisfies WorkflowState)
        .pipe(Effect.orDie)
    })

    const updateState = Effect.fn("SessionClosedLoop.updateState")(function* (
      sessionID: SessionID,
      update: (draft: WorkflowState) => void,
    ) {
      const current = yield* stateOf(sessionID)
      update(current)
      yield* writeState(sessionID, current)
      return current
    })

    const appendJsonl = Effect.fn("SessionClosedLoop.appendJsonl")(function* (file: string, payload: unknown) {
      const current = yield* fs.readFileStringSafe(file).pipe(Effect.orDie)
      const line = JSON.stringify(payload)
      const text = current && current.trim().length > 0 ? `${current.trimEnd()}\n${line}\n` : `${line}\n`
      yield* fs.writeWithDirs(file, text).pipe(Effect.orDie)
    })

    const resolveProjectRoot = Effect.fn("SessionClosedLoop.resolveProjectRoot")(function* (sessionID?: SessionID) {
      const ctx = yield* InstanceState.context
      if (!sessionID) {
        if (ctx.worktree && ctx.worktree !== "/") return ctx.worktree
        return ctx.directory
      }

      const info = yield* session.get(sessionID).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!info) {
        if (ctx.worktree && ctx.worktree !== "/") return ctx.worktree
        return ctx.directory
      }

      const project = Database.use((db) =>
        db.select({ worktree: ProjectTable.worktree }).from(ProjectTable).where(eq(ProjectTable.id, info.projectID)).get(),
      )
      if (project?.worktree && project.worktree !== "/") return project.worktree
      if (info.directory && info.directory !== "/") return info.directory
      if (ctx.worktree && ctx.worktree !== "/") return ctx.worktree
      return ctx.directory
    })

    const pathProjectLessons = Effect.fn("SessionClosedLoop.pathProjectLessons")(function* (sessionID?: SessionID) {
      return path.join(yield* resolveProjectRoot(sessionID), ".codemate", "lessons.jsonl")
    })

    const pathProjectChangelog = Effect.fn("SessionClosedLoop.pathProjectChangelog")(function* (sessionID?: SessionID) {
      return path.join(yield* resolveProjectRoot(sessionID), ".codemate", "changelog.md")
    })

    const pathGlobalLessons = path.join(Global.Path.data, "lessons", "global.jsonl")

    const resolveIntentAnchor: Interface["resolveIntentAnchor"] = Effect.fn("SessionClosedLoop.resolveIntentAnchor")(
      function* (input) {
        const own = yield* stateOf(input.sessionID)
        const latestUser = input.messages.findLast(
          (msg) =>
            msg.info.role === "user" &&
            msg.parts.some(
              (part) =>
                part.type === "text" &&
                !part.synthetic &&
                !part.ignored &&
                typeof part.text === "string" &&
                part.text.trim().length > 0,
            ),
        )
        if (own.intent_anchor_refresh_requested) {
          if (latestUser && latestUser.info.role === "user" && latestUser.info.id !== own.intent_anchor?.source_message_id) {
            const sourceText = latestUser.parts
              .filter((part): part is MessageV2.TextPart => part.type === "text" && !part.synthetic && !part.ignored)
              .map((part) => part.text)
              .join("\n")
            const summary = compressIntentAnchor(sourceText)
            if (summary) {
              const anchor: SessionIntentAnchor = {
                text: summary,
                source_message_id: latestUser.info.id,
                created_at: Date.now(),
              }
              yield* updateState(input.sessionID, (draft) => {
                draft.intent_anchor = anchor
                draft.intent_anchor_refresh_requested = false
              })
              return anchor
            }
          }
          if (own.intent_anchor) return own.intent_anchor
        }
        if (own.intent_anchor) return own.intent_anchor

        let parent = (yield* session.get(input.sessionID).pipe(Effect.orDie)).parentID
        while (parent) {
          const parentState = yield* stateOf(parent)
          if (parentState.intent_anchor) {
            yield* updateState(input.sessionID, (draft) => {
              draft.intent_anchor = parentState.intent_anchor
              draft.intent_anchor_refresh_requested = false
            })
            return parentState.intent_anchor
          }
          parent = (yield* session.get(parent).pipe(Effect.orDie)).parentID
        }

        const firstUser = input.messages.find(
          (msg) => msg.info.role === "user" && msg.parts.some((part) => part.type === "text" && !part.synthetic),
        )
        if (!firstUser || firstUser.info.role !== "user") return

        const sourceText = firstUser.parts
          .filter((part): part is MessageV2.TextPart => part.type === "text" && !part.synthetic && !part.ignored)
          .map((part) => part.text)
          .join("\n")

        const summary = compressIntentAnchor(sourceText)
        if (!summary) return

        const anchor: SessionIntentAnchor = {
          text: summary,
          source_message_id: firstUser.info.id,
          created_at: Date.now(),
        }

        yield* updateState(input.sessionID, (draft) => {
          draft.intent_anchor = anchor
          draft.intent_anchor_refresh_requested = false
        })
        return anchor
      },
    )

    const intentReminder: Interface["intentReminder"] = (anchor) =>
      [
        "<system-reminder>",
        "Intent anchor (must remain unchanged unless user explicitly changes scope):",
        anchor.text,
        "</system-reminder>",
      ].join("\n")

    const requestIntentAnchorRefresh: Interface["requestIntentAnchorRefresh"] = Effect.fn(
      "SessionClosedLoop.requestIntentAnchorRefresh",
    )(function* (sessionID) {
      yield* updateState(sessionID, (draft) => {
        draft.intent_anchor_refresh_requested = true
      })
    })

    const recordLessonWrite: Interface["recordLessonWrite"] = Effect.fn("SessionClosedLoop.recordLessonWrite")(function* (input) {
      if (input.count <= 0) return
      yield* updateState(input.sessionID, (draft) => {
        draft.lessons_written = Math.max(0, draft.lessons_written ?? 0) + Math.floor(input.count)
      })
    })

    const lessonStats: Interface["lessonStats"] = Effect.fn("SessionClosedLoop.lessonStats")(function* (sessionID) {
      const current = yield* stateOf(sessionID)
      const text = (yield* fs.readFileStringSafe(yield* pathProjectLessons()).pipe(Effect.orDie)) ?? ""
      const total = parseJsonl(text).length
      return {
        learned: Math.max(0, Math.floor(current.lessons_written ?? 0)),
        total: Math.max(0, total),
      } satisfies SessionLessonStats
    })

    const driftCheckpoint: Interface["driftCheckpoint"] = Effect.fn("SessionClosedLoop.driftCheckpoint")(function* (input) {
      const checkpoint = Math.floor(input.completedSubtasks / DRIFT_INTERVAL) * DRIFT_INTERVAL
      if (checkpoint < DRIFT_INTERVAL) return
      const info = yield* stateOf(input.sessionID)
      const last = info.drift?.last_checked_completed_subtasks ?? 0
      if (checkpoint <= last) return
      return checkpoint
    })

    const markDriftChecked: Interface["markDriftChecked"] = Effect.fn("SessionClosedLoop.markDriftChecked")(function* (
      input,
    ) {
      yield* updateState(input.sessionID, (draft) => {
        draft.drift = { last_checked_completed_subtasks: input.completedSubtasks }
      })
    })

    const listCompletedSubtasks: Interface["listCompletedSubtasks"] = Effect.fn(
      "SessionClosedLoop.listCompletedSubtasks",
    )(function* (sessionID) {
      return (yield* stateOf(sessionID)).completed_subtasks ?? []
    })

    const markSubtaskCompleted: Interface["markSubtaskCompleted"] = Effect.fn(
      "SessionClosedLoop.markSubtaskCompleted",
    )(function* (input) {
      yield* updateState(input.sessionID, (draft) => {
        const next = new Set(draft.completed_subtasks ?? [])
        next.add(input.taskKey)
        draft.completed_subtasks = [...next]
      })
    })

    const taskLayers: Interface["taskLayers"] = (input) => {
      const completed = new Set(input.completed)
      const pending = [...input.pending]
      const layers: MessageV2.SubtaskPart[][] = []

      while (pending.length > 0) {
        const runnable = pending.filter((task) => {
          const blockedBy = Array.isArray(task.blocked_by)
            ? task.blocked_by.filter((x): x is string => typeof x === "string")
            : []
          return blockedBy.every((id) => completed.has(id))
        })
        if (runnable.length === 0) break

        layers.push(runnable)
        const runnableKeys = new Set(runnable.map((task) => taskKey(task)))
        for (const key of runnableKeys) completed.add(key)
        const left = pending.filter((task) => !runnableKeys.has(taskKey(task)))
        pending.length = 0
        pending.push(...left)
      }

      return {
        layers,
        unresolved: pending,
      }
    }

    const appendProjectLesson: Interface["appendProjectLesson"] = Effect.fn("SessionClosedLoop.appendProjectLesson")(
      function* (input) {
        yield* appendJsonl(yield* pathProjectLessons(input.sessionID), input.record).pipe(Effect.orDie)
      },
    )

    const appendGlobalLesson: Interface["appendGlobalLesson"] = Effect.fn("SessionClosedLoop.appendGlobalLesson")(
      function* (record) {
        yield* appendJsonl(pathGlobalLessons, record).pipe(Effect.orDie)
      },
    )

    const appendChangelog: Interface["appendChangelog"] = Effect.fn("SessionClosedLoop.appendChangelog")(function* (input) {
      const file = yield* pathProjectChangelog(input.sessionID)
      const current = (yield* fs.readFileStringSafe(file).pipe(Effect.orDie)) ?? ""
      const time = new Date().toISOString()
      const block = [`## ${time} - ${input.title}`, "", input.body.trim(), ""].join("\n")
      yield* fs.writeWithDirs(file, current ? `${current.trimEnd()}\n\n${block}` : `${block}\n`).pipe(Effect.orDie)
    })

    const readRecentChangelog: Interface["readRecentChangelog"] = Effect.fn("SessionClosedLoop.readRecentChangelog")(
      function* (input) {
        const text = (yield* fs.readFileStringSafe(yield* pathProjectChangelog(input.sessionID)).pipe(Effect.orDie)) ?? ""
        if (!text.trim()) return
        const lines = text.replace(/\r/g, "").split("\n")
        const entries = lines.reduce<string[]>((acc, line) => {
          if (!line.startsWith("## ")) return acc.length === 0 ? acc : [...acc.slice(0, -1), `${acc.at(-1)}\n${line}`]
          return [...acc, line]
        }, [])
        const normalized = entries.map((entry) => entry.trim()).filter((entry) => entry.length > 0)
        if (normalized.length === 0) return
        const limit = Math.max(1, Math.floor(input?.limit ?? 3))
        const maxChars = Math.max(200, Math.floor(input?.maxChars ?? 1800))
        let selected = normalized.slice(-limit)
        let joined = selected.join("\n\n").trim()
        while (selected.length > 1 && joined.length > maxChars) {
          selected = selected.slice(1)
          joined = selected.join("\n\n").trim()
        }
        if (joined.length > maxChars) {
          const head = joined.slice(0, Math.max(0, maxChars - 15)).trimEnd()
          return `${head}\n...[truncated]`
        }
        return joined
      },
    )

    const searchReusableLessons: Interface["searchReusableLessons"] = Effect.fn(
      "SessionClosedLoop.searchReusableLessons",
    )(function* (input) {
      const toRecord = (scope: "project" | "global", item: unknown): ReusableLessonRecord | undefined => {
        if (!item || typeof item !== "object") return
        const source = item as Record<string, unknown>
        if (typeof source.lesson !== "string" || source.lesson.trim().length === 0) return
        return {
          scope,
          tags: Array.isArray(source.tags)
            ? source.tags.filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0)
            : [],
          stack: Array.isArray(source.stack)
            ? source.stack.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
            : [],
          fingerprint: typeof source.fingerprint === "string" ? source.fingerprint : "",
          lesson: source.lesson.trim(),
          detail: typeof source.detail === "string" ? source.detail : "",
          fix: typeof source.fix === "string" ? source.fix : "",
          created_at: typeof source.created_at === "number" && Number.isFinite(source.created_at) ? source.created_at : 0,
        }
      }
      const shouldDropAggressiveNoOp = (record: ReusableLessonRecord) => {
        if (record.scope !== "global") return false
        const tags = record.tags.map((tag) => tag.toLowerCase())
        if (!tags.includes("persistence") || !tags.includes("no-op")) return false
        const text = `${record.lesson}\n${record.detail}\n${record.fix}`.toLowerCase()
        if (!text.includes("changed files")) return false
        if (!(text.includes("no-op") || text.includes("no op"))) return false
        return true
      }

      const projectText = (yield* fs.readFileStringSafe(yield* pathProjectLessons(input.sessionID)).pipe(Effect.orDie)) ?? ""
      const globalText = (yield* fs.readFileStringSafe(pathGlobalLessons).pipe(Effect.orDie)) ?? ""
      const records = [
        ...parseJsonl(projectText).flatMap((item) => {
          const normalized = toRecord("project", item)
          return normalized ? [normalized] : []
        }),
        ...parseJsonl(globalText).flatMap((item) => {
          const normalized = toRecord("global", item)
          return normalized ? [normalized] : []
        }),
      ].filter((record) => !shouldDropAggressiveNoOp(record))
      const queryTokens = [...new Set(tokenize(input.query))]
      if (queryTokens.length === 0) return records.slice(-Math.max(1, input.topK ?? 5))

      return records
        .map((record) => {
          const haystack = [
            record.lesson,
            record.detail,
            record.fix,
            record.fingerprint,
            record.tags.join(" "),
            record.stack.join(" "),
          ]
            .join(" ")
            .toLowerCase()
          const score = queryTokens.reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0)
          return { record, score }
        })
        .filter((item) => item.score > 0)
        .toSorted((a, b) => b.score - a.score || b.record.created_at - a.record.created_at)
        .slice(0, Math.max(1, input.topK ?? 5))
        .map((item) => item.record)
    })

    const readGlobalLessons = Effect.fn("SessionClosedLoop.readGlobalLessons")(function* () {
      const text = yield* fs.readFileStringSafe(pathGlobalLessons).pipe(Effect.orDie)
      if (!text) return [] as ResearchLessonRecord[]
      return parseJsonl<ResearchLessonRecord>(text)
    })

    const fingerprint: Interface["fingerprint"] = (input) => fingerprintOf(input)

    const findResearchLesson: Interface["findResearchLesson"] = Effect.fn("SessionClosedLoop.findResearchLesson")(
      function* (input) {
        if (input.refresh) return
        const key = fingerprintOf({ topic: input.topic, stack: input.stack, tags: input.tags })
        const candidates = (yield* readGlobalLessons()).filter((item) => {
          if (!item.tags.includes("research")) return false
          if (item.fingerprint === key) return true
          const a = item.fingerprint.split("|")
          const b = key.split("|")
          return b.length > 0 && b.filter((token) => a.includes(token)).length >= Math.min(3, b.length)
        })
        return candidates.at(-1)
      },
    )

    const saveResearchLesson: Interface["saveResearchLesson"] = Effect.fn("SessionClosedLoop.saveResearchLesson")(
      function* (input) {
        const ctx = yield* InstanceState.context
        const record: ResearchLessonRecord = {
          id: ulid(),
          scope: "global",
          tags: [...new Set(["research", ...(input.tags ?? [])])],
          stack: input.stack ?? [],
          fingerprint: fingerprintOf({ topic: input.topic, stack: input.stack, tags: input.tags }),
          lesson: input.lesson,
          detail: input.detail,
          fix: input.fix,
          created_at: Date.now(),
          project_id: ctx.project.id,
        }
        yield* appendGlobalLesson(record)
        return record
      },
    )

    const inferSelfCheck: Interface["inferSelfCheck"] = Effect.fn("SessionClosedLoop.inferSelfCheck")(function* (input) {
      const ctx = yield* InstanceState.context
      const cwd = input?.cwd ?? ctx.directory
      const pkgPath = path.join(cwd, "package.json")
      const hasPkg = yield* fs.existsSafe(pkgPath).pipe(Effect.orDie)
      if (hasPkg) {
        const pkg = yield* fs.readJson(pkgPath).pipe(Effect.orElseSucceed(() => ({})), Effect.orDie)
        const scripts =
          pkg && typeof pkg === "object" && "scripts" in pkg && pkg.scripts && typeof pkg.scripts === "object"
            ? pkg.scripts
            : undefined
        const hasWorkspaces = pkg && typeof pkg === "object" && "workspaces" in pkg
        const commands = [
          ...(scripts && "typecheck" in scripts ? ["bun typecheck"] : []),
          ...(scripts && "test" in scripts && !(hasWorkspaces && cwd === ctx.worktree)
            ? ["bun test --timeout 30000"]
            : []),
        ]
        if (commands.length > 0) return { cwd, commands }
      }

      const codematePkg = path.join(ctx.worktree, "packages", "codemate", "package.json")
      if (yield* fs.existsSafe(codematePkg).pipe(Effect.orDie)) {
        return {
          cwd: path.dirname(codematePkg),
          commands: ["bun typecheck"],
        }
      }

      return { cwd, commands: [] }
    })

    const runSelfCheck: Interface["runSelfCheck"] = Effect.fn("SessionClosedLoop.runSelfCheck")(function* (input) {
      const inferred = !input.commands || input.commands.length === 0
      const fromInference = yield* inferSelfCheck({ cwd: input.cwd })
      const commands = input.commands && input.commands.length > 0 ? input.commands : fromInference.commands
      if (commands.length === 0) {
        return {
          success: true,
          inferred,
          max_rounds: input.maxRounds ?? 5,
          results: [],
        } satisfies SelfCheckReport
      }

      const cfg = yield* config.get()
      const results: SelfCheckReport["results"] = yield* Effect.forEach(
        commands,
        (command) =>
          Effect.promise(() =>
            Process.text([command], {
              cwd: fromInference.cwd,
              shell: cfg.shell ?? true,
              nothrow: true,
              timeout: 120_000,
            }),
          ).pipe(
            Effect.map((output) => ({
              command,
              exit_code: output.code,
              output: `${output.stdout.toString()}${output.stderr.toString()}`.trim(),
            })),
            Effect.catch((error) =>
              Effect.succeed({
                command,
                exit_code: 1,
                output: errorMessage(error),
              }),
            ),
          ),
        { concurrency: 1 },
      )

      return {
        success: results.every((item) => item.exit_code === 0),
        inferred,
        max_rounds: input.maxRounds ?? 5,
        results,
      } satisfies SelfCheckReport
    })

    const selfCheckRounds: Interface["selfCheckRounds"] = Effect.fn("SessionClosedLoop.selfCheckRounds")(function* (
      sessionID,
    ) {
      return (yield* stateOf(sessionID)).selfcheck?.rounds ?? 0
    })

    const bumpSelfCheckRounds: Interface["bumpSelfCheckRounds"] = Effect.fn("SessionClosedLoop.bumpSelfCheckRounds")(
      function* (input) {
        const state = yield* updateState(input.sessionID, (draft) => {
          if (input.reset) {
            draft.selfcheck = { rounds: 0 }
            return
          }
          draft.selfcheck = { rounds: (draft.selfcheck?.rounds ?? 0) + 1 }
        })
        return state.selfcheck?.rounds ?? 0
      },
    )

    const memoryKey = ["supermemory", "records"] as const

    const readMemory = Effect.fn("SessionClosedLoop.readMemory")(function* () {
      return yield* storage.read<SupermemoryRecord[]>([...memoryKey]).pipe(Effect.orElseSucceed(() => []))
    })

    const writeMemory = (records: SupermemoryRecord[]) => storage.write([...memoryKey], records).pipe(Effect.orDie)

    const supermemoryAdd: Interface["supermemoryAdd"] = Effect.fn("SessionClosedLoop.supermemoryAdd")(function* (input) {
      const cfg = yield* config.get()
      const ctx = yield* InstanceState.context
      const records = [...(yield* readMemory())]
      const record: SupermemoryRecord = {
        id: ulid(),
        content: input.content.trim(),
        scope: input.scope,
        tags: [...new Set(input.tags ?? [])],
        created_at: Date.now(),
        user: cfg.username,
        project_id: ctx.project.id,
      }
      records.push(record)
      yield* writeMemory(records)
      return record
    })

    const scoreMemory = (record: SupermemoryRecord, query: string) => {
      const tokens = query
        .toLowerCase()
        .split(/\s+/)
        .map((x) => x.trim())
        .filter((x) => x.length > 0)
      if (tokens.length === 0) return 0
      const haystack = `${record.content} ${record.tags.join(" ")} ${record.scope}`.toLowerCase()
      return tokens.reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0)
    }

    const supermemorySearch: Interface["supermemorySearch"] = Effect.fn("SessionClosedLoop.supermemorySearch")(
      function* (input) {
        const scoped = (yield* readMemory()).filter((record) => !input.scope || record.scope === input.scope)
        return scoped
          .map((record) => ({ record, score: scoreMemory(record, input.query) }))
          .filter((item) => item.score > 0)
          .toSorted((a, b) => b.score - a.score || b.record.created_at - a.record.created_at)
          .slice(0, input.topK ?? 5)
          .map((item) => item.record)
      },
    )

    const supermemoryList: Interface["supermemoryList"] = Effect.fn("SessionClosedLoop.supermemoryList")(function* (input) {
      const records = yield* readMemory()
      const scoped = input?.scope ? records.filter((record) => record.scope === input.scope) : records
      return scoped.toSorted((a, b) => b.created_at - a.created_at)
    })

    const supermemoryForget: Interface["supermemoryForget"] = Effect.fn("SessionClosedLoop.supermemoryForget")(
      function* (input) {
        const records = yield* readMemory()
        const next = records.filter((record) => {
          if (input.id) return record.id !== input.id
          if (input.query) return !record.content.toLowerCase().includes(input.query.toLowerCase())
          return false
        })
        yield* writeMemory(next)
        return records.length - next.length
      },
    )

    const supermemoryProfile: Interface["supermemoryProfile"] = Effect.fn("SessionClosedLoop.supermemoryProfile")(
      function* () {
        const records = yield* readMemory()
        return {
          total: records.length,
          by_scope: {
            user: records.filter((record) => record.scope === "user").length,
            project: records.filter((record) => record.scope === "project").length,
          },
          top_tags: Object.entries(
            records.reduce<Record<string, number>>((acc, record) => {
              for (const tag of record.tags) acc[tag] = (acc[tag] ?? 0) + 1
              return acc
            }, {}),
          )
            .toSorted((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([tag, count]) => ({ tag, count })),
        }
      },
    )

    return Service.of({
      resolveIntentAnchor,
      intentReminder,
      requestIntentAnchorRefresh,
      recordLessonWrite,
      lessonStats,
      driftCheckpoint,
      markDriftChecked,
      listCompletedSubtasks,
      markSubtaskCompleted,
      taskKey,
      taskLayers,
      appendProjectLesson,
      appendGlobalLesson,
      appendChangelog,
      readRecentChangelog,
      searchReusableLessons,
      findResearchLesson,
      saveResearchLesson,
      fingerprint,
      inferSelfCheck,
      runSelfCheck,
      selfCheckRounds,
      bumpSelfCheckRounds,
      supermemoryAdd,
      supermemorySearch,
      supermemoryList,
      supermemoryForget,
      supermemoryProfile,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Session.defaultLayer),
  Layer.provide(Storage.defaultLayer),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(Config.defaultLayer),
)

export * as SessionClosedLoop from "./closed-loop"
