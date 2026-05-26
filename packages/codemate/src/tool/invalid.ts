import { Effect, Schema } from "effect"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  tool: Schema.String,
  error: Schema.String,
  category: Schema.optional(Schema.String),
  error_category: Schema.optional(Schema.String),
  repair_instruction: Schema.optional(Schema.String),
})

export const InvalidTool = Tool.define(
  "invalid",
  Effect.succeed({
    description: "Do not use",
    parameters: Parameters,
    execute: (params: {
      tool: string
      error: string
      category?: string
      error_category?: string
      repair_instruction?: string
    }) =>
      Effect.succeed({
        title: "Invalid Tool",
        output: "工具调用格式有误，正在调整后重试。",
        metadata: {
          category: params.category ?? "tool_call_invalid",
          tool: params.tool,
          error_category: params.error_category ?? "invalid_tool_call",
          repair_instruction: params.repair_instruction,
        },
      }),
  }),
)
