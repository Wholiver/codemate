import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import * as SessionClosedLoop from "@/session/closed-loop"

const DESCRIPTION = `Run code-level self checks inferred from the current project.

Default inference:
- prefers package-local \`bun typecheck\`
- runs \`bun test\` only when safe for the current package context

Use this tool after code changes and before finalizing.`

export const Parameters = Schema.Struct({
  cwd: Schema.optional(Schema.String).annotate({ description: "Optional working directory override" }),
  commands: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Explicit commands. If omitted, commands are inferred automatically.",
  }),
  max_rounds: Schema.optional(Schema.Number).annotate({ description: "Repair loop upper bound (default 5)" }),
})

type Metadata = {
  report: Schema.Schema.Type<typeof SessionClosedLoop.SelfCheckReport>
}

export const SelfCheckTool = Tool.define<typeof Parameters, Metadata, SessionClosedLoop.Service>(
  "selfcheck",
  Effect.gen(function* () {
    const loop = yield* SessionClosedLoop.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const inferred = yield* loop.inferSelfCheck({ cwd: params.cwd })
          const commands = params.commands && params.commands.length > 0 ? params.commands : inferred.commands

          yield* ctx.ask({
            permission: "selfcheck",
            patterns: commands.length > 0 ? commands : ["inferred:noop"],
            always: ["*"],
            metadata: {
              cwd: inferred.cwd,
              command_count: commands.length,
            },
          })

          const report = yield* loop.runSelfCheck({
            cwd: inferred.cwd,
            commands,
            maxRounds: params.max_rounds,
          })

          return {
            title: report.success ? "Selfcheck passed" : "Selfcheck failed",
            output: JSON.stringify(report, null, 2),
            metadata: { report },
          }
        }),
    }
  }),
)
