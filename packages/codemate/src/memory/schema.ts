import { Schema } from "effect"

import { Identifier } from "@/id/id"
import { zod, ZodOverride } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"

export const MemoryID = Schema.String.annotate({ [ZodOverride]: Identifier.schema("memory") }).pipe(
  Schema.brand("MemoryID"),
  withStatics((s) => ({
    descending: (id?: string) => s.make(Identifier.descending("memory", id)),
    zod: zod(s),
  })),
)

export type MemoryID = Schema.Schema.Type<typeof MemoryID>

export * as MemorySchema from "./schema"
