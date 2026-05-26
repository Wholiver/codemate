import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import * as SessionClosedLoop from "@/session/closed-loop"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import * as LessonSchema from "@/session/lesson-schema"

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
  classification_id: Schema.optional(Schema.String),
  trajectory: Schema.optional(
    Schema.Struct({
      intent_anchor: Schema.optional(Schema.String),
      failed_stage: Schema.optional(
        Schema.Literals(["planner", "scheduler", "coder", "tester", "reviewer", "writer", "selfcheck", "memory", "unknown"]),
      ),
      failed_agent: Schema.optional(Schema.String),
      failure_signal: Schema.optional(Schema.String),
      failed_behavior: Schema.optional(Schema.String),
      repair_action: Schema.optional(Schema.String),
      success_signal: Schema.optional(Schema.String),
      evidence_refs: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
    }),
  ),
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

type Metadata = Record<string, unknown>

export const LessonWriteTool = Tool.define<typeof Parameters, Metadata, SessionClosedLoop.Service | Bus.Service | Session.Service>(
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
            summary: params.lesson.trim(),
            tags: params.tags,
            applies_when: params.detail?.trim() ? [params.detail.trim()] : [],
            do: [params.lesson.trim()],
            dont: params.fix?.trim() ? [params.fix.trim()] : [],
          }

          const resolvedClassification =
            params.classification_id && params.classification_id.trim()
              ? yield* loop.getLessonClassification({
                  sessionID: ctx.sessionID,
                  classificationID: params.classification_id.trim(),
                })
              : undefined
          const classificationExpired = resolvedClassification
            ? LessonSchema.isLessonClassificationExpired(resolvedClassification)
            : false
          const classificationBound = !!resolvedClassification && !classificationExpired
          const classificationScope = classificationBound ? resolvedClassification.scope : undefined
          const classificationReasons = [
            ...(resolvedClassification?.reasons ?? []),
            ...(resolvedClassification && classificationExpired ? ["classification_expired"] : []),
            ...(!resolvedClassification && params.classification_id ? ["classification_not_found"] : []),
          ]
          const scopeFromClassification: "project" | "global" | undefined =
            classificationScope === "project"
              ? "project"
              : classificationScope === "global"
                ? "global"
                : classificationScope === "quarantine"
                  ? params.scope === "global"
                    ? "global"
                    : "project"
                  : undefined
          const classificationEnforcedScopeMismatch =
            !!scopeFromClassification &&
            params.scope !== "both" &&
            (params.scope === "project" || params.scope === "global") &&
            params.scope !== scopeFromClassification
          const effectiveScope: "project" | "global" | "both" =
            scopeFromClassification ?? (params.scope === "both" ? "both" : params.scope)
          const forcedStatus =
            classificationScope === "quarantine" || (!classificationBound && !!params.classification_id) ? ("quarantined" as const) : undefined
          const shouldRejectByClassification = classificationScope === "reject"
          const now = new Date().toISOString()
          const buildRecord = (scope: "project" | "global") => {
            const type = classificationBound && resolvedClassification ? resolvedClassification.type : params.tags.includes("research") ? "research_insight" : "workflow_rule"
            const tags =
              classificationBound && resolvedClassification && resolvedClassification.tags.length > 0
                ? [...new Set(resolvedClassification.tags)]
                : payload.tags
            const trajectory =
              params.trajectory && (type === "failure_pattern" || tags.includes("failure"))
                ? {
                    ...(params.trajectory.intent_anchor?.trim() ? { intent_anchor: params.trajectory.intent_anchor.trim() } : {}),
                    ...(params.trajectory.failed_stage ? { failed_stage: params.trajectory.failed_stage } : {}),
                    ...(params.trajectory.failed_agent?.trim() ? { failed_agent: params.trajectory.failed_agent.trim() } : {}),
                    ...(params.trajectory.failure_signal?.trim() ? { failure_signal: params.trajectory.failure_signal.trim() } : {}),
                    ...(params.trajectory.failed_behavior?.trim()
                      ? { failed_behavior: params.trajectory.failed_behavior.trim() }
                      : {}),
                    ...(params.trajectory.repair_action?.trim() ? { repair_action: params.trajectory.repair_action.trim() } : {}),
                    ...(params.trajectory.success_signal?.trim() ? { success_signal: params.trajectory.success_signal.trim() } : {}),
                    ...(Array.isArray(params.trajectory.evidence_refs) && params.trajectory.evidence_refs.length > 0
                      ? { evidence_refs: params.trajectory.evidence_refs.map((item) => item.trim()).filter(Boolean) }
                      : {}),
                  }
                : undefined
            const record = {
              id: `${Date.now().toString(36)}:${scope}`,
              version: 2 as const,
              scope,
              type: type as LessonSchema.LessonType,
              status: forcedStatus ?? ("active" as const),
              summary: payload.summary,
              tags,
              applies_when: payload.applies_when,
              do: payload.do,
              dont: payload.dont,
              trajectory,
              quality: {
                source:
                  tags.includes("research") && scope === "global"
                    ? ("research_quality_gate" as const)
                    : ("writer_summary" as const),
                confidence:
                  classificationBound && resolvedClassification
                    ? resolvedClassification.confidence
                    : tags.includes("research")
                      ? 0.85
                      : 0.6,
                evidence: [
                  ...(params.detail?.trim() ? [params.detail.trim()] : ["writer lesson_write call"]),
                  ...classificationReasons.map((reason) => `classification:${reason}`),
                  ...(classificationEnforcedScopeMismatch ? ["classification:scope_mismatch_enforced"] : []),
                ].filter((item, index, list) => list.indexOf(item) === index),
              },
              source: {
                agent: ctx.agent,
                tool: "lesson_write" as const,
              },
              created_at: now,
              updated_at: now,
              fingerprint: params.fingerprint ?? "",
            }
            return {
              ...record,
              fingerprint: record.fingerprint || LessonSchema.computeLessonFingerprint(record),
            } satisfies LessonSchema.LessonRecord
          }
          const withQualityGate = (record: LessonSchema.LessonRecord) => {
            const validation = LessonSchema.validateLessonQuality(record)
            if (validation.status === "active") return { record, validation }
            const evidence = [
              ...record.quality.evidence,
              ...validation.reasons.map((reason) => `quality_gate:${reason}`),
            ].filter((item, index, list) => list.indexOf(item) === index)
            return {
              record: {
                ...record,
                status: "quarantined" as const,
                quality: {
                  ...record.quality,
                  evidence,
                },
              },
              validation,
            }
          }
          const projectRecordChecked = withQualityGate(buildRecord("project"))
          const globalRecordChecked = withQualityGate(buildRecord("global"))
          const resultPayload =
            effectiveScope === "project"
              ? projectRecordChecked.record
              : effectiveScope === "global"
                ? globalRecordChecked.record
                : { projectRecord: projectRecordChecked.record, globalRecord: globalRecordChecked.record }
          const resultQualityGate =
            effectiveScope === "project"
              ? projectRecordChecked.validation
              : effectiveScope === "global"
                ? globalRecordChecked.validation
                : { project: projectRecordChecked.validation, global: globalRecordChecked.validation }
          const researchIssue =
            (effectiveScope === "global" || effectiveScope === "both") && globalRecordChecked.record.tags.includes("research")
              ? researchQualityIssue(params.lesson)
              : undefined
          const isResearchGlobalCandidate = !!researchIssue
          let projectWriteResult: SessionClosedLoop.LessonUpsertResult | undefined
          let globalWriteResult: SessionClosedLoop.LessonUpsertResult | undefined
          let wroteProject = false
          let wroteGlobal = false
          if (!shouldRejectByClassification && (effectiveScope === "project" || effectiveScope === "both")) {
            projectWriteResult = yield* loop.appendProjectLesson({ sessionID: ctx.sessionID, record: projectRecordChecked.record })
            wroteProject = projectWriteResult.written
          }
          if (!shouldRejectByClassification && (effectiveScope === "global" || effectiveScope === "both") && !isResearchGlobalCandidate) {
            globalWriteResult = yield* loop.appendGlobalLesson(globalRecordChecked.record)
            wroteGlobal = globalWriteResult.written
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

          if (shouldRejectByClassification) {
            return {
              title: "Lesson rejected by classification",
              output: [
                "Classification rejected this lesson. No lesson was written.",
                `classification_id: ${resolvedClassification?.classification_id ?? params.classification_id ?? "n/a"}`,
              ].join("\n"),
              metadata: {
                skipped: true,
                reason: "classification_reject",
                classification_bound: classificationBound,
                legacy_classification: false,
              classification: resolvedClassification,
              stats,
              stats_session_id: statsSessionID,
              written_count: writtenCount,
              dedupe: {
                project: projectWriteResult,
                global: globalWriteResult,
              },
            },
          }
          }

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
              payload: resultPayload,
              quality_gate: resultQualityGate,
              classification_bound: classificationBound,
              legacy_classification: !params.classification_id,
              classification: resolvedClassification,
              enforced_scope: effectiveScope,
              stats,
              stats_session_id: statsSessionID,
              written_count: writtenCount,
              dedupe: {
                project: projectWriteResult,
                global: globalWriteResult,
              },
            },
          }
          }

          return {
            title: "Lesson written",
            output: JSON.stringify(
              resultPayload,
              null,
              2,
            ),
            metadata: {
              skipped: false,
              reason: "written",
              payload: resultPayload,
              quality_gate: resultQualityGate,
              classification_bound: classificationBound,
              legacy_classification: !params.classification_id,
              classification: resolvedClassification,
              enforced_scope: effectiveScope,
              stats,
              stats_session_id: statsSessionID,
              written_count: writtenCount,
              dedupe: {
                project: projectWriteResult,
                global: globalWriteResult,
              },
            },
          }
        }),
    }
  }),
)
