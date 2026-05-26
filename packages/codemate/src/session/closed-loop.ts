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
import * as LessonSchema from "@/session/lesson-schema"
import { appendTrajectoryRecord, type TrajectoryRecord } from "@/session/trajectory"
import { MemoryRuntime } from "@/memory/runtime"
import type { MemoryAttribution, MemoryRecord } from "@/memory/types"
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

export type ResearchLessonRecord = {
  id: string
  scope: "project" | "global" | "both"
  tags: string[]
  stack: string[]
  fingerprint: string
  lesson: string
  detail: string
  fix: string
  created_at: number
  project_id?: string
}

export type ReusableLessonRecord = LessonSchema.LessonRecord

export type FailureRecoveryStage =
  | "planner"
  | "scheduler"
  | "coder"
  | "tester"
  | "reviewer"
  | "writer"
  | "selfcheck"
  | "unknown"

type PendingFailureEvent = {
  id: string
  run_id?: string
  task_id?: string
  intent_anchor?: string
  failed_stage: FailureRecoveryStage
  failed_agent?: string
  failure_signal: string
  evidence_refs?: string[]
  created_at: string
}

export type FailureRecoveryCandidate = {
  id: string
  run_id?: string
  task_id?: string
  intent_anchor?: string
  failed_stage: FailureRecoveryStage
  failed_agent?: string
  failure_signal: string
  repair_action?: string
  success_signal?: string
  evidence_refs?: string[]
  created_at: string
}

export type LessonUpsertResult = {
  written: boolean
  deduped: boolean
  merged_with?: string
  conflicts_with?: string[]
  possible_conflicts?: string[]
}

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
  active_run?: {
    run_id: string
    source_message_id: MessageID
    intent_anchor_hash: string
    status: "active" | "cancelled" | "completed"
    started_at: number
    cancelled_at?: number
    completed_at?: number
  }
  lessons_written?: number
  drift?: {
    last_checked_completed_subtasks: number
  }
  completed_subtasks?: string[]
  selfcheck?: {
    rounds: number
  }
  failure_recovery?: {
    pending: PendingFailureEvent[]
    candidates: FailureRecoveryCandidate[]
  }
  trajectory?: TrajectoryRecord[]
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

function compactText(input: string | undefined, max = 220) {
  if (!input) return
  const normalized = input.replace(/\s+/g, " ").trim()
  if (!normalized) return
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, Math.max(0, max - 15)).trimEnd()}...[truncated]`
}

function compactEvidence(input: string[] | undefined) {
  if (!input || input.length === 0) return
  const next = [...new Set(input.map((item) => compactText(item, 140)).filter((item): item is string => !!item))]
  return next.length > 0 ? next.slice(0, 8) : undefined
}

function taskKey(task: MessageV2.SubtaskPart) {
  if (typeof task.task_id === "string" && task.task_id.trim()) return task.task_id.trim()
  if (typeof task.id === "string") return task.id
  return `${task.task_role}:${task.agent}:${task.description}:${task.prompt}`
}

export interface Interface {
  readonly startRun: (input: {
    sessionID: SessionID
    run_id: string
    source_message_id: MessageID
    intent_anchor_hash: string
  }) => Effect.Effect<void>
  readonly cancelRun: (input: { sessionID: SessionID; run_id?: string }) => Effect.Effect<void>
  readonly completeRun: (input: { sessionID: SessionID; run_id?: string }) => Effect.Effect<void>
  readonly activeRun: (sessionID: SessionID) => Effect.Effect<WorkflowState["active_run"] | undefined>
  readonly isTaskInActiveRun: (input: {
    sessionID: SessionID
    run_id?: string
    intent_anchor_hash?: string
    source_user_message_id?: MessageID
  }) => Effect.Effect<boolean>
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
  readonly appendProjectLesson: (input: {
    sessionID: SessionID
    record: Record<string, unknown>
  }) => Effect.Effect<LessonUpsertResult>
  readonly appendGlobalLesson: (record: Record<string, unknown>) => Effect.Effect<LessonUpsertResult>
  readonly appendChangelog: (input: { sessionID: SessionID; title: string; body: string }) => Effect.Effect<void>
  readonly readRecentChangelog: (input: { sessionID: SessionID; limit?: number; maxChars?: number }) => Effect.Effect<string | undefined>
  readonly saveLessonClassification: (input: {
    sessionID: SessionID
    classification: LessonSchema.LessonClassification
  }) => Effect.Effect<void>
  readonly getLessonClassification: (input: {
    sessionID: SessionID
    classificationID: string
  }) => Effect.Effect<LessonSchema.LessonClassification | undefined>
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
  readonly recordFailureEvent: (input: {
    sessionID: SessionID
    failed_stage: FailureRecoveryStage
    failure_signal: string
    failed_agent?: string
    task_id?: string
    run_id?: string
    intent_anchor?: string
    evidence_refs?: string[]
  }) => Effect.Effect<void>
  readonly resolveFailureEvent: (input: {
    sessionID: SessionID
    failed_stage: FailureRecoveryStage
    success_signal?: string
    repair_action?: string
    failed_agent?: string
    task_id?: string
    run_id?: string
    evidence_refs?: string[]
  }) => Effect.Effect<FailureRecoveryCandidate | undefined>
  readonly listFailureRecoveryCandidates: (sessionID: SessionID) => Effect.Effect<FailureRecoveryCandidate[]>
  readonly recordTrajectory: (input: { sessionID: SessionID; record: TrajectoryRecord }) => Effect.Effect<void>
  readonly listTrajectory: (sessionID: SessionID) => Effect.Effect<TrajectoryRecord[]>
  readonly supermemoryAdd: (input: {
    content: string
    scope: "user" | "project"
    tags?: string[]
    sessionID?: SessionID
    messageID?: MessageID
    attribution?: MemoryAttribution
  }) => Effect.Effect<SupermemoryRecord>
  readonly supermemorySearch: (input: {
    query: string
    scope?: "user" | "project"
    topK?: number
    sessionID?: SessionID
    messageID?: MessageID
    attribution?: MemoryAttribution
  }) => Effect.Effect<SupermemoryRecord[]>
  readonly supermemoryList: (input?: {
    scope?: "user" | "project"
    sessionID?: SessionID
    messageID?: MessageID
    attribution?: MemoryAttribution
  }) => Effect.Effect<SupermemoryRecord[]>
  readonly supermemoryForget: (input: {
    id?: string
    query?: string
    sessionID?: SessionID
    messageID?: MessageID
    attribution?: MemoryAttribution
  }) => Effect.Effect<number>
  readonly supermemoryProfile: (input?: {
    sessionID?: SessionID
    messageID?: MessageID
    attribution?: MemoryAttribution
  }) => Effect.Effect<Record<string, unknown>>
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
            failure_recovery: { pending: [], candidates: [] },
            trajectory: [],
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
          failure_recovery: next.failure_recovery ?? { pending: [], candidates: [] },
          trajectory: next.trajectory ?? [],
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

    const startRun: Interface["startRun"] = Effect.fn("SessionClosedLoop.startRun")(function* (input) {
      yield* updateState(input.sessionID, (draft) => {
        const existing = draft.active_run
        if (
          existing?.status === "active" &&
          existing.run_id === input.run_id &&
          existing.source_message_id === input.source_message_id &&
          existing.intent_anchor_hash === input.intent_anchor_hash
        ) {
          return
        }
        draft.active_run = {
          run_id: input.run_id,
          source_message_id: input.source_message_id,
          intent_anchor_hash: input.intent_anchor_hash,
          status: "active",
          started_at: Date.now(),
        }
        draft.completed_subtasks = []
        draft.drift = { last_checked_completed_subtasks: 0 }
        draft.selfcheck = { rounds: 0 }
        draft.failure_recovery = {
          pending: [],
          candidates: (draft.failure_recovery?.candidates ?? []).slice(-24),
        }
        draft.trajectory = (draft.trajectory ?? []).slice(-240)
      })
    })

    const cancelRun: Interface["cancelRun"] = Effect.fn("SessionClosedLoop.cancelRun")(function* (input) {
      yield* updateState(input.sessionID, (draft) => {
        const active = draft.active_run
        if (!active) return
        if (input.run_id && active.run_id !== input.run_id) return
        draft.active_run = {
          ...active,
          status: "cancelled",
          cancelled_at: Date.now(),
        }
        draft.completed_subtasks = []
        draft.selfcheck = { rounds: 0 }
        draft.failure_recovery = { pending: [], candidates: [] }
      })
    })

    const completeRun: Interface["completeRun"] = Effect.fn("SessionClosedLoop.completeRun")(function* (input) {
      yield* updateState(input.sessionID, (draft) => {
        const active = draft.active_run
        if (!active) return
        if (input.run_id && active.run_id !== input.run_id) return
        draft.active_run = {
          ...active,
          status: "completed",
          completed_at: Date.now(),
        }
      })
    })

    const activeRun: Interface["activeRun"] = Effect.fn("SessionClosedLoop.activeRun")(function* (sessionID) {
      return (yield* stateOf(sessionID)).active_run
    })

    const isTaskInActiveRun: Interface["isTaskInActiveRun"] = Effect.fn("SessionClosedLoop.isTaskInActiveRun")(
      function* (input) {
        const active = (yield* stateOf(input.sessionID)).active_run
        if (!active || active.status !== "active") return false
        if (!input.run_id || !input.intent_anchor_hash || !input.source_user_message_id) return false
        return (
          active.run_id === input.run_id &&
          active.intent_anchor_hash === input.intent_anchor_hash &&
          active.source_message_id === input.source_user_message_id
        )
      },
    )

    const upsertLessonJsonl = Effect.fn("SessionClosedLoop.upsertLessonJsonl")(function* (input: {
      file: string
      scope: LessonSchema.LessonScope
      payload: Record<string, unknown>
    }) {
      const incoming = LessonSchema.parseLessonRecord(input.payload, { scope: input.scope })
      if (!incoming) {
        return {
          written: false,
          deduped: false,
        } satisfies LessonUpsertResult
      }
      const current = (yield* fs.readFileStringSafe(input.file).pipe(Effect.orDie)) ?? ""
      const existing = parseJsonl(current).flatMap((item) => {
        const record = LessonSchema.parseLessonRecord(item, { scope: input.scope })
        return record ? [record] : []
      })
      const hasSameFingerprint = existing.some((item) => item.fingerprint === incoming.fingerprint)
      const conflicts = hasSameFingerprint
        ? { conflicts_with: [] as string[], possible_conflicts: [] as string[] }
        : LessonSchema.detectLessonConflicts(existing, incoming)
      const incomingWithConflict =
        conflicts.conflicts_with.length > 0
          ? {
              ...incoming,
              status: "quarantined" as const,
              conflicts_with: [...new Set([...(incoming.conflicts_with ?? []), ...conflicts.conflicts_with])],
              quality: {
                ...incoming.quality,
                evidence: [
                  ...incoming.quality.evidence,
                  ...conflicts.conflicts_with.map((id) => `conflict_with:${id}`),
                ].filter((item, index, list) => list.indexOf(item) === index),
              },
            }
          : incoming
      const deduped = LessonSchema.dedupeLessonRecords(existing, incomingWithConflict)
      const text = deduped.records.map((record) => LessonSchema.serializeLessonRecord(record)).join("\n")
      yield* fs.writeWithDirs(input.file, text ? `${text}\n` : "").pipe(Effect.orDie)
      return {
        written: true,
        deduped: deduped.merged,
        merged_with: deduped.mergedWith,
        conflicts_with: conflicts.conflicts_with,
        possible_conflicts: conflicts.possible_conflicts,
      } satisfies LessonUpsertResult
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
        return yield* upsertLessonJsonl({
          file: yield* pathProjectLessons(input.sessionID),
          scope: "project",
          payload: input.record,
        })
      },
    )

    const appendGlobalLesson: Interface["appendGlobalLesson"] = Effect.fn("SessionClosedLoop.appendGlobalLesson")(
      function* (record) {
        return yield* upsertLessonJsonl({
          file: pathGlobalLessons,
          scope: "global",
          payload: record,
        })
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

    const classificationKey = (sessionID: SessionID, classificationID: string) => [
      "workflow",
      "lesson-classification",
      sessionID,
      classificationID,
    ]

    const saveLessonClassification: Interface["saveLessonClassification"] = Effect.fn(
      "SessionClosedLoop.saveLessonClassification",
    )(function* (input) {
      yield* storage.write(classificationKey(input.sessionID, input.classification.classification_id), input.classification).pipe(Effect.orDie)
    })

    const getLessonClassification: Interface["getLessonClassification"] = Effect.fn(
      "SessionClosedLoop.getLessonClassification",
    )(function* (input) {
      let currentID: SessionID | undefined = input.sessionID
      for (let depth = 0; depth < 16; depth += 1) {
        if (!currentID) return
        const found = yield* storage
          .read<LessonSchema.LessonClassification>(classificationKey(currentID, input.classificationID))
          .pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (found) return found
        currentID = (yield* session.get(currentID).pipe(Effect.catch(() => Effect.succeed(undefined))))?.parentID
      }
    })

    const searchReusableLessons: Interface["searchReusableLessons"] = Effect.fn(
      "SessionClosedLoop.searchReusableLessons",
    )(function* (input) {
      const toRecord = (scope: "project" | "global", item: unknown): ReusableLessonRecord | undefined => {
        return LessonSchema.parseLessonRecord(item, { scope })
      }
      const shouldDropAggressiveNoOp = (record: ReusableLessonRecord) => {
        if (record.scope !== "global") return false
        const tags = record.tags.map((tag) => tag.toLowerCase())
        if (!tags.includes("persistence") || !tags.includes("no-op")) return false
        const text = [record.summary, ...record.applies_when, ...record.do, ...record.dont].join("\n").toLowerCase()
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
      ].filter((record) => record.status === "active" && !shouldDropAggressiveNoOp(record))
      const queryTokens = [...new Set(tokenize(input.query))]
      if (queryTokens.length === 0) return records.slice(-Math.max(1, input.topK ?? 5))

      return records
        .map((record) => {
          const haystack = [
            record.summary,
            record.applies_when.join(" "),
            record.do.join(" "),
            record.dont.join(" "),
            record.fingerprint,
            record.tags.join(" "),
          ]
            .join(" ")
            .toLowerCase()
          const score = queryTokens.reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0)
          return { record, score }
        })
        .filter((item) => item.score > 0)
        .toSorted(
          (a, b) =>
            b.score - a.score ||
            (Number.isFinite(Date.parse(b.record.updated_at || b.record.created_at))
              ? Date.parse(b.record.updated_at || b.record.created_at)
              : 0) -
              (Number.isFinite(Date.parse(a.record.updated_at || a.record.created_at))
                ? Date.parse(a.record.updated_at || a.record.created_at)
                : 0),
        )
        .slice(0, Math.max(1, input.topK ?? 5))
        .map((item) => item.record)
    })

    const readGlobalLessons = Effect.fn("SessionClosedLoop.readGlobalLessons")(function* () {
      const text = yield* fs.readFileStringSafe(pathGlobalLessons).pipe(Effect.orDie)
      if (!text) return [] as LessonSchema.LessonRecord[]
      return parseJsonl(text).flatMap((item) => {
        const record = LessonSchema.parseLessonRecord(item, { scope: "global" })
        return record ? [record] : []
      })
    })

    const fingerprint: Interface["fingerprint"] = (input) => fingerprintOf(input)

    const findResearchLesson: Interface["findResearchLesson"] = Effect.fn("SessionClosedLoop.findResearchLesson")(
      function* (input) {
        if (input.refresh) return
        const key = fingerprintOf({ topic: input.topic, stack: input.stack, tags: input.tags })
        const candidates = (yield* readGlobalLessons()).filter((item) => {
          if (item.status !== "active") return false
          if (!item.tags.includes("research")) return false
          if (item.fingerprint === key) return true
          const a = item.fingerprint.split("|")
          const b = key.split("|")
          return b.length > 0 && b.filter((token) => a.includes(token)).length >= Math.min(3, b.length)
        })
        const latest = candidates.at(-1)
        if (!latest) return
        const lesson = [latest.summary, ...latest.do.filter((item) => item !== latest.summary)].join("\n")
        return {
          id: latest.id,
          scope: "global",
          tags: latest.tags,
          stack: [],
          fingerprint: latest.fingerprint,
          lesson,
          detail: latest.applies_when.join("; "),
          fix: latest.dont.join("; "),
          created_at: Date.parse(latest.created_at),
        } satisfies ResearchLessonRecord
      },
    )

    const saveResearchLesson: Interface["saveResearchLesson"] = Effect.fn("SessionClosedLoop.saveResearchLesson")(
      function* (input) {
        const ctx = yield* InstanceState.context
        const now = new Date().toISOString()
        const record = {
          id: ulid(),
          version: 2 as const,
          scope: "global" as const,
          type: "research_insight" as const,
          status: "active" as const,
          summary: input.lesson,
          tags: [...new Set(["research", ...(input.tags ?? [])])],
          applies_when: input.detail ? [input.detail] : [],
          do: [input.lesson],
          dont: input.fix ? [input.fix] : [],
          quality: {
            source: "research_quality_gate" as const,
            confidence: 0.7,
            evidence: input.detail ? [input.detail] : ["research draft"],
          },
          source: {
            agent: "research",
            tool: "closed_loop" as const,
          },
          fingerprint: fingerprintOf({ topic: input.topic, stack: input.stack, tags: input.tags }),
          created_at: now,
          updated_at: now,
        }
        yield* appendGlobalLesson(record)
        return {
          id: record.id,
          scope: record.scope,
          tags: record.tags,
          stack: input.stack ?? [],
          fingerprint: record.fingerprint,
          lesson: record.summary,
          detail: input.detail,
          fix: input.fix,
          created_at: Date.parse(record.created_at),
          project_id: ctx.project.id,
        } satisfies ResearchLessonRecord
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

    const recordFailureEvent: Interface["recordFailureEvent"] = Effect.fn("SessionClosedLoop.recordFailureEvent")(
      function* (input) {
        const failureSignal = compactText(input.failure_signal)
        if (!failureSignal) return
        yield* updateState(input.sessionID, (draft) => {
          const active = draft.active_run
          if (!active || active.status !== "active") return
          if (input.run_id && active.run_id !== input.run_id) return
          const pending = draft.failure_recovery?.pending ?? []
          const candidates = draft.failure_recovery?.candidates ?? []
          const nextPending = [
            ...pending.filter(
              (item) =>
                !(
                  item.failed_stage === input.failed_stage &&
                  item.task_id === input.task_id &&
                  item.failed_agent === input.failed_agent
                ),
            ),
            {
              id: ulid(),
              run_id: compactText(input.run_id ?? active.run_id, 80),
              task_id: compactText(input.task_id, 120),
              intent_anchor: compactText(input.intent_anchor, 180),
              failed_stage: input.failed_stage,
              failed_agent: compactText(input.failed_agent, 80),
              failure_signal: failureSignal,
              evidence_refs: compactEvidence(input.evidence_refs),
              created_at: new Date().toISOString(),
            } satisfies PendingFailureEvent,
          ]
          draft.failure_recovery = {
            pending: nextPending.slice(-40),
            candidates: candidates.slice(-40),
          }
        })
      },
    )

    const resolveFailureEvent: Interface["resolveFailureEvent"] = Effect.fn("SessionClosedLoop.resolveFailureEvent")(
      function* (input) {
        const successSignal = compactText(input.success_signal, 200)
        let resolved: FailureRecoveryCandidate | undefined
        yield* updateState(input.sessionID, (draft) => {
          const active = draft.active_run
          if (!active || active.status !== "active") return
          if (input.run_id && active.run_id !== input.run_id) return
          const pending = [...(draft.failure_recovery?.pending ?? [])]
          const candidates = draft.failure_recovery?.candidates ?? []
          const idx = pending.findLastIndex(
            (item) =>
              item.run_id === active.run_id &&
              item.failed_stage === input.failed_stage &&
              (!input.task_id || item.task_id === input.task_id) &&
              (!input.failed_agent || item.failed_agent === input.failed_agent),
          )
          if (idx < 0) {
            draft.failure_recovery = {
              pending,
              candidates: candidates.slice(-40),
            }
            return
          }
          const failed = pending[idx]!
          pending.splice(idx, 1)
          resolved = {
            id: failed.id,
            run_id: failed.run_id,
            task_id: failed.task_id,
            intent_anchor: failed.intent_anchor,
            failed_stage: failed.failed_stage,
            failed_agent: failed.failed_agent,
            failure_signal: failed.failure_signal,
            repair_action: compactText(input.repair_action, 200),
            success_signal: successSignal,
            evidence_refs: compactEvidence([...(failed.evidence_refs ?? []), ...(input.evidence_refs ?? [])]),
            created_at: failed.created_at,
          } satisfies FailureRecoveryCandidate
          draft.failure_recovery = {
            pending: pending.slice(-40),
            candidates: [...candidates, resolved].slice(-40),
          }
        })
        return resolved
      },
    )

    const listFailureRecoveryCandidates: Interface["listFailureRecoveryCandidates"] = Effect.fn(
      "SessionClosedLoop.listFailureRecoveryCandidates",
    )(function* (sessionID) {
      return [...((yield* stateOf(sessionID)).failure_recovery?.candidates ?? [])]
    })

    const recordTrajectory: Interface["recordTrajectory"] = Effect.fn("SessionClosedLoop.recordTrajectory")(function* (
      input,
    ) {
      yield* updateState(input.sessionID, (draft) => {
        const next = [...(draft.trajectory ?? []), input.record]
        draft.trajectory = next.slice(-300)
      })
      yield* Effect.gen(function* () {
        const projectRoot = yield* resolveProjectRoot(input.sessionID)
        const persisted = yield* Effect.promise(() => appendTrajectoryRecord(projectRoot, input.record))
        if (persisted.written) return
        yield* Effect.logWarning(`trajectory persistence warning: ${persisted.warning ?? "append failed"}`)
      }).pipe(
        Effect.catch((error: unknown) =>
          Effect.logWarning(`trajectory persistence warning: ${errorMessage(error)}`).pipe(Effect.asVoid),
        ),
      )
    })

    const listTrajectory: Interface["listTrajectory"] = Effect.fn("SessionClosedLoop.listTrajectory")(function* (sessionID) {
      return [...((yield* stateOf(sessionID)).trajectory ?? [])]
    })

    const toSupermemoryRecord = (record: MemoryRecord): SupermemoryRecord | undefined => {
      if (record.scope !== "user" && record.scope !== "project") return
      return {
        id: record.id,
        content: record.content.summary,
        scope: record.scope,
        tags: [...record.tags],
        created_at: record.lifecycle.created_at,
        user: undefined,
        project_id: record.attribution.project_id,
      }
    }

    const toSupermemoryRecords = (records: MemoryRecord[]) =>
      records
        .flatMap((record) => {
          const mapped = toSupermemoryRecord(record)
          return mapped ? [mapped] : []
        })
        .toSorted((left, right) => right.created_at - left.created_at)

    const memoryRuntime = Effect.fn("SessionClosedLoop.memoryRuntime")(function* (sessionID?: SessionID) {
      return new MemoryRuntime({
        projectRoot: yield* resolveProjectRoot(sessionID),
        dataDir: Global.Path.data,
      })
    })

    const supermemoryAttribution = Effect.fn("SessionClosedLoop.supermemoryAttribution")(function* (input?: {
      sessionID?: SessionID
      messageID?: MessageID
      attribution?: MemoryAttribution
    }) {
      const ctx = yield* InstanceState.context
      return {
        ...input?.attribution,
        session_id: input?.attribution?.session_id ?? (input?.sessionID ? String(input.sessionID) : undefined),
        message_id: input?.attribution?.message_id ?? (input?.messageID ? String(input.messageID) : undefined),
        project_id: input?.attribution?.project_id ?? ctx.project.id,
        project_root: input?.attribution?.project_root ?? (yield* resolveProjectRoot(input?.sessionID)),
        process_id: input?.attribution?.process_id ?? "task-orchestrator",
        tool_name: input?.attribution?.tool_name ?? "supermemory",
      } satisfies MemoryAttribution
    })

    const supermemoryAdd: Interface["supermemoryAdd"] = Effect.fn("SessionClosedLoop.supermemoryAdd")(function* (input) {
      const runtime = yield* memoryRuntime(input.sessionID)
      const attribution = yield* supermemoryAttribution(input)
      const record = yield* Effect.promise(() =>
        runtime.rememberUserInstruction({
          text: input.content,
          scope: input.scope,
          tags: input.tags ?? [],
          attribution,
        }),
      )
      return toSupermemoryRecord(record) ?? {
        id: record.id,
        content: record.content.summary,
        scope: "user",
        tags: [...record.tags],
        created_at: record.lifecycle.created_at,
        user: undefined,
        project_id: record.attribution.project_id,
      }
    })

    const supermemorySearch: Interface["supermemorySearch"] = Effect.fn("SessionClosedLoop.supermemorySearch")(
      function* (input) {
        const runtime = yield* memoryRuntime(input.sessionID)
        const attribution = yield* supermemoryAttribution(input)
        const records = yield* Effect.promise(() =>
          runtime.search({
            query: input.query,
            topK: input.topK,
            attribution,
          }),
        )
        const scoped = input.scope ? records.filter((record) => record.scope === input.scope) : records
        return toSupermemoryRecords(scoped)
      },
    )

    const supermemoryList: Interface["supermemoryList"] = Effect.fn("SessionClosedLoop.supermemoryList")(function* (input) {
      const runtime = yield* memoryRuntime(input?.sessionID)
      const attribution = yield* supermemoryAttribution(input)
      const records = yield* Effect.promise(() =>
        runtime.list({
          scope: input?.scope,
          attribution,
        }),
      )
      return toSupermemoryRecords(records)
    })

    const supermemoryForget: Interface["supermemoryForget"] = Effect.fn("SessionClosedLoop.supermemoryForget")(
      function* (input) {
        const runtime = yield* memoryRuntime(input.sessionID)
        const result = yield* Effect.promise(() =>
          runtime.forget({
            id: input.id,
            query: input.query,
          }),
        )
        return result.removed
      },
    )

    const supermemoryProfile: Interface["supermemoryProfile"] = Effect.fn("SessionClosedLoop.supermemoryProfile")(
      function* (input) {
        const runtime = yield* memoryRuntime(input?.sessionID)
        const attribution = yield* supermemoryAttribution(input)
        const records = toSupermemoryRecords(
          yield* Effect.promise(() =>
            runtime.list({
              attribution,
            }),
          ),
        )
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
            .toSorted((left, right) => right[1] - left[1])
            .slice(0, 10)
            .map(([tag, count]) => ({ tag, count })),
        }
      },
    )

    return Service.of({
      startRun,
      cancelRun,
      completeRun,
      activeRun,
      isTaskInActiveRun,
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
      saveLessonClassification,
      getLessonClassification,
      searchReusableLessons,
      findResearchLesson,
      saveResearchLesson,
      fingerprint,
      inferSelfCheck,
      runSelfCheck,
      selfCheckRounds,
      bumpSelfCheckRounds,
      recordFailureEvent,
      resolveFailureEvent,
      listFailureRecoveryCandidates,
      recordTrajectory,
      listTrajectory,
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
