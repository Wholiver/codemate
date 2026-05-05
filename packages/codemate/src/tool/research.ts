import path from "path"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./research.txt"
import { AppFileSystem } from "@codemate-ai/core/filesystem"
import { PositiveInt } from "@/util/schema"
import { Instance } from "@/project/instance"
import { generateYaml } from "./research/yaml-utils"
import { relativePath, resolvePath } from "./research/common"
import { slugify } from "./research/slug"

const Item = Schema.Struct({
  name: Schema.String,
  category: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
})

const Field = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  detail_level: Schema.optional(Schema.String),
  required: Schema.optional(Schema.Boolean),
})

const FieldCategory = Schema.Struct({
  category: Schema.String,
  fields: Schema.Array(Field),
})

export const Parameters = Schema.Struct({
  topic: Schema.String.annotate({ description: "Research topic" }),
  time_range: Schema.optional(Schema.String).annotate({
    description: "Optional time scope note to include alongside the topic",
  }),
  batch_size: Schema.optional(PositiveInt).annotate({
    description: "How many parallel research agents to run per batch",
  }),
  items_per_agent: Schema.optional(PositiveInt).annotate({
    description: "How many outline items each research agent should handle",
  }),
  output_dir: Schema.optional(Schema.String).annotate({
    description: "Results directory relative to the research folder (defaults to ./results)",
  }),
  items: Schema.Array(Item).annotate({
    description: "The outline items the model has already decided to research",
  }),
  field_categories: Schema.Array(FieldCategory).annotate({
    description: "The field categories and fields the model wants written to fields.yaml",
  }),
})

export const ResearchTool = Tool.define(
  "research",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const folder = resolvePath(slugify(params.topic) || "research")
          const outlinePath = path.join(folder, "outline.yaml")
          const fieldsPath = path.join(folder, "fields.yaml")
          const outline = {
            topic: params.time_range ? `${params.topic} (${params.time_range})` : params.topic,
            items: [...params.items],
            execution: {
              batch_size: params.batch_size ?? 3,
              items_per_agent: params.items_per_agent ?? 1,
              output_dir: params.output_dir ?? "./results",
            },
          }
          const fields = {
            field_categories: [...params.field_categories],
          }

          yield* ctx.ask({
            permission: "edit",
            patterns: [relativePath(outlinePath), relativePath(fieldsPath)],
            always: ["*"],
            metadata: {
              outlinePath,
              fieldsPath,
            },
          })

          yield* fs.ensureDir(folder)
          yield* fs.writeFileString(outlinePath, generateYaml(outline))
          yield* fs.writeFileString(fieldsPath, generateYaml(fields))

          return {
            title: path.relative(Instance.worktree, folder),
            metadata: {
              folder,
              outlinePath,
              fieldsPath,
              itemCount: params.items.length,
              fieldCategoryCount: params.field_categories.length,
            },
            output: [
              `Created research workspace at ${folder}.`,
              `Outline: ${outlinePath}`,
              `Fields: ${fieldsPath}`,
              `Items: ${params.items.length}`,
              `Field categories: ${params.field_categories.length}`,
              "Review the generated YAML, then use research-add-items, research-add-fields, or research-deep as needed.",
            ].join("\n"),
          }
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof Parameters>
  }),
)
