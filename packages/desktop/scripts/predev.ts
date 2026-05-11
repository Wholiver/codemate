import { $ } from "bun"

await $`bun ./scripts/copy-icons.ts ${process.env.codemate_CHANNEL ?? "dev"}`

await $`cd ../codemate && bun script/build-node.ts`
