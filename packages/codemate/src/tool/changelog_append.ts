import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import * as SessionClosedLoop from "@/session/closed-loop"

const DESCRIPTION = `Append a markdown entry to project changelog (.codemate/changelog.md).`

export const Parameters = Schema.Struct({
  title: Schema.String,
  body: Schema.String,
})

export const ChangelogAppendTool = Tool.define(
  "changelog_append",
  Effect.gen(function* () {
    const loop = yield* SessionClosedLoop.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "changelog_append",
            patterns: [params.title],
            always: ["*"],
            metadata: {
              title: params.title,
            },
          })

          yield* loop.appendChangelog({ title: params.title, body: params.body })

          return {
            title: "Changelog updated",
            output: `Appended changelog entry: ${params.title}`,
            metadata: {
              title: params.title,
            },
          }
        }),
    }
  }),
)
