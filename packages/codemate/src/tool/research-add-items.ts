import path from "path"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./research-add-items.txt"
import { AppFileSystem } from "@codemate-ai/core/filesystem"
import { Instance } from "@/project/instance"
import { generateYaml } from "./research/yaml-utils"
import { locateResearchFile, mergeItems, readOutline, relativePath } from "./research/common"

const Item = Schema.Struct({
  name: Schema.String,
  category: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
})

export const Parameters = Schema.Struct({
  items: Schema.Array(Item).annotate({
    description: "Items to merge into the existing outline",
  }),
  outline_path: Schema.optional(Schema.String).annotate({
    description: "Optional explicit path to outline.yaml",
  }),
})

export const ResearchAddItemsTool = Tool.define(
  "research-add-items",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const outlinePath = yield* locateResearchFile(fs, ctx, "outline.yaml", params.outline_path)
          const outline = yield* readOutline(fs, outlinePath)
          const merged = mergeItems(outline.items ?? [], [...params.items])
          const added = merged.length - (outline.items?.length ?? 0)
          const next = {
            ...outline,
            items: merged,
          }

          yield* ctx.ask({
            permission: "edit",
            patterns: [relativePath(outlinePath)],
            always: ["*"],
            metadata: {
              outlinePath,
              added,
            },
          })

          yield* fs.writeFileString(outlinePath, generateYaml(next))

          return {
            title: path.relative(Instance.worktree, outlinePath),
            metadata: {
              outlinePath,
              totalItems: merged.length,
              added,
            },
            output: [
              `Updated ${outlinePath}.`,
              `Total items: ${merged.length}`,
              `New unique items added: ${added}`,
              "",
              ...merged.map((item, index) => `${index + 1}. ${item.name}`),
            ].join("\n"),
          }
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof Parameters>
  }),
)
