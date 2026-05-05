import { Schema } from "effect"

import { Identifier } from "@/id/id"
import { zod, ZodOverride } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"

export const ChangelogID = Schema.String.annotate({ [ZodOverride]: Identifier.schema("changelog") }).pipe(
  Schema.brand("ChangelogID"),
  withStatics((s) => ({
    descending: (id?: string) => s.make(Identifier.descending("changelog", id)),
    zod: zod(s),
  })),
)

export type ChangelogID = Schema.Schema.Type<typeof ChangelogID>

export * as ChangelogSchema from "./schema"
