import path from "path"
import { mkdirSync } from "fs"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  lessons: Schema.String.annotate({
    description: "Merged lesson-learned markdown content to write to .codemate/lessons.md",
  }),
})

type Metadata = { path: string; size: number }

export const LessonWriteTool = Tool.define<typeof Parameters, Metadata, never>(
  "lesson_write",
  Effect.gen(function* () {
    return {
      description: "Write merged lesson-learned summaries to the current project's .codemate/lessons.md file.",
      parameters: Parameters,
      execute: (params, _ctx) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const baseDir = instance.worktree === "/" ? instance.directory : instance.worktree
          const filepath = path.join(baseDir, ".codemate", "lessons.md")

          yield* Effect.sync(() => mkdirSync(path.dirname(filepath), { recursive: true }))

          return yield* Effect.tryPromise(() => Bun.file(filepath).write(params.lessons)).pipe(
            Effect.match({
              onFailure: (error) => ({
                title: "Failed to write lessons",
                output: error instanceof Error ? error.message : String(error),
                metadata: { path: filepath, size: 0 },
              }),
              onSuccess: (size) => ({
                title: "Lessons written",
                output: `Saved lessons to ${filepath}`,
                metadata: { path: filepath, size },
              }),
            }),
          )
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
