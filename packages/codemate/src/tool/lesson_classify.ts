import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import * as SessionClosedLoop from "@/session/closed-loop"
import * as LessonSchema from "@/session/lesson-schema"
import { ulid } from "ulid"

const DESCRIPTION = `Classify a lesson into project/global scope and tags.
Returns a structured JSON object aligned with Prompt① outputs.`

export const Parameters = Schema.Struct({
  lesson_text: Schema.String,
  stack: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  error_context: Schema.optional(Schema.String),
  fix: Schema.optional(Schema.String),
  project_description: Schema.optional(Schema.String),
})

function tagsFrom(text: string) {
  const mapping = {
    research: ["research", "doc", "documentation", "reference", "investigate", "调研", "文档"],
    test: ["test", "assert", "ci", "failing", "测试"],
    typecheck: ["type", "typescript", "tsgo", "typecheck", "类型"],
    build: ["build", "compile", "bundle", "构建"],
    lint: ["lint", "eslint", "oxlint", "格式"],
    dependency: ["dependency", "package", "版本", "upgrade", "downgrade"],
    runtime: ["runtime", "crash", "exception", "panic", "异常"],
  } as const

  const lower = text.toLowerCase()
  const tags = Object.entries(mapping)
    .filter(([, list]) => list.some((kw) => lower.includes(kw)))
    .map(([tag]) => tag)
  return tags.length > 0 ? tags : ["general"]
}

const CLASSIFICATION_TTL_MS = 1000 * 60 * 30

function lessonTypeFrom(tags: string[], text: string): LessonSchema.LessonType {
  if (tags.includes("research")) return "research_insight"
  if (tags.includes("runtime")) return "failure_pattern"
  if (text.includes("preference") || text.includes("偏好")) return "user_preference"
  return "workflow_rule"
}

export const LessonClassifyTool = Tool.define(
  "lesson_classify",
  Effect.gen(function* () {
    const loop = yield* SessionClosedLoop.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const text = [params.lesson_text, params.error_context ?? "", params.fix ?? ""].join("\n").trim()
          const tags = [...new Set(tagsFrom(text))]
          const type = lessonTypeFrom(tags, text.toLowerCase())
          const now = new Date()
          const classification_id = ulid()
          const reasons: string[] = []
          const qualityProbe = LessonSchema.validateLessonQuality({
            id: "probe",
            version: 2,
            scope: tags.includes("research") || tags.includes("dependency") ? "global" : "project",
            type,
            status: "active",
            summary: params.lesson_text.trim(),
            tags,
            applies_when: params.error_context?.trim() ? [params.error_context.trim()] : [],
            do: [params.lesson_text.trim()],
            dont: params.fix?.trim() ? [params.fix.trim()] : [],
            quality: {
              source: tags.includes("research") ? "research_quality_gate" : "tester_confirmed",
              confidence: tags.includes("research") ? 0.9 : 0.82,
              evidence: params.error_context?.trim() ? [params.error_context.trim()] : ["lesson_classify probe"],
            },
            source: { tool: "writer" },
            created_at: now.toISOString(),
            updated_at: now.toISOString(),
            fingerprint: "probe",
          })
          reasons.push(...qualityProbe.reasons)

          const scope: LessonSchema.LessonClassificationScope =
            !params.lesson_text.trim()
              ? "reject"
              : qualityProbe.status === "rejected"
                ? "reject"
                : qualityProbe.status === "quarantined"
                  ? "quarantine"
                  : tags.includes("research") || tags.includes("dependency")
                    ? "global"
                    : "project"
          const confidence = scope === "global" ? 0.85 : scope === "project" ? 0.72 : scope === "quarantine" ? 0.55 : 0.3
          const classification: LessonSchema.LessonClassification = {
            classification_id,
            scope,
            type,
            tags,
            confidence,
            reasons,
            created_at: now.toISOString(),
            expires_at: new Date(now.getTime() + CLASSIFICATION_TTL_MS).toISOString(),
          }
          yield* loop.saveLessonClassification({
            sessionID: ctx.sessionID,
            classification,
          })

          return {
            title: "Lesson classified",
            output: JSON.stringify(classification, null, 2),
            metadata: classification,
          }
        }),
    }
  }),
)
