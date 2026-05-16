import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import * as SessionClosedLoop from "@/session/closed-loop"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session"

const DESCRIPTION = `Persist structured lessons in JSONL stores.
- project: .codemate/lessons.jsonl
- global: data/lessons/global.jsonl`

export const Event = {
  StatsUpdated: BusEvent.define(
    "lesson.stats.updated",
    Schema.Struct({
      sessionID: SessionID,
      learned: Schema.Number,
      total: Schema.Number,
    }),
  ),
}

export const Parameters = Schema.Struct({
  scope: Schema.Literals(["project", "global", "both"]),
  tags: Schema.mutable(Schema.Array(Schema.String)),
  stack: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  lesson: Schema.String,
  detail: Schema.optional(Schema.String),
  fix: Schema.optional(Schema.String),
  fingerprint: Schema.optional(Schema.String),
})

const MIN_RESEARCH_GLOBAL_LESSON_CHARS = 120
const INVALID_RESEARCH_PHRASES = [
  "zero diffs",
  "zero tests",
  "zero research output",
  "no output",
  "no results",
  "nothing found",
  "no code changes",
  "produced no code changes",
  "implementation was deferred",
]

function researchQualityIssue(lesson: string) {
  const trimmed = lesson.trim()
  if (!trimmed) return "empty_lesson"
  if (trimmed.length < MIN_RESEARCH_GLOBAL_LESSON_CHARS) return "research_lesson_too_short"

  const lower = trimmed.toLowerCase()
  const invalid = INVALID_RESEARCH_PHRASES.find((phrase) => lower.includes(phrase))
  if (invalid) return `invalid_phrase:${invalid}`

  const hasTechnicalSignal =
    /`[^`]+`/.test(trimmed) ||
    /--[a-z0-9][a-z0-9-]*/i.test(trimmed) ||
    /\/[a-z0-9._/-]+/i.test(trimmed) ||
    /\b(openssl|tls|ssl|x\.509|rsa|pem|certificate|cipher|subject|issuer|api|endpoint|schema|command|flag|script|python|typescript|node|bun|npm)\b/i.test(
      trimmed,
    )
  if (!hasTechnicalSignal) return "missing_technical_signal"
}

export const LessonWriteTool = Tool.define(
  "lesson_write",
  Effect.gen(function* () {
    const loop = yield* SessionClosedLoop.Service
    const bus = yield* Bus.Service
    const sessions = yield* Session.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "lesson_write",
            patterns: [params.scope],
            always: ["*"],
            metadata: {
              scope: params.scope,
              tags: params.tags,
            },
          })

          const payload = {
            id: Date.now().toString(36),
            scope: params.scope,
            tags: params.tags,
            stack: params.stack ?? [],
            fingerprint:
              params.fingerprint ??
              loop.fingerprint({ topic: params.lesson, stack: params.stack ?? [], tags: params.tags }),
            lesson: params.lesson,
            detail: params.detail ?? "",
            fix: params.fix ?? "",
            created_at: Date.now(),
          }

          const researchIssue =
            (params.scope === "global" || params.scope === "both") && params.tags.includes("research")
              ? researchQualityIssue(params.lesson)
              : undefined
          const isResearchGlobalCandidate = !!researchIssue
          let wroteProject = false
          let wroteGlobal = false

          if (params.scope === "project" || params.scope === "both") {
            yield* loop.appendProjectLesson({ sessionID: ctx.sessionID, record: payload })
            wroteProject = true
          }
          if ((params.scope === "global" || params.scope === "both") && !isResearchGlobalCandidate) {
            yield* loop.appendGlobalLesson(payload)
            wroteGlobal = true
          }

          const writtenCount = (wroteProject ? 1 : 0) + (wroteGlobal ? 1 : 0)
          const statsSessionID = yield* Effect.gen(function* () {
            let currentID = ctx.sessionID
            for (let depth = 0; depth < 16; depth += 1) {
              const current = yield* sessions.get(currentID).pipe(Effect.catch(() => Effect.succeed(undefined)))
              if (!current) return ctx.sessionID
              if (!current.parentID) return current.id
              currentID = current.parentID
            }
            return ctx.sessionID
          })
          if (writtenCount > 0) {
            yield* loop.recordLessonWrite({
              sessionID: statsSessionID,
              count: writtenCount,
            })
          }
          const stats = yield* loop.lessonStats(statsSessionID)
          yield* bus.publish(Event.StatsUpdated, {
            sessionID: statsSessionID,
            learned: stats.learned,
            total: stats.total,
          })

          if (isResearchGlobalCandidate) {
            return {
              title: "Lesson skipped (quality gate)",
            output: [
              "Skipped writing low-quality research lesson to global cache.",
              `Reason: ${researchIssue}`,
              `Actual length: ${params.lesson.trim().length}`,
            ].join("\n"),
            metadata: {
              skipped: true,
              reason: researchIssue,
              payload,
              stats,
              stats_session_id: statsSessionID,
              written_count: writtenCount,
            },
          }
          }

          return {
            title: "Lesson written",
            output: JSON.stringify(payload, null, 2),
            metadata: {
              skipped: false,
              reason: "written",
              payload,
              stats,
              stats_session_id: statsSessionID,
              written_count: writtenCount,
            },
          }
        }),
    }
  }),
)
