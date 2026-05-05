import path from "path"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./research-deep.txt"
import { AppFileSystem } from "@codemate-ai/core/filesystem"
import { Instance } from "@/project/instance"
import { locateResearchFile, outputFilename, readOutline, relativePath, resolvePath } from "./research/common"
import { slugify } from "./research/slug"
import { generateYaml } from "./research/yaml-utils"

export const Parameters = Schema.Struct({
  outline_path: Schema.optional(Schema.String).annotate({
    description: "Optional explicit path to outline.yaml",
  }),
  output_dir: Schema.optional(Schema.String).annotate({
    description: "Optional override for the results directory",
  }),
})

export const ResearchDeepTool = Tool.define(
  "research-deep",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const outlinePath = yield* locateResearchFile(fs, ctx, "outline.yaml", params.outline_path)
          const outline = yield* readOutline(fs, outlinePath)
          const root = path.dirname(outlinePath)
          const fieldsPath = path.join(root, "fields.yaml")
          const outputDir = resolvePath(params.output_dir ?? path.join(root, outline.execution?.output_dir ?? "./results"))
          const batchSize = outline.execution?.batch_size ?? 3
          const itemsPerAgent = outline.execution?.items_per_agent ?? 1
          const pending = []
          const completed = []

          if (yield* fs.existsSafe(outputDir)) {
            yield* ctx.ask({
              permission: "read",
              patterns: [relativePath(outputDir)],
              always: ["*"],
              metadata: {
                outputDir,
              },
            })
          }

          for (const item of outline.items ?? []) {
            const outputPath = path.join(outputDir, outputFilename(item.name))
            const entry = {
              item,
              item_slug: slugify(item.name) || "item",
              output_path: outputPath,
              fields_path: fieldsPath,
              prompt: [
                "## Task",
                `Research ${generateYaml(item).trim()}, output structured JSON to ${outputPath}`,
                "",
                "## Field Definitions",
                `Read ${fieldsPath} to get all field definitions`,
                "",
                "## Output Requirements",
                "1. Output JSON according to fields defined in fields.yaml",
                "2. Mark uncertain field values with [uncertain]",
                "3. Add uncertain array at the end of JSON, listing all uncertain field names",
                "4. All field values must be in English",
                "",
                "## Output Path",
                outputPath,
                "",
                "## Validation Guidance",
                "Ensure every field defined in fields.yaml is present before you finish.",
              ].join("\n"),
            }
            if (yield* fs.existsSafe(outputPath)) {
              completed.push(entry)
              continue
            }
            pending.push(entry)
          }

          return {
            title: path.relative(Instance.worktree, outlinePath),
            metadata: {
              outlinePath,
              fieldsPath,
              outputDir,
              batchSize,
              itemsPerAgent,
              pendingCount: pending.length,
              completedCount: completed.length,
            },
            output: JSON.stringify(
              {
                topic: outline.topic,
                outline_path: outlinePath,
                fields_path: fieldsPath,
                output_dir: outputDir,
                batch_size: batchSize,
                items_per_agent: itemsPerAgent,
                completed_count: completed.length,
                pending_count: pending.length,
                tasks: pending,
              },
              null,
              2,
            ),
          }
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof Parameters>
  }),
)
