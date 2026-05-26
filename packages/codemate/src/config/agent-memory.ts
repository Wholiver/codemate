export * as ConfigAgentMemory from "./agent-memory"

import { Schema } from "effect"
import { PositiveInt, withStatics } from "@codemate-ai/core/schema"
import { zod } from "@codemate-ai/core/effect-zod"

export const Backend = Schema.Literals([
  "off",
  "jsonl",
  "memory",
  "hybrid-jsonl",
  "hybrid-memory",
  "hnsw-jsonl",
  "hnsw-memory",
  "agentdb",
  "agentdb-hybrid",
]).pipe(
  withStatics((s) => ({ zod: zod(s) })),
)

export const Embedding = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  provider: Schema.optional(Schema.Literals(["off", "deterministic", "openai-compatible", "local-http"])),
  dimensions: Schema.optional(PositiveInt),
  openaiCompatible: Schema.optional(
    Schema.Struct({
      baseUrl: Schema.optional(Schema.String),
      apiKeyEnv: Schema.optional(Schema.String),
      model: Schema.optional(Schema.String),
      timeoutMs: Schema.optional(PositiveInt),
      endpoint: Schema.optional(Schema.String),
    }),
  ),
  localHttp: Schema.optional(
    Schema.Struct({
      url: Schema.optional(Schema.String),
      model: Schema.optional(Schema.String),
      timeoutMs: Schema.optional(PositiveInt),
    }),
  ),
}).pipe(withStatics((s) => ({ zod: zod(s) })))

export const Hybrid = Schema.Struct({
  keywordWeight: Schema.optional(Schema.Number),
  semanticWeight: Schema.optional(Schema.Number),
  candidateMultiplier: Schema.optional(PositiveInt),
  candidateLimit: Schema.optional(PositiveInt),
}).pipe(withStatics((s) => ({ zod: zod(s) })))

export const Info = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  backend: Schema.optional(Backend),
  embedding: Schema.optional(Embedding),
  hybrid: Schema.optional(Hybrid),
})
  .annotate({ identifier: "AgentMemoryConfig" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))

export type Info = Schema.Schema.Type<typeof Info>
