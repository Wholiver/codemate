import { afterEach, describe, expect } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import os from "os"
import { mkdtemp, writeFile } from "node:fs/promises"
import path from "node:path"
import { Agent } from "../../src/agent/agent"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import { CrossSpawnSpawner } from "@codemate-ai/core/cross-spawn-spawner"
import { Session } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import type { SessionPrompt } from "../../src/session/prompt"
import * as LanguageRule from "../../src/session/language-rule"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import * as SessionClosedLoop from "../../src/session/closed-loop"
import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}
const HOME_APP = `${os.homedir().replaceAll("\\", "/").replace(/\/+$/, "")}/app`

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    Config.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Session.defaultLayer,
    SessionClosedLoop.defaultLayer,
    Truncate.defaultLayer,
    ToolRegistry.defaultLayer,
  ),
)

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const seed = Effect.fn("TaskToolTest.seed")(function* (title = "Pinned") {
  const session = yield* Session.Service
  const chat = yield* session.create({ title })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "orchestrator",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "orchestrator",
    agent: "orchestrator",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

function stubOps(opts?: { onPrompt?: (input: SessionPrompt.PromptInput) => void; text?: string }): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        opts?.onPrompt?.(input)
        return reply(input, opts?.text ?? "done")
      }),
  }
}

function reply(input: SessionPrompt.PromptInput, text: string): MessageV2.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "coder",
      agent: input.agent ?? "coder",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? ref.modelID,
      providerID: input.model?.providerID ?? ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID: input.sessionID,
        type: "text",
        text,
      },
    ],
  }
}

describe("tool.task", () => {
  it.instance(
    "description sorts subagents by name and is stable across calls",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("orchestrator")
        const registry = yield* ToolRegistry.Service
        const get = Effect.fnUntraced(function* () {
          const tools = yield* registry.tools({ ...ref, agent: build })
          return tools.find((tool) => tool.id === TaskTool.id)?.description ?? ""
        })
        const first = yield* get()
        const second = yield* get()

        expect(first).toBe(second)

        const alpha = first.indexOf("- alpha: Alpha agent")
        const coder = first.indexOf("- coder:")
        const planner = first.indexOf("- planner:")
        const zebra = first.indexOf("- zebra: Zebra agent")

        expect(alpha).toBeGreaterThan(-1)
        expect(coder).toBeGreaterThan(alpha)
        expect(planner).toBeGreaterThan(coder)
        expect(zebra).toBeGreaterThan(planner)
      }),
    {
      config: {
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance(
    "description hides denied subagents for the caller",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("orchestrator")
        const registry = yield* ToolRegistry.Service
        const description =
          (yield* registry.tools({ ...ref, agent: build })).find((tool) => tool.id === TaskTool.id)?.description ?? ""

        expect(description).toContain("- alpha: Alpha agent")
        expect(description).not.toContain("- zebra: Zebra agent")
      }),
    {
      config: {
        permission: {
          task: {
            "*": "allow",
            zebra: "deny",
          },
        },
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance("execute resumes an existing task session from task_id", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "Existing child" })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "resumed", onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "coder",
          task_id: child.id,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "orchestrator",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.id).toBe(child.id)
      expect(result.metadata.sessionId).toBe(child.id)
      expect(result.output).toContain(`task_id: ${child.id}`)
      expect(seen?.sessionID).toBe(child.id)
    }),
  )

  it.instance("execute asks by default and skips checks when bypassed", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const calls: unknown[] = []
      const promptOps = stubOps()

      const exec = (extra?: Record<string, any>) =>
        def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "coder",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "orchestrator",
            abort: new AbortController().signal,
            extra: { promptOps, ...extra },
            messages: [],
            metadata: () => Effect.void,
            ask: (input) =>
              Effect.sync(() => {
                calls.push(input)
              }),
          },
        )

      yield* exec()
      yield* exec({ bypassAgentCheck: true })

      expect(calls).toHaveLength(1)
      expect(calls[0]).toEqual({
        permission: "task",
        patterns: ["coder"],
        always: ["*"],
        metadata: {
          description: "inspect bug",
          subagent_type: "coder",
        },
      })
    }),
  )

  it.instance("execute cancels child session when abort signal fires", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = defer<SessionPrompt.PromptInput>()
      const cancelled = defer<SessionID>()
      const abort = new AbortController()
      const promptOps: TaskPromptOps = {
        cancel: (sessionID) =>
          Effect.sync(() => {
            cancelled.resolve(sessionID)
          }),
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.promise(() => {
            ready.resolve(input)
            return cancelled.promise
          }).pipe(Effect.as(reply(input, "cancelled"))),
      }

      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "coder",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "orchestrator",
            abort: abort.signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      const input = yield* Effect.promise(() => ready.promise)
      abort.abort()
      expect(yield* Effect.promise(() => cancelled.promise)).toBe(input.sessionID)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
    }),
  )

  it.instance("execute creates a child when task_id does not exist", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "created", onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "coder",
          task_id: "ses_missing",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "orchestrator",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(result.metadata.sessionId).toBeDefined()
      const sessionID = result.metadata.sessionId as SessionID
      expect(kids[0]?.id).toBe(sessionID)
      expect(sessionID).not.toBe("ses_missing")
      expect(result.output).toContain(`task_id: ${sessionID}`)
      expect(seen?.sessionID).toBe(sessionID)
    }),
  )

  it.instance("execute rejects legacy subagent aliases with migration hint", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const promptOps = stubOps()
      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "orchestrator",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain('Subagent "general" has been removed. Use "coder" instead')
      }
    }),
  )

  it.instance(
    "execute shapes child permissions for task, todowrite, and primary tools",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const agent = yield* Agent.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seen: SessionPrompt.PromptInput | undefined
        const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "reviewer",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "orchestrator",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect(result.metadata.sessionId).toBeDefined()
        const sessionID = result.metadata.sessionId as SessionID
        const child = yield* sessions.get(sessionID)
        expect(child.parentID).toBe(chat.id)
        const reviewer = yield* agent.get("reviewer")
        const effective = Permission.merge(reviewer.permission, child.permission ?? [])
        expect(Permission.evaluate("todowrite", "*", effective).action).toBe("deny")
        expect(Permission.evaluate("bash", "*", effective).action).toBe("allow")
        expect(Permission.evaluate("read", "*", effective).action).toBe("allow")
        expect(seen?.tools).toEqual({
          todowrite: false,
          bash: false,
          read: false,
        })
      }),
    {
      config: {
        agent: {
          reviewer: {
            mode: "subagent",
            permission: {
              task: "allow",
            },
          },
        },
        experimental: {
          primary_tools: ["bash", "read"],
        },
      },
    },
  )

  it.instance("execute passes parent language rule into child prompt system", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const parentMessages = yield* MessageV2.filterCompactedEffect(chat.id)
      const languageRule = LanguageRule.createLanguageRule("Chinese")
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ onPrompt: (input) => (seen = input) })
      const messages = parentMessages.map((message) => {
        if (message.info.role !== "user") return message
        return {
          ...message,
          info: {
            ...message.info,
            system: languageRule,
          },
        } satisfies MessageV2.WithParts
      })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "coder",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "orchestrator",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages,
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.metadata.sessionId).toBeDefined()
      expect(seen?.system).toContain("LANGUAGE RULE: The user is communicating in Chinese.")
      expect(seen?.system).toContain("You MUST respond in Chinese at all times.")

      const child = yield* sessions.get(result.metadata.sessionId as SessionID)
      expect(child.parentID).toBe(chat.id)
    }),
  )

  it.instance("capability guard: coder child session denies persistence/selfcheck tools", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const agent = yield* Agent.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const promptOps = stubOps()
      const result = yield* def.execute(
        {
          description: "apply implementation",
          prompt: "update files only",
          subagent_type: "coder",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "orchestrator",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const child = yield* sessions.get(result.metadata.sessionId as SessionID)
      const coder = yield* agent.get("coder")
      const effective = Permission.merge(coder.permission, child.permission ?? [])
      expect(Permission.evaluate("lesson_classify", "*", effective).action).toBe("deny")
      expect(Permission.evaluate("lesson_write", "*", effective).action).toBe("deny")
      expect(Permission.evaluate("changelog_append", "*", effective).action).toBe("deny")
      expect(Permission.evaluate("selfcheck", "*", effective).action).toBe("deny")
      expect(Permission.evaluate("edit", "src/main.ts", effective).action).toBe("allow")
    }),
  )

  it.instance("capability guard: writer child session denies implementation tools", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const agent = yield* Agent.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const promptOps = stubOps()
      const result = yield* def.execute(
        {
          description: "persist outputs",
          prompt: "write changelog and lessons only",
          subagent_type: "writer",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "orchestrator",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const child = yield* sessions.get(result.metadata.sessionId as SessionID)
      const writer = yield* agent.get("writer")
      const effective = Permission.merge(writer.permission, child.permission ?? [])
      expect(Permission.evaluate("bash", "*", effective).action).toBe("deny")
      expect(Permission.evaluate("edit", "src/main.ts", effective).action).toBe("deny")
      expect(Permission.evaluate("write", "src/main.ts", effective).action).toBe("deny")
      expect(Permission.evaluate("patch", "src/main.ts", effective).action).toBe("deny")
      expect(Permission.evaluate("selfcheck", "*", effective).action).toBe("deny")
      expect(Permission.evaluate("lesson_classify", "*", effective).action).toBe("allow")
      expect(Permission.evaluate("lesson_write", "*", effective).action).toBe("allow")
      expect(Permission.evaluate("changelog_append", "*", effective).action).toBe("allow")
    }),
  )

  it.instance("fails fast with tool_unavailable when bash preflight cannot load tree-sitter wasm", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let promptCalls = 0
      const promptOps = stubOps({ onPrompt: () => (promptCalls += 1) })
      const prev = process.env.codemate_TEST_FORCE_TREE_SITTER_WASM_MISSING
      process.env.codemate_TEST_FORCE_TREE_SITTER_WASM_MISSING = "1"
      try {
        const exit = yield* def
          .execute(
            {
              description: "generate TLS certs",
              prompt: "Use OpenSSL to generate /app/ssl/server.key and /app/ssl/server.crt",
              subagent_type: "coder",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "orchestrator",
              abort: new AbortController().signal,
              extra: { promptOps },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )
          .pipe(Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
        expect(promptCalls).toBe(0)
        if (Exit.isFailure(exit)) {
          const message = String(Cause.squash(exit.cause))
          expect(message).toContain("[tool_unavailable]")
          expect(message.toLowerCase()).toContain("tree-sitter")
        }
      } finally {
        if (prev === undefined) delete process.env.codemate_TEST_FORCE_TREE_SITTER_WASM_MISSING
        else process.env.codemate_TEST_FORCE_TREE_SITTER_WASM_MISSING = prev
      }
    }),
  )

  it.instance("maps coder write/edit schema error to structured tool_schema_error", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text", text: template }]),
        prompt: () => Effect.die(new Error('write failed: SchemaError(Missing key at ["filePath"])')),
      }

      const exit = yield* def
        .execute(
          {
            description: "write verification output",
            prompt: "Write /app/ssl/verification.txt with verification summary",
            subagent_type: "coder",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "orchestrator",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const message = String(Cause.squash(exit.cause))
        expect(message).toContain("[tool_schema_error]")
        expect(message).toContain('"error_category":"tool_schema_error"')
        expect(message).toContain('"missing_field":"filePath"')
        expect(message).toContain('"tool_name":"write"')
        expect(message).toContain("shell redirection")
        expect(message).toContain("allowed paths")
      }
    }),
  )

  it.instance("maps unknown tool-like command to structured tool_call_invalid", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text", text: template }]),
        prompt: () => Effect.die(new Error("Unknown tool: ls -la ~/app/ssl")),
      }

      const exit = yield* def
        .execute(
          {
            description: "inspect path",
            prompt: "List files under /app/ssl",
            subagent_type: "coder",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "orchestrator",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const message = String(Cause.squash(exit.cause))
        expect(message).toContain("[tool_call_invalid]")
        expect(message).toContain('"error_category":"unknown_tool"')
        expect(message).toContain('"tool_name":"ls -la ~/app/ssl"')
        expect(message).toContain("use bash tool for shell commands")
      }
    }),
  )

  it.instance("fails coder task when existing target path is claimed without current-run write evidence", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const sessions = yield* Session.Service
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const tempDir = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "codemate-task-evidence-")))
      const existingFile = path.join(tempDir, "verification.txt")
      const unrelatedFile = path.join(tempDir, "other.txt")
      yield* Effect.promise(() => writeFile(existingFile, "stale"))
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text", text: template }]),
        prompt: (input) =>
          Effect.gen(function* () {
            const id = MessageID.ascending()
            const message: MessageV2.WithParts = {
              info: {
                id,
                role: "assistant",
                parentID: input.messageID ?? MessageID.ascending(),
                sessionID: input.sessionID,
                mode: input.agent ?? "coder",
                agent: input.agent ?? "coder",
                cost: 0,
                path: { cwd: "/tmp", root: "/tmp" },
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                modelID: input.model?.modelID ?? ref.modelID,
                providerID: input.model?.providerID ?? ref.providerID,
                time: { created: Date.now() },
                finish: "stop",
              },
              parts: [
                {
                  id: PartID.ascending(),
                  messageID: id,
                  sessionID: input.sessionID,
                  type: "tool",
                  tool: "write",
                  callID: "call-write",
                  state: {
                    status: "completed",
                    input: { filePath: unrelatedFile, content: "ok" },
                    output: "Wrote file successfully.",
                    metadata: {
                      filepath: unrelatedFile,
                      exists: false,
                      verification: {
                        file_path: unrelatedFile,
                        mtime_ms: Date.now(),
                        sha256: "abc123",
                        readback_fragment: "ok",
                      },
                    },
                    title: unrelatedFile,
                    time: { start: Date.now() - 10, end: Date.now() },
                  },
                } satisfies MessageV2.ToolPart,
                {
                  id: PartID.ascending(),
                  messageID: id,
                  sessionID: input.sessionID,
                  type: "text",
                  text: `Updated ${existingFile} and completed verification.`,
                },
              ],
            }
            yield* sessions.updateMessage(message.info)
            for (const part of message.parts) {
              yield* sessions.updatePart(part as any)
            }
            return message
          }),
      }

      const exit = yield* def
        .execute(
          {
            description: "update existing verification file",
            prompt: `Update this path in current run: ${existingFile}`,
            subagent_type: "coder",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "orchestrator",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const message = String(Cause.squash(exit.cause))
        expect(message).toContain("[file_write_verification_failed]")
        expect(message).toContain(existingFile)
        expect(message).toContain("current-run write evidence")
      }
    }),
  )

  it.instance("maps file write readback mismatch to structured file_write_verification_failed", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text", text: template }]),
        prompt: () =>
          Effect.die(
            new Error(
              '[file_write_verification_failed] {"category":"file_write_verification_failed","tool_name":"write","file_path":"/tmp/demo.txt","expected_fragment":"hello","readback_fragment":"goodbye","reason":"write succeeded but readback content does not include expected fragment","repair_instruction":"retry write and verify file content with readback"}',
            ),
          ),
      }

      const exit = yield* def
        .execute(
          {
            description: "write demo file",
            prompt: "Write /tmp/demo.txt content",
            subagent_type: "coder",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "orchestrator",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const message = String(Cause.squash(exit.cause))
        expect(message).toContain("[file_write_verification_failed]")
        expect(message).toContain('"tool_name":"write"')
        expect(message).toContain('"/tmp/demo.txt"')
      }
    }),
  )

  it.instance("coder cannot write outside worktree allowed_search_roots", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const workspace = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "task-worktree-guard-")))
      const sandboxRoot = path.join(workspace, "run", "sandbox")
      const allowedFile = path.join(sandboxRoot, "app", "ssl", "server.key")
      const outsideFile = path.join(workspace, "outside", "server.key")
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text", text: template }]),
        prompt: (input) =>
          Effect.gen(function* () {
            const id = MessageID.ascending()
            const now = Date.now()
            const message: MessageV2.WithParts = {
              info: {
                id,
                role: "assistant",
                parentID: input.messageID ?? MessageID.ascending(),
                sessionID: input.sessionID,
                mode: input.agent ?? "coder",
                agent: input.agent ?? "coder",
                cost: 0,
                path: { cwd: "/tmp", root: "/tmp" },
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                modelID: input.model?.modelID ?? ref.modelID,
                providerID: input.model?.providerID ?? ref.providerID,
                time: { created: now },
                finish: "stop",
              },
              parts: [
                {
                  id: PartID.ascending(),
                  messageID: id,
                  sessionID: input.sessionID,
                  type: "tool",
                  tool: "write",
                  callID: "call-write-outside",
                  state: {
                    status: "completed",
                    input: { filePath: outsideFile, content: "ok" },
                    output: "Wrote file successfully.",
                    metadata: {
                      filepath: outsideFile,
                      exists: false,
                      verification: {
                        file_path: outsideFile,
                        mtime_ms: now,
                        sha256: "abc123",
                        readback_fragment: "ok",
                      },
                    },
                    title: outsideFile,
                    time: { start: now - 10, end: now },
                  },
                } satisfies MessageV2.ToolPart,
                {
                  id: PartID.ascending(),
                  messageID: id,
                  sessionID: input.sessionID,
                  type: "text",
                  text: `created ${outsideFile} and ${allowedFile}`,
                },
              ],
            }
            yield* sessions.updateMessage(message.info)
            for (const part of message.parts) {
              yield* sessions.updatePart(part as any)
            }
            return message
          }),
      }

      const exit = yield* def
        .execute(
          {
            description: "write sandbox file",
            prompt: [
              `Write only ${allowedFile}.`,
              "<path_context>",
              JSON.stringify(
                {
                  required_paths: [allowedFile],
                  fallback_paths: [],
                  actual_output_paths: [],
                  allowed_search_roots: [path.dirname(allowedFile)],
                  forbidden_search_roots: ["/"],
                },
                null,
                2,
              ),
              "</path_context>",
            ].join("\n"),
            subagent_type: "coder",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "orchestrator",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const message = String(Cause.squash(exit.cause))
        expect(message).toContain("[wrong_path]")
        expect(message).toContain("outside allowed search roots")
        expect(message).toContain(outsideFile)
      }
    }),
  )

  it.instance("rejects coder stale artifact paths for /app required outputs", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const promptOps = stubOps({
        text: "Done. Reused packages/codemate/ssl/server.crt and test/certs/check_cert.py artifacts.",
      })

      const exit = yield* def
        .execute(
          {
            description: "verify tls artifacts",
            prompt:
              "Create and verify /app/ssl/server.key /app/ssl/server.crt /app/ssl/verification.txt and /app/check_cert.py",
            subagent_type: "coder",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "orchestrator",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const message = String(Cause.squash(exit.cause))
        expect(message).toContain("[stale_artifact]")
        expect(message).toContain("fallback_paths")
        expect(message).toContain("allowed_fallback_paths")
        expect(message).toContain("actual_output_paths")
        expect(message).toContain("forbidden_paths_seen")
      }
    }),
  )

  it.instance("rejects coder wrong output path when /app path is required", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const promptOps = stubOps({
        text: "Created /project/verification.txt and /project/check_cert.py, done.",
      })

      const exit = yield* def
        .execute(
          {
            description: "write verification outputs",
            prompt: "Output must be /app/ssl/verification.txt and /app/check_cert.py",
            subagent_type: "coder",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "orchestrator",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const message = String(Cause.squash(exit.cause))
        expect(message).toContain("[wrong_path]")
        expect(message).toContain("/app/ssl/verification.txt")
        expect(message).toContain(`${HOME_APP}/ssl/verification.txt`)
        expect(message).toContain("fallback_paths")
        expect(message).toContain("actual_output_paths")
      }
    }),
  )

  it.instance("accepts absolute HOME fallback paths for tls artifacts", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const promptOps = stubOps({
        text: `Created ${HOME_APP}/ssl/server.key, ${HOME_APP}/ssl/server.crt, ${HOME_APP}/ssl/server.pem, ${HOME_APP}/ssl/verification.txt and ${HOME_APP}/check_cert.py`,
      })

      const result = yield* def.execute(
        {
          description: "generate tls outputs",
          prompt: "Create /app/ssl/server.key /app/ssl/server.crt /app/ssl/server.pem /app/ssl/verification.txt and /app/check_cert.py",
          subagent_type: "coder",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "orchestrator",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.output).toContain("<task_result>")
    }),
  )

  it.instance("injects PathContext absolute path constraints into coder runtime prompt", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seenPrompt = ""
      const promptOps = stubOps({
        onPrompt: (input) => {
          seenPrompt = input.parts
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("\n")
        },
      })

      yield* def.execute(
        {
          description: "create tls certs",
          prompt: "Use openssl and create /app/ssl/server.key with verification output.",
          subagent_type: "coder",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "orchestrator",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(seenPrompt).toContain("Path constraints for this task:")
      expect(seenPrompt).toContain("/app/ssl/server.key")
      expect(seenPrompt).toContain(`${HOME_APP}/ssl/server.key`)
      expect(seenPrompt).toContain("target_paths (apply targets)")
      expect(seenPrompt).toContain("sandbox_paths (execution-only writable paths)")
      expect(seenPrompt).toContain("execution coder, not a tutorial writer")
      expect(seenPrompt).toContain("Do not merely describe commands, scripts, or steps as completion.")
      expect(seenPrompt).toContain("Script-only output is not completion unless the task explicitly requires script-only artifact output.")
      expect(seenPrompt).toContain("fallback_paths (absolute)")
    }),
  )

  it.instance("search_scope_forbidden: Glob \"ssl\" in \"/\" is blocked", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const registry = yield* ToolRegistry.Service
      const agent = yield* Agent.Service
      const orchestrator = yield* agent.get("orchestrator")
      const globTool = (yield* registry.tools({ ...ref, agent: orchestrator })).find((tool) => tool.id === "glob")
      expect(globTool).toBeDefined()
      if (!globTool) return
      const exit = yield* globTool
        .execute(
          { pattern: "**/ssl/**", path: "/" },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "orchestrator",
            abort: new AbortController().signal,
            extra: {},
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const message = String(Cause.squash(exit.cause))
        expect(message).toContain("search_scope_forbidden")
      }
    }),
  )
})
