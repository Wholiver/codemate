import { Effect, Schema } from "effect"
import * as Tool from "./tool"

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

export const LessonClassifyTool = Tool.define(
  "lesson_classify",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const text = [params.lesson_text, params.error_context ?? "", params.fix ?? ""].join("\n")
          const tags = [...new Set(tagsFrom(text))]
          const scope = tags.includes("research") || tags.includes("dependency") ? "global" : "project"

          const output = {
            scope,
            tags,
            stack: params.stack ?? [],
            lesson: params.lesson_text.trim(),
            detail: (params.error_context ?? "").trim(),
            fix: (params.fix ?? "").trim(),
            visibility: scope,
          }

          return {
            title: "Lesson classified",
            output: JSON.stringify(output, null, 2),
            metadata: output,
          }
        }),
    }
  }),
)
