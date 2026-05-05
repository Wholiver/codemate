import path from "path"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./research-add-fields.txt"
import { AppFileSystem } from "@codemate-ai/core/filesystem"
import { Instance } from "@/project/instance"
import { generateYaml } from "./research/yaml-utils"
import { locateResearchFile, readFields, relativePath } from "./research/common"

const Field = Schema.Struct({
  name: Schema.String,
  category: Schema.String,
  description: Schema.String,
  detail_level: Schema.optional(Schema.String),
  required: Schema.optional(Schema.Boolean),
})

export const Parameters = Schema.Struct({
  fields: Schema.Array(Field).annotate({
    description: "Field definitions to merge into the existing fields.yaml",
  }),
  fields_path: Schema.optional(Schema.String).annotate({
    description: "Optional explicit path to fields.yaml",
  }),
})

export const ResearchAddFieldsTool = Tool.define(
  "research-add-fields",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const fieldsPath = yield* locateResearchFile(fs, ctx, "fields.yaml", params.fields_path)
          const existing = yield* readFields(fs, fieldsPath)
          const entries = (existing.field_categories ?? []).flatMap((category) =>
            category.fields.map((field) => ({
              category: category.category,
              ...field,
            })),
          )
          const merged = new Map(entries.map((field) => [field.name.trim().toLowerCase(), field]))
          params.fields.forEach((field) => {
            merged.set(field.name.trim().toLowerCase(), field)
          })

          const orderedCategories = [...entries.map((field) => field.category), ...params.fields.map((field) => field.category)].filter(
            (value, index, values) => values.indexOf(value) === index,
          )
          const next = {
            field_categories: orderedCategories
              .map((category) => ({
                category,
                fields: [...merged.values()]
                  .filter((field) => field.category === category)
                  .map((field) => ({
                    name: field.name,
                    description: field.description,
                    ...(field.detail_level ? { detail_level: field.detail_level } : {}),
                    ...(field.required !== undefined ? { required: field.required } : {}),
                  })),
              }))
              .filter((category) => category.fields.length > 0),
          }
          const totalFields = next.field_categories.reduce((count, category) => count + category.fields.length, 0)

          yield* ctx.ask({
            permission: "edit",
            patterns: [relativePath(fieldsPath)],
            always: ["*"],
            metadata: {
              fieldsPath,
              totalFields,
            },
          })

          yield* fs.writeFileString(fieldsPath, generateYaml(next))

          return {
            title: path.relative(Instance.worktree, fieldsPath),
            metadata: {
              fieldsPath,
              totalFields,
              categoryCount: next.field_categories.length,
            },
            output: [
              `Updated ${fieldsPath}.`,
              `Field categories: ${next.field_categories.length}`,
              `Total fields: ${totalFields}`,
            ].join("\n"),
          }
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof Parameters>
  }),
)
