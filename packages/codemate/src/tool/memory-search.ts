import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Memory } from "@/memory/memory"
import type { SearchMode } from "@/memory/search"

export const Parameters = Schema.Struct({
  query: Schema.String.annotate({
    description: "Search query (keyword-based search across memory content, summaries, and tags)",
  }),
  domain: Schema.optional(
    Schema.String.annotate({
      description: "Filter by domain (e.g. 'project', 'user', 'code')",
    }),
  ),
  limit: Schema.optional(
    Schema.Number.annotate({
      description: "Maximum number of results (default: 10)",
    }),
  ),
  mode: Schema.optional(
    Schema.Union([Schema.Literal("keyword"), Schema.Literal("semantic"), Schema.Literal("hybrid")]).annotate({
      description: "Search mode: 'keyword' for text matching, 'semantic' for meaning-based, 'hybrid' for combined (default: hybrid)",
    }),
  ),
})

type Metadata = { count: number }

export const MemorySearchTool = Tool.define<typeof Parameters, Metadata, Memory.Service>(
  "memory_search",
  Effect.gen(function* () {
    const memory = yield* Memory.Service
    return {
      description: `Search long-term memories across all sessions.

TRIGGER KEYWORDS: 记忆, 长期记忆, 回忆, 召回, recalling cross-session memory

USE THIS TOOL WHEN:
- User asks about something discussed in a previous session
- You need context about past decisions or findings
- User says "remember when..." or "didn't we discuss..."
- Looking for related memories before creating a new one

Search modes: keyword (fast, exact match), semantic (meaning-based), hybrid (recommended, combines both).`,
      parameters: Parameters,
      execute: (params, ctx) =>
        memory
          .search({
            query: params.query,
            domain: params.domain,
            limit: params.limit ?? 10,
            mode: (params.mode as SearchMode) ?? "hybrid",
          })
          .pipe(
            Effect.match({
              onFailure: (error) => ({
                title: "Search failed",
                output: `Error searching memories: ${error.message}`,
                metadata: { count: 0 },
              }),
              onSuccess: (results) => {
                if (results.length === 0) {
                  return {
                    title: "No memories found",
                    output: "No memories matching the query were found.",
                    metadata: { count: 0 },
                  }
                }

                const formatted = results.map((r) => ({
                  uri: `${r.domain}://${r.path}`,
                  summary: r.summary ?? r.content.slice(0, 200),
                  version: r.version,
                  vitality: Math.round(r.vitality * 100) / 100,
                  tags: r.tags,
                  lastUpdated: new Date(r.timeUpdated).toISOString(),
                }))

                return {
                  title: `${results.length} memor${results.length === 1 ? "y" : "ies"} found`,
                  output: JSON.stringify(formatted, null, 2),
                  metadata: { count: results.length },
                }
              },
            }),
          ),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
