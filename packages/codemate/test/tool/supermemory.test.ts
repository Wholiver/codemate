import { afterEach, describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { ToolRegistry } from "@/tool/registry"
import { ConfigPermission } from "@/config/permission"
import { Permission } from "@/permission"
import type { Tool } from "@/tool/tool"
import { SessionID, MessageID } from "@/session/schema"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(ToolRegistry.defaultLayer)

const baseCtx: Omit<Tool.Context, "ask"> = {
  sessionID: SessionID.make("ses_supermemory"),
  messageID: MessageID.make("msg_supermemory"),
  callID: "",
  agent: "orchestrator",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
}

const getTool = Effect.fn("SupermemoryTest.getTool")(function* () {
  const registry = yield* ToolRegistry.Service
  const tool = (yield* registry.all()).find((item) => item.id === "supermemory")
  expect(tool).toBeDefined()
  if (!tool) throw new Error("supermemory tool not found")
  return tool
})

afterEach(async () => {
  await disposeAllInstances()
})

describe("tool.supermemory", () => {
  it.instance("is registered in ToolRegistry", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      expect(yield* registry.ids()).toContain("supermemory")
    }),
  )

  it.effect("permission schema includes supermemory key", () =>
    Effect.gen(function* () {
      const decoded = yield* Schema.decodeUnknownEffect(ConfigPermission.Info)({
        supermemory: "allow",
      })
      expect(decoded.supermemory).toBeDefined()
    }),
  )

  it.instance("add/search/list/profile/forget are functional", () =>
    Effect.gen(function* () {
      const tool = yield* getTool()
      const asks: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
      const ctx: Tool.Context = {
        ...baseCtx,
        ask: (req) =>
          Effect.sync(() => {
            asks.push(req)
          }),
      }

      const add = yield* tool.execute(
        {
          action: "add",
          content: "Remember TLS command flags and deterministic output fields.",
          scope: "project",
          tags: ["tls", "stability"],
        },
        ctx,
      )
      expect(add.title).toBe("Memory added")
      const record = (add.metadata as { record?: { id?: string; content?: string } }).record
      expect(typeof record?.id).toBe("string")
      expect(record?.content).toContain("deterministic output fields")

      const search = yield* tool.execute(
        {
          action: "search",
          query: "TLS deterministic",
          scope: "project",
          top_k: 5,
        },
        ctx,
      )
      const searchRecords = JSON.parse(search.output) as Array<{ id: string; content: string }>
      expect(searchRecords.some((item) => item.content.includes("deterministic output fields"))).toBe(true)

      const list = yield* tool.execute({ action: "list", scope: "project" }, ctx)
      const listRecords = JSON.parse(list.output) as Array<{ id: string; content: string }>
      expect(listRecords.some((item) => item.id === record?.id)).toBe(true)

      const profile = yield* tool.execute({ action: "profile" }, ctx)
      const profileObj = JSON.parse(profile.output) as {
        total: number
        by_scope: { user: number; project: number }
      }
      expect(profileObj.total).toBeGreaterThan(0)
      expect(profileObj.by_scope.project).toBeGreaterThan(0)

      const forget = yield* tool.execute({ action: "forget", id: record?.id }, ctx)
      expect(forget.output).toContain("Removed 1 memory entry")

      const listAfter = yield* tool.execute({ action: "list", scope: "project" }, ctx)
      const listAfterRecords = JSON.parse(listAfter.output) as Array<{ id: string }>
      expect(listAfterRecords.some((item) => item.id === record?.id)).toBe(false)

      expect(asks.length).toBeGreaterThan(0)
      expect(asks.every((item) => item.permission === "supermemory")).toBe(true)
    }),
  )

  it.instance("empty memory state does not error", () =>
    Effect.gen(function* () {
      const tool = yield* getTool()
      const ctx: Tool.Context = {
        ...baseCtx,
        ask: () => Effect.void,
      }

      const list = yield* tool.execute({ action: "list" }, ctx)
      expect(JSON.parse(list.output)).toEqual([])

      const search = yield* tool.execute({ action: "search", query: "nothing" }, ctx)
      expect(JSON.parse(search.output)).toEqual([])

      const profile = yield* tool.execute({ action: "profile" }, ctx)
      const profileObj = JSON.parse(profile.output) as { total: number }
      expect(profileObj.total).toBe(0)

      const forget = yield* tool.execute({ action: "forget", query: "nothing" }, ctx)
      expect(forget.output).toContain("Removed 0 memory entries")
    }),
  )

  it.instance("works without API keys or network access", () =>
    Effect.gen(function* () {
      const previousSupermemory = process.env["SUPERMEMORY_API_KEY"]
      const previousOpenAI = process.env["OPENAI_API_KEY"]
      delete process.env["SUPERMEMORY_API_KEY"]
      delete process.env["OPENAI_API_KEY"]
      const tool = yield* getTool()
      const ctx: Tool.Context = {
        ...baseCtx,
        ask: () => Effect.void,
      }

      const add = yield* tool.execute({ action: "add", content: "offline memory check", scope: "user" }, ctx)
      expect(add.title).toBe("Memory added")

      const search = yield* tool.execute({ action: "search", query: "offline memory", scope: "user" }, ctx)
      const records = JSON.parse(search.output) as Array<{ content: string }>
      expect(records.some((item) => item.content.includes("offline memory check"))).toBe(true)

      if (previousSupermemory) process.env["SUPERMEMORY_API_KEY"] = previousSupermemory
      else delete process.env["SUPERMEMORY_API_KEY"]
      if (previousOpenAI) process.env["OPENAI_API_KEY"] = previousOpenAI
      else delete process.env["OPENAI_API_KEY"]
    }),
  )
})
