import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./planner.txt"
import { NonNegativeInt } from "@/util/schema"

const Step = Schema.Struct({
  description: Schema.String.annotate({ description: "Brief description of this step" }),
  type: Schema.Literals(["action", "research", "verification"]).annotate({
    description: "Step type: action (do something), research (investigate), verification (confirm result)",
  }),
})

export const Parameters = Schema.Struct({
  difficulty: Schema.Literals(["easy", "medium", "hard"]).annotate({
    description: "Estimated task difficulty based on scope, risk, and uncertainty",
  }),
  estimated_minutes: NonNegativeInt.annotate({
    description: "Estimated minutes to complete the task",
  }),
  needs_search_for_accuracy: Schema.Boolean.annotate({
    description:
      "Whether external searching is required to produce an accurate answer (latest facts, external behavior, unclear docs)",
  }),
  reasoning: Schema.String.annotate({
    description: "Why the task has this difficulty/time estimate and why search is or is not needed",
  }),
  steps: Schema.Array(Step).annotate({ description: "Ordered list of planned steps" }),
})

export const PlannerTool = Tool.define(
  "planner",
  Effect.succeed({
    description: DESCRIPTION,
    parameters: Parameters,
    execute: (params: Schema.Schema.Type<typeof Parameters>) =>
      Effect.succeed({
        title: `Plan: ${params.difficulty}`,
        output: JSON.stringify(
          {
            difficulty: params.difficulty,
            estimated_minutes: params.estimated_minutes,
            needs_search_for_accuracy: params.needs_search_for_accuracy,
            reasoning: params.reasoning,
            steps: params.steps,
          },
          null,
          2,
        ),
        metadata: {},
      }),
  }),
)
