process.stderr.write("A: before Config import\n")
const { Config } = await import("@/config/config")
process.stderr.write("B: after Config import\n")
process.stderr.write(
  "Config.Service tag: " + ((Config.Service as unknown as { readonly _tag?: unknown })._tag ?? "undefined") + "\n",
)
process.stderr.write("Done\n")
