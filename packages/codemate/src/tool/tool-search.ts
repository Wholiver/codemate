import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import type { CatalogEntry } from "./registry"

/** Parameters for the tool_search tool. */
export const Parameters = Schema.Struct({
  query: Schema.String.annotate({
    description: "Natural language search query to find tools",
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
type Search = (query: string, opts?: { limit?: number; source?: string }) => Effect.Effect<CatalogEntry[]>
type Reveal = (sessionID: string, ids: readonly string[]) => Effect.Effect<void>

/** Tool that allows LLMs to discover available tools via natural language search. */
export function createToolSearchTool(search: Search, reveal: Reveal) {
  return Tool.define(
    "tool_search",
    Effect.succeed({
      description: `Search for hidden tools by description. Use this when the currently available tools are not enough for a task or a specialized integration might exist. Matching tools become available in the next step.`,
      parameters: Parameters,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const limit = Math.min(Math.max(params.limit ?? 10, 1), 20)
          const source = params.category !== "all" ? params.category : undefined

          const results = yield* search(params.query, { limit, source })
          yield* reveal(
            ctx.sessionID,
            results.map((entry) => entry.id),
          )

          if (results.length === 0) {
            return {
              title: "No tools found",
              output: `No tools matching "${params.query}" were found.`,
              metadata: { count: 0 },
            }
          }

          const lines = results.map((entry) => {
            const paramList = entry.parameters.length > 0 ? ` (${entry.parameters.join(", ")})` : ""
            return `- ${entry.name}: ${entry.description}${paramList}`
          })

          return {
            title: `${results.length} tool${results.length === 1 ? "" : "s"} found`,
            output: [
              `Found ${results.length} tool${results.length === 1 ? "" : "s"} matching "${params.query}":`,
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
