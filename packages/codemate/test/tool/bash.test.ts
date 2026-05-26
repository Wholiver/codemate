import { describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import path from "path"
import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import { Truncate } from "@/tool/truncate"
import { Plugin } from "@/plugin"
import { AppFileSystem } from "@codemate-ai/core/filesystem"
import { CrossSpawnSpawner } from "@codemate-ai/core/cross-spawn-spawner"
import { preflightShellTool, ShellTool } from "@/tool/shell"
import { SessionID, MessageID } from "@/session/schema"
import { WithInstance } from "@/project/with-instance"
import { tmpdir } from "../fixture/fixture"

const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    CrossSpawnSpawner.defaultLayer,
    AppFileSystem.defaultLayer,
    Plugin.defaultLayer,
    Truncate.defaultLayer,
    Config.defaultLayer,
    Agent.defaultLayer,
  ),
)

const ctx = {
  sessionID: SessionID.make("ses_bash_test"),
  messageID: MessageID.make("msg_bash_test"),
  callID: "",
  agent: "orchestrator",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

describe("tool.bash", () => {
  test("tree-sitter wasm preflight is available", async () => {
    const result = await preflightShellTool({ requireOpenSSL: false })
    expect(result.available).toBe(true)
  })

  test("bash tool can run pwd/echo/mkdir preflight commands", async () => {
    await using tmp = await tmpdir()
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const info = await runtime.runPromise(ShellTool.pipe(Effect.flatMap((tool) => tool.init())))
        const marker = path.join(tmp.path, ".bash-preflight").replaceAll("\\", "/")
        const command =
          process.platform === "win32"
            ? `cd && echo ok && mkdir "${marker}" 2>nul && if exist "${marker}" echo made`
            : `pwd && echo ok && mkdir -p "${marker}" && test -d "${marker}" && echo made`
        const result = await Effect.runPromise(
          info.execute(
            {
              command,
              description: "Bash preflight command",
            },
            ctx,
          ),
        )
        expect(result.metadata.exit).toBe(0)
        expect(result.output.toLowerCase()).toContain("ok")
        expect(result.output.toLowerCase()).toContain("made")
      },
    })
  })
})
