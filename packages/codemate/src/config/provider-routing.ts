export * as ConfigProviderRouting from "./provider-routing"

import { Schema } from "effect"
import { PositiveInt, withStatics } from "@codemate-ai/core/schema"
import { zod } from "@codemate-ai/core/effect-zod"

export const RouteAgent = Schema.Literals([
  "orchestrator",
  "planner",
  "research",
  "coder",
  "tester",
  "reviewer",
  "writer",
  "selfcheck",
]).pipe(withStatics((s) => ({ zod: zod(s) })))

export const RouteTarget = Schema.Struct({
  provider: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
}).pipe(withStatics((s) => ({ zod: zod(s) })))

export const RouteRule = Schema.Struct({
  provider: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  fallback: Schema.optional(Schema.mutable(Schema.Array(RouteTarget))),
  maxRetries: Schema.optional(PositiveInt),
  timeoutMs: Schema.optional(PositiveInt),
  enabled: Schema.optional(Schema.Boolean),
}).pipe(withStatics((s) => ({ zod: zod(s) })))

export const CircuitBreaker = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  failureThreshold: Schema.optional(PositiveInt),
  openMs: Schema.optional(PositiveInt),
  halfOpenMaxAttempts: Schema.optional(PositiveInt),
  minAttempts: Schema.optional(PositiveInt),
}).pipe(withStatics((s) => ({ zod: zod(s) })))

export const OutcomeRoutingMode = Schema.Literals(["off", "dry_run", "enabled"]).pipe(
  withStatics((s) => ({ zod: zod(s) })),
)

export const OutcomeRouting = Schema.Struct({
  mode: Schema.optional(OutcomeRoutingMode),
  minConfidence: Schema.optional(Schema.Number),
  minSamples: Schema.optional(PositiveInt),
}).pipe(withStatics((s) => ({ zod: zod(s) })))

export const TelemetryStore = Schema.Literals(["memory", "jsonl"]).pipe(
  withStatics((s) => ({ zod: zod(s) })),
)

export const Telemetry = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  store: Schema.optional(TelemetryStore),
}).pipe(withStatics((s) => ({ zod: zod(s) })))

export const Info = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  defaultProvider: Schema.optional(Schema.String),
  defaultModel: Schema.optional(Schema.String),
  routes: Schema.optional(
    Schema.Struct({
      orchestrator: Schema.optional(RouteRule),
      planner: Schema.optional(RouteRule),
      research: Schema.optional(RouteRule),
      coder: Schema.optional(RouteRule),
      tester: Schema.optional(RouteRule),
      reviewer: Schema.optional(RouteRule),
      writer: Schema.optional(RouteRule),
      selfcheck: Schema.optional(RouteRule),
    }),
  ),
  fallback: Schema.optional(Schema.mutable(Schema.Array(RouteTarget))),
  strict: Schema.optional(Schema.Boolean),
  circuitBreaker: Schema.optional(CircuitBreaker),
  outcome_routing: Schema.optional(OutcomeRouting),
  telemetry: Schema.optional(Telemetry),
})
  .annotate({ identifier: "ProviderRoutingConfig" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))

export type Info = Schema.Schema.Type<typeof Info>
