import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Memory } from "@/memory/memory"

export const Parameters = Schema.Struct({
  domain: Schema.String.annotate({
    description: "Memory domain (e.g. 'project', 'user', 'code')",
  }),
  path: Schema.String.annotate({
    description: "Memory path (e.g. 'api/design', 'auth/strategy')",
  }),
})

type Metadata = { found: boolean }

export const MemoryReadTool = Tool.define<typeof Parameters, Metadata, Memory.Service>(
  "memory_read",
  Effect.gen(function* () {
    const memory = yield* Memory.Service
    return {
      description: `Read a specific long-term memory by its domain and path.

USE THIS TOOL WHEN:
- You know the exact domain and path of the memory you need
- memory_search returned a result and you want the full content
- User asks to see a specific memory

Reading a memory boosts its vitality score, keeping frequently-accessed memories alive.`,
      parameters: Parameters,
      execute: (params, ctx) =>
        memory
          .read({
            domain: params.domain,
            path: params.path,
          })
          .pipe(
            Effect.match({
              onFailure: (error) => ({
                title: "Read failed",
                output: `Error reading memory at ${params.domain}://${params.path}: ${error.message}`,
                metadata: { found: false },
              }),
              onSuccess: (result) => {
                if (!result) {
                  return {
                    title: "Memory not found",
                    output: `No memory found at ${params.domain}://${params.path}`,
                    metadata: { found: false },
                  }
                }

                return {
                  title: `${result.domain}://${result.path} (v${result.version})`,
                  output: JSON.stringify(
                    {
                      content: result.content,
                      summary: result.summary,
                      version: result.version,
                      vitality: result.vitality,
                      accessCount: result.accessCount,
                      tags: result.tags,
                      created: new Date(result.timeCreated).toISOString(),
                      updated: new Date(result.timeUpdated).toISOString(),
                    },
                    null,
                    2,
                  ),
                  metadata: { found: true },
                }
              },
            }),
          ),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
