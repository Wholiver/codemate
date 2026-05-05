import { Effect, Schema } from "effect"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({})

type Metadata = { queued: boolean }

export const CompressTool = Tool.define<typeof Parameters, Metadata, never>(
  "compress",
  Effect.gen(function* () {
    return {
      description: `Compact the current session context.

Use this when the conversation is getting too large, when you want a shorter working context, or for compatibility with older prompts that still refer to "compress".`,
      parameters: Parameters,
      execute: (_params, ctx) =>
        Effect.gen(function* () {
          return {
            title: "Compaction unavailable",
            output: "Session compaction is temporarily unavailable in this build.",
            metadata: { queued: false },
          }
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
