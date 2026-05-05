import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Memory } from "@/memory/memory"

export const Parameters = Schema.Struct({
  domain: Schema.String.annotate({
    description: "Memory domain (e.g. 'project', 'user', 'system', 'code', 'decision')",
  }),
  path: Schema.String.annotate({
    description: "Memory path within domain (e.g. 'api/design', 'auth/strategy')",
  }),
  content: Schema.String.annotate({
    description: "The memory content to store",
  }),
  summary: Schema.optional(
    Schema.String.annotate({
      description: "Brief summary for quick retrieval (auto-generated if not provided)",
    }),
  ),
  tags: Schema.optional(
    Schema.Array(Schema.String).annotate({
      description: "Tags for categorization",
    }),
  ),
})

type Metadata = { domain: string; path: string; version: number }

export const MemoryCreateTool = Tool.define<typeof Parameters, Metadata, Memory.Service>(
  "memory_create",
  Effect.gen(function* () {
    const memory = yield* Memory.Service
    return {
      description: `Create or update a long-term memory. Memories persist across sessions and help maintain context over time.

TRIGGER KEYWORDS (auto-activate when user says): 记忆, 长期记忆, 记住, 回忆, 召回, saving facts for later, recalling cross-session memory

USE THIS TOOL WHEN:
- User explicitly asks to remember something
- You discover important project decisions or architecture patterns
- You solve a complex debugging problem
- User expresses preferences about coding style or workflow

MEMORY FORMAT:
- domain: category (project, user, debugging, architecture, preference, knowledge)
- path: descriptive identifier (e.g., "api/auth-strategy", "coding-style/typescript")
- content: the actual information to remember
- tags: relevant keywords for searchability

If a memory already exists at the same domain+path, it will be updated with a new version (old version preserved in history).`,
      parameters: Parameters,
      execute: (params, ctx) =>
        memory
          .create({
            domain: params.domain,
            path: params.path,
            content: params.content,
            summary: params.summary,
            tags: params.tags ? [...params.tags] : undefined,
            sourceSessionID: ctx.sessionID,
          })
          .pipe(
            Effect.match({
              onFailure: (error) => ({
                title: "Failed to create memory",
                output: `Error creating memory at ${params.domain}://${params.path}: ${error.message}`,
                metadata: { domain: params.domain, path: params.path, version: 0 },
              }),
              onSuccess: (result) => ({
                title: `Memory ${result.domain}://${result.path} (v${result.version})`,
                output: JSON.stringify(
                  {
                    id: result.id,
                    domain: result.domain,
                    path: result.path,
                    version: result.version,
                    vitality: result.vitality,
                  },
                  null,
                  2,
                ),
                metadata: {
                  domain: result.domain,
                  path: result.path,
                  version: result.version,
                },
              }),
            }),
          ),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
