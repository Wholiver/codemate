import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import type { CatalogEntry } from "./registry"

export const Parameters = Schema.Struct({
  pattern: Schema.String.annotate({
    description: "Regular expression pattern to match against tool names and descriptions",
  }),
  category: Schema.optional(
    Schema.Union([
      Schema.Literal("all"),
      Schema.Literal("builtin"),
      Schema.Literal("mcp"),
      Schema.Literal("plugin"),
    ]).annotate({
      description: "Filter results by tool source category (default: all)",
    }),
  ),
  limit: Schema.optional(
    Schema.Number.annotate({
      description: "Maximum number of results to return, between 1 and 20 (default: 10)",
    }),
  ),
})

type Metadata = { count: number }
type SearchRegex = (pattern: string, opts?: { limit?: number; source?: string }) => Effect.Effect<CatalogEntry[]>
type Reveal = (sessionID: string, ids: readonly string[]) => Effect.Effect<void>

export function createToolSearchRegexTool(searchRegex: SearchRegex, reveal: Reveal) {
  return Tool.define(
    "tool_search_regex",
    Effect.succeed({
      description: `Search for hidden tools using a regular expression pattern. Use this when the currently available tools are not enough and you need precise matching by tool name or description. Matching tools become available in the next step.`,
      parameters: Parameters,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const limit = Math.min(Math.max(params.limit ?? 10, 1), 20)
          const source = params.category !== "all" ? params.category : undefined

          const results = yield* searchRegex(params.pattern, { limit, source })
          yield* reveal(
            ctx.sessionID,
            results.map((entry) => entry.id),
          )

          if (results.length === 0) {
            return {
              title: "No tools matched",
              output: `No tools matching pattern /${params.pattern}/i were found.`,
              metadata: { count: 0 },
            }
          }

          const lines = results.map((entry) => {
            const paramList = entry.parameters.length > 0 ? ` (${entry.parameters.join(", ")})` : ""
            return `- ${entry.name}: ${entry.description}${paramList}`
          })

          return {
            title: `${results.length} tool${results.length === 1 ? "" : "s"} matched`,
            output: [
              `Found ${results.length} tool${results.length === 1 ? "" : "s"} matching pattern /${params.pattern}/i:`,
              "These tools are now available for the next step.",
              "",
              ...lines,
            ].join("\n"),
            metadata: { count: results.length },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>),
  )
}
