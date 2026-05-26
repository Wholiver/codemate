import { afterEach, describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { Global } from "@codemate-ai/core/global"
import { mkdir, rm } from "fs/promises"
import path from "path"
import { ToolRegistry } from "@/tool/registry"
import { ConfigPermission } from "@/config/permission"
import { Permission } from "@/permission"
import type { Tool } from "@/tool/tool"
import { SessionID, MessageID } from "@/session/schema"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
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

  it.instance("facade uses MemoryRuntime storage and legacy compatibility", () =>
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
      const instance = yield* TestInstance
      const token = `sm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const newText = `Remember this project preference ${token} deterministic json`
      const legacyText = `Legacy preference ${token} json`
      const legacyPath = path.join(Global.Path.data, "storage", "supermemory", "records.json")
      const legacyFile = Bun.file(legacyPath)
      const previousLegacy = yield* Effect.promise(async () =>
        (await legacyFile.exists()) ? legacyFile.text() : undefined,
      ).pipe(Effect.orDie)

      yield* Effect.promise(async () => {
        await mkdir(path.dirname(legacyPath), { recursive: true })
        const parsed = previousLegacy ? JSON.parse(previousLegacy) : []
        const records = Array.isArray(parsed) ? parsed : []
        records.push({
          id: `legacy-${token}`,
          content: legacyText,
          scope: "user",
          tags: ["legacy", token],
          created_at: Date.now(),
          project_id: "legacy-project",
        })
        await Bun.write(legacyPath, JSON.stringify(records, null, 2))
      }).pipe(Effect.orDie)

      const add = yield* tool.execute(
        {
          action: "add",
          content: newText,
          scope: "project",
          tags: ["project", token],
        },
        ctx,
      )
      expect(add.title).toBe("Memory added")

      const projectMemoryPath = path.join(instance.directory, ".codemate", "memory", "records.jsonl")
      const projectMemoryText = yield* Effect.promise(() => Bun.file(projectMemoryPath).text()).pipe(Effect.orDie)
      const projectLines = projectMemoryText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { content?: { summary?: string } })
      expect(projectLines.some((item) => item.content?.summary?.includes(token))).toBe(true)

      const legacySearch = yield* tool.execute(
        {
          action: "search",
          query: legacyText,
          top_k: 10,
        },
        ctx,
      )
      const legacyRecords = JSON.parse(legacySearch.output) as Array<{ content: string }>
      expect(legacyRecords.some((item) => item.content.includes(legacyText))).toBe(true)

      const newSearch = yield* tool.execute(
        {
          action: "search",
          query: newText,
          scope: "project",
          top_k: 10,
        },
        ctx,
      )
      const newRecords = JSON.parse(newSearch.output) as Array<{ content: string }>
      expect(newRecords.some((item) => item.content.includes(newText))).toBe(true)

      const listed = yield* tool.execute({ action: "list" }, ctx)
      const listRecords = JSON.parse(listed.output) as Array<{ content: string }>
      expect(listRecords.some((item) => item.content.includes(legacyText))).toBe(true)
      expect(listRecords.some((item) => item.content.includes(newText))).toBe(true)

      const profile = yield* tool.execute({ action: "profile" }, ctx)
      const profileObj = JSON.parse(profile.output) as {
        total: number
        by_scope: { user: number; project: number }
      }
      expect(profileObj.total).toBeGreaterThan(0)
      expect(profileObj.by_scope.user).toBeGreaterThan(0)
      expect(profileObj.by_scope.project).toBeGreaterThan(0)

      const forgetNoop = yield* tool.execute({ action: "forget" }, ctx)
      expect(forgetNoop.output).toContain("Removed 0 memory entries")

      const listAfterNoop = yield* tool.execute({ action: "list" }, ctx)
      const listAfterNoopRecords = JSON.parse(listAfterNoop.output) as Array<{ content: string }>
      expect(listAfterNoopRecords.some((item) => item.content.includes(newText))).toBe(true)

      yield* Effect.promise(async () => {
        if (previousLegacy === undefined) {
          await rm(legacyPath, { force: true }).catch(() => undefined)
          return
        }
        await Bun.write(legacyPath, previousLegacy)
      }).pipe(Effect.orDie)

      expect(asks.every((item) => item.permission === "supermemory")).toBe(true)
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
