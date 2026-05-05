import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Memory } from "@/memory/memory"

export const Parameters = Schema.Struct({
  domain: Schema.optional(
    Schema.String.annotate({
      description: "Filter by domain (e.g. 'project', 'user', 'code'). Omit to list all.",
    }),
  ),
  prefix: Schema.optional(
    Schema.String.annotate({
      description: "Filter by path prefix (e.g. 'api/' to list all API-related memories)",
    }),
  ),
})

type Metadata = { count: number }

export const MemoryListTool = Tool.define<typeof Parameters, Metadata, Memory.Service>(
  "memory_list",
  Effect.gen(function* () {
    const memory = yield* Memory.Service
    return {
      description: `List long-term memories, optionally filtered by domain or path prefix.

USE THIS TOOL WHEN:
- User asks "what do you remember?" or "你记得什么"
- Browsing memories in a specific category
- Getting an overview of all stored memories`,
      parameters: Parameters,
      execute: (params, ctx) =>
        memory
          .list({
            domain: params.domain,
            prefix: params.prefix,
          })
          .pipe(
            Effect.match({
              onFailure: (error) => ({
                title: "List failed",
                output: `Error listing memories: ${error.message}`,
                metadata: { count: 0 },
              }),
              onSuccess: (results) => {
                if (results.length === 0) {
                  return {
                    title: "No memories",
                    output: "No memories found.",
                    metadata: { count: 0 },
                  }
                }

                const formatted = results.map((r) => ({
                  uri: `${r.domain}://${r.path}`,
                  summary: r.summary ?? r.content.slice(0, 100),
                  version: r.version,
                  tags: r.tags,
                }))

                return {
                  title: `${results.length} memor${results.length === 1 ? "y" : "ies"}`,
                  output: JSON.stringify(formatted, null, 2),
                  metadata: { count: results.length },
                }
              },
            }),
          ),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
