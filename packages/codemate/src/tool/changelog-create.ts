import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Changelog } from "@/changelog/changelog"

export const Parameters = Schema.Struct({
  files: Schema.Array(Schema.String).annotate({
    description: "List of changed file paths (relative to project root)",
  }),
  summary: Schema.String.annotate({
    description: "Brief description of what changed and why",
  }),
})

type Metadata = { id?: string; files: number }

export const ChangelogCreateTool = Tool.define<typeof Parameters, Metadata, Changelog.Service>(
  "changelog_append",
  Effect.gen(function* () {
    const changelog = yield* Changelog.Service
    return {
      description: `Record a changelog entry after code changes.`,
      parameters: Parameters,
      execute: (params, ctx) =>
        changelog
          .append({
            files: [...params.files],
            summary: params.summary,
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
          })
          .pipe(
            Effect.match({
              onFailure: (error) => ({
                title: "Failed to log change",
                output: error.message,
                metadata: { files: params.files.length },
              }),
              onSuccess: (result) => ({
                title: `Changelog: ${result.files.length} files changed`,
                output: JSON.stringify(result, null, 2),
                metadata: { id: result.id, files: result.files.length },
              }),
            }),
          ),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
