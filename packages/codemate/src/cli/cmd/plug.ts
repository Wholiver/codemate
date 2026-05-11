import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"

export type PlugDeps = {
  spinner: () => {
    start: (msg: string) => void
    stop: (msg: string, code?: number) => void
  }
  log: {
    error: (msg: string) => void
    info: (msg: string) => void
    success: (msg: string) => void
  }
  resolve: (spec: string) => Promise<string>
  readText: (file: string) => Promise<string>
  write: (file: string, text: string) => Promise<void>
  exists: (file: string) => Promise<boolean>
  files: (dir: string, name: "codemate" | "tui") => string[]
  global: string
}

export type PlugInput = {
  mod: string
  global?: boolean
  force?: boolean
}

export type PlugCtx = {
  vcs?: string
  worktree: string
  directory: string
}

export function createPlugTask(_input: PlugInput, _dep?: PlugDeps) {
  return async (_ctx: PlugCtx) => false
}

export const PluginCommand = effectCmd({
  command: "plugin <module>",
  aliases: ["plug"],
  describe: "plugin support is disabled",
  handler: Effect.fn("Cli.plug.disabled")(function* () {
    process.exitCode = 1
  }),
})
