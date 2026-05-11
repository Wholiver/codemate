import { Schema } from "effect"
import { zod } from "@codemate-ai/core/effect-zod"
import { withStatics } from "@codemate-ai/core/schema"

export const Layout = Schema.Literals(["auto", "stretch"])
  .annotate({ identifier: "LayoutConfig" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Layout = Schema.Schema.Type<typeof Layout>

export * as ConfigLayout from "./layout"
