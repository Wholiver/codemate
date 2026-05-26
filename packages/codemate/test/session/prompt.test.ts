import { NodeFileSystem } from "@effect/platform-node"
import { FetchHttpClient } from "effect/unstable/http"
import { afterEach, expect, spyOn } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import path from "path"
import fs from "fs/promises"
import os from "os"
import { fileURLToPath } from "url"
import { NamedError } from "@codemate-ai/core/util/error"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Session } from "@/session/session"
import { SessionMessageTable } from "../../src/session/session.sql"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { AppFileSystem } from "@codemate-ai/core/filesystem"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import * as SessionClosedLoop from "../../src/session/closed-loop"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionV2 } from "../../src/v2/session"
import { Skill } from "../../src/skill"
import { MemoryRuntime } from "../../src/memory/runtime"
import { SystemPrompt } from "../../src/session/system"
import { Shell } from "../../src/shell/shell"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import type { Tool } from "@/tool/tool"
import { WriteTool } from "@/tool/write"
import { EditTool } from "@/tool/edit"
import { Truncate } from "@/tool/truncate"
import * as Log from "@codemate-ai/core/util/log"
import { CrossSpawnSpawner } from "@codemate-ai/core/cross-spawn-spawner"
import * as Database from "../../src/storage/db"
import { Ripgrep } from "../../src/file/ripgrep"
import { Format } from "../../src/format"
import { Reference } from "../../src/reference/reference"
import { createTrajectoryRecord, filterTrajectoryByRun } from "@/session/trajectory"
import { deriveLessonProposalsFromTrajectory } from "@/session/lesson-proposal"
import { createPathContext, extractRequiredPaths, parsePathContextBlock, renderPathContextBlock } from "@/session/path-context"
import { provideTmpdirInstance, provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { SyncEvent } from "@/sync"

void Log.init({ print: false })

let summaryDiffFixture: Array<{ file?: string; additions: number; deletions: number; status?: "added" | "deleted" | "modified" }> = []
afterEach(() => {
  summaryDiffFixture = []
})

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed(summaryDiffFixture),
    computeDiff: () => Effect.succeed(summaryDiffFixture),
  }),
)

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}
const HOME_APP = `${os.homedir().replaceAll("\\", "/").replace(/\/+$/, "")}/app`

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function withSh<A, E, R>(fx: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.env.SHELL
      process.env.SHELL = "/bin/sh"
      Shell.preferred.reset()
      return prev
    }),
    () => fx(),
    (prev) =>
      Effect.sync(() => {
        if (prev === undefined) delete process.env.SHELL
        else process.env.SHELL = prev
        Shell.preferred.reset()
      }),
  )
}

function toolPart(parts: MessageV2.Part[]) {
  return parts.find((part): part is MessageV2.ToolPart => part.type === "tool")
}

type CompletedToolPart = MessageV2.ToolPart & { state: MessageV2.ToolStateCompleted }
type ErrorToolPart = MessageV2.ToolPart & { state: MessageV2.ToolStateError }

function completedTool(parts: MessageV2.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("completed")
  return part?.state.status === "completed" ? (part as CompletedToolPart) : undefined
}

function errorTool(parts: MessageV2.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("error")
  return part?.state.status === "error" ? (part as ErrorToolPart) : undefined
}

function bodyText(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map((item) => bodyText(item)).join("\n")
  if (!value || typeof value !== "object") return ""
  return Object.values(value as Record<string, unknown>)
    .map((item) => bodyText(item))
    .join("\n")
}

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
    authenticate: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const status = SessionStatus.layer.pipe(Layer.provideMerge(Bus.layer))
const run = SessionRunState.layer.pipe(Layer.provide(status))
const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)
function makeHttp() {
  const deps = Layer.mergeAll(
    Session.defaultLayer,
    Snapshot.defaultLayer,
    LLM.defaultLayer,
    Env.defaultLayer,
    AgentSvc.defaultLayer,
    Command.defaultLayer,
    Permission.defaultLayer,
    Plugin.defaultLayer,
    Config.defaultLayer,
    ProviderSvc.defaultLayer,
    lsp,
    mcp,
    AppFileSystem.defaultLayer,
    status,
    SyncEvent.defaultLayer,
  ).pipe(Layer.provideMerge(infra))
  const question = Question.layer.pipe(Layer.provideMerge(deps))
  const todo = Todo.layer.pipe(Layer.provideMerge(deps))
  const registry = ToolRegistry.layer.pipe(
    Layer.provide(Skill.defaultLayer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(CrossSpawnSpawner.defaultLayer),
    Layer.provide(Git.defaultLayer),
    Layer.provide(Reference.defaultLayer),
    Layer.provide(Ripgrep.defaultLayer),
    Layer.provide(Format.defaultLayer),
    Layer.provide(SessionClosedLoop.defaultLayer),
    Layer.provideMerge(todo),
    Layer.provideMerge(question),
    Layer.provideMerge(deps),
  )
  const trunc = Truncate.layer.pipe(Layer.provideMerge(deps))
  const proc = SessionProcessor.layer.pipe(
    Layer.provide(summary),
    Layer.provide(Image.defaultLayer),
    Layer.provideMerge(deps),
  )
  const compact = SessionCompaction.layer.pipe(Layer.provideMerge(proc), Layer.provideMerge(deps))
  return Layer.mergeAll(
    TestLLMServer.layer,
    SessionPrompt.layer.pipe(
      Layer.provide(SessionRevert.defaultLayer),
      Layer.provide(Image.defaultLayer),
      Layer.provide(summary),
      Layer.provide(Question.defaultLayer),
      Layer.provide(SessionClosedLoop.defaultLayer),
      Layer.provideMerge(run),
      Layer.provideMerge(compact),
      Layer.provideMerge(proc),
      Layer.provideMerge(registry),
      Layer.provideMerge(trunc),
      Layer.provide(Instruction.defaultLayer),
      Layer.provide(SystemPrompt.defaultLayer),
      Layer.provideMerge(deps),
    ),
  ).pipe(Layer.provide(summary))
}

const it = testEffect(makeHttp())
const unix = process.platform !== "win32" ? it.live : it.live.skip

// Config that registers a custom "test" provider with a "test-model" model
// so provider model lookup succeeds inside the loop.
const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: {
          ...cfg.provider.test.options,
          baseURL: url,
        },
      },
    },
  }
}

const user = Effect.fn("test.user")(function* (sessionID: SessionID, text: string, agent: string = "orchestrator") {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent,
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

function intentHash(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (!normalized) return "ia:empty"
  let hash = 2166136261
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `ia:${(hash >>> 0).toString(16)}`
}

const seed = Effect.fn("test.seed")(function* (sessionID: SessionID, opts?: { finish?: string }) {
  const session = yield* Session.Service
  const msg = yield* user(sessionID, "hello")
  const assistant: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: msg.id,
    sessionID,
    mode: "orchestrator",
    agent: "orchestrator",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
    ...(opts?.finish ? { finish: opts.finish } : {}),
  }
  yield* session.updateMessage(assistant)
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID,
    type: "text",
    text: "hi there",
  })
  return { user: msg, assistant }
})

const addSubtask = (sessionID: SessionID, messageID: MessageID, model = ref) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    yield* session.updatePart({
      id: PartID.ascending(),
      messageID,
      sessionID,
      type: "subtask",
      task_role: "coder",
      prompt: "look into the cache key path",
      description: "inspect bug",
      agent: "coder",
      model,
    })
  })

const boot = Effect.fn("test.boot")(function* (input?: { title?: string }) {
  const config = yield* Config.Service
  const prompt = yield* SessionPrompt.Service
  const run = yield* SessionRunState.Service
  const sessions = yield* Session.Service
  yield* config.get()
  const chat = yield* sessions.create(input ?? { title: "Pinned" })
  return { prompt, run, sessions, chat }
})

// Loop semantics

it.instance("role boundary prompt: coder is implementation-only and not drift/review authority", () =>
  Effect.gen(function* () {
    const agents = yield* AgentSvc.Service
    const coder = yield* agents.get("coder")
    expect(coder.prompt).toContain("implementation agent")
    expect(coder.prompt).toContain("execution coder")
    expect(coder.prompt).toContain("not a tutorial writer")
    expect(coder.prompt).toContain("Do not report completion by only providing scripts, commands, tutorials")
    expect(coder.prompt).toContain("Do not perform final verification")
    expect(coder.prompt).toContain("Do not perform selfcheck or intent drift detection")
    expect(coder.prompt).toContain("local sanity checks")
  }),
)

it.instance("role boundary prompt: tester reports missing implementation back to coder", () =>
  Effect.gen(function* () {
    const agents = yield* AgentSvc.Service
    const tester = yield* agents.get("tester")
    expect(tester.prompt).toContain("responsible for requirement verification evidence")
    expect(tester.prompt).toContain("coder implementation/fix is required")
    expect(tester.prompt).toContain("Do not silently absorb missing implementation work")
  }),
)

it.instance("role boundary prompt: reviewer rejects coder self-report as final proof", () =>
  Effect.gen(function* () {
    const agents = yield* AgentSvc.Service
    const reviewer = yield* agents.get("reviewer")
    expect(reviewer.prompt).toContain("coder self-report")
    expect(reviewer.prompt).toContain("verification proof")
  }),
)

it.instance("coder prompt contains execution-not-tutorial and script-only completion rules", () =>
  Effect.gen(function* () {
    const agents = yield* AgentSvc.Service
    const coder = yield* agents.get("coder")
    expect(coder.prompt).toContain("execution coder")
    expect(coder.prompt).toContain("not a tutorial writer")
    expect(coder.prompt).toContain("Do not report completion by only providing scripts, commands, tutorials")
    expect(coder.prompt).toContain("Script file alone is not completion unless the task explicitly asks for a script-only artifact")
  }),
)

it.instance("PathContext absolute path actual_output_paths fallback path search_scope_forbidden tester evidence final summary", () =>
  Effect.sync(() => {
    const context = createPathContext({
      requiredPaths: ["/app/ssl/server.key"],
      targetPaths: ["/app/ssl/server.key"],
      sandboxPaths: ["/tmp/run/sandbox/app/ssl/server.key"],
      fallbackPaths: [`${HOME_APP}/ssl/server.key`],
      actualOutputPaths: [`${HOME_APP}/ssl/server.key`],
      projectRoot: "/tmp/project",
      forbiddenRoots: ["/", "/tmp/project/test/certs"],
    })
    const block = renderPathContextBlock(context)
    expect(block).toContain("/app/ssl/server.key")
    expect(block).toContain(`${HOME_APP}/ssl/server.key`)
    expect(block).not.toContain("~/app/ssl/server.key")
    expect(block).toContain("forbidden_search_roots")
    expect(block).toContain("actual_output_paths")
    expect(block).toContain("target_paths")
    expect(block).toContain("sandbox_paths")
  }),
)

it.instance("PathContext /task extraction excludes closing tag token but keeps explicit /task path", () =>
  Effect.sync(() => {
    const fromMarkup = extractRequiredPaths("</task>\nCreate /app/ssl/server.crt")
    expect(fromMarkup).toEqual(["/app/ssl/server.crt"])

    const fromExplicit = extractRequiredPaths("Write output to /task and /app/ssl/server.crt")
    expect(fromExplicit).toContain("/task")
    expect(fromExplicit).toContain("/app/ssl/server.crt")

    const parsed = parsePathContextBlock(
      renderPathContextBlock(
        createPathContext({
          requiredPaths: ["/app/ssl/server.crt"],
          targetPaths: ["/app/ssl/server.crt"],
          sandboxPaths: ["/tmp/worktree/sandbox/app/ssl/server.crt"],
          fallbackPaths: [],
          actualOutputPaths: [],
          projectRoot: "/tmp/project",
          forbiddenRoots: ["/"],
        }),
      ),
    )
    expect(parsed?.required_paths).toEqual(["/app/ssl/server.crt"])
    expect(parsed?.target_paths).toEqual(["/app/ssl/server.crt"])
    expect(parsed?.sandbox_paths).toEqual(["/tmp/worktree/sandbox/app/ssl/server.crt"])
  }),
)

it.live("loop exits immediately when last assistant has stop finish", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* seed(chat.id, { finish: "stop" })

      const outcome = yield* Effect.exit(prompt.loop({ sessionID: chat.id }))
      if (Exit.isFailure(outcome)) {
        const misses = yield* llm.misses
        const hits = yield* llm.hits
        const pending = yield* llm.pending
        console.error("[debug coder-only] pending", pending)
        console.error("[debug coder-only] hits", JSON.stringify(hits.map((hit) => hit.body), null, 2))
        console.error("[debug coder-only] misses", JSON.stringify(misses.map((hit) => hit.body), null, 2))
      }
      if (Exit.isFailure(outcome)) return yield* Effect.failCause(outcome.cause)
      const result = outcome.value
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") expect(result.info.finish).toBe("stop")
      expect(yield* llm.calls).toBe(0)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("path_resolution impl_cert infers target_paths app/ssl and sandbox_paths without /task default", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "path-resolution-impl-cert" })
      yield* llm.textMatch(
        (hit) => {
          const body = JSON.stringify(hit.body)
          return (
            body.includes("Create cert artifacts at expected path") &&
            body.includes("target_paths: /app/ssl/server.key, /app/ssl/server.crt, /app/ssl/server.pem, /app/ssl/verification.txt") &&
            body.includes("sandbox_paths:") &&
            body.includes("/sandbox/app/ssl/server.key") &&
            body.includes("execution coder, not a tutorial writer") &&
            body.includes("create/modify current-run files at sandbox_paths now using tools") &&
            body.includes("Script-only output is not completion unless the task explicitly asks for script-only artifact output") &&
            body.includes("Do not claim target_paths as completed in coder stage") &&
            !body.includes("target_paths: /task")
          )
        },
        "cert artifacts done",
      )
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("Persistence mode:"), "writer done")
      yield* llm.text("final done")

      const initial = yield* user(chat.id, "Generate cert artifacts and persist outputs.", "orchestrator")
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: initial.id,
        sessionID: chat.id,
        type: "subtask",
        task_role: "coder",
        task_id: "impl_cert",
        blocked_by: [],
        needs_research: false,
        tags: ["impl", "tls"],
        description: "Create cert artifacts at expected path",
        agent: "coder",
        model: ref,
        prompt: "Generate certificate artifacts for runtime use.",
      } satisfies MessageV2.SubtaskPart)
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("path_resolution impl_script infers /app/check_cert.py target path and sandbox mapping", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "path-resolution-impl-script" })
      yield* llm.textMatch(
        (hit) => {
          const body = JSON.stringify(hit.body)
          return (
            body.includes("Create cert verification script") &&
            body.includes("target_paths: /app/check_cert.py") &&
            body.includes("sandbox_paths:") &&
            body.includes("/sandbox/app/check_cert.py") &&
            body.includes("execution coder, not a tutorial writer") &&
            body.includes("create/modify current-run files at sandbox_paths now using tools") &&
            body.includes("Script-only output is not completion unless the task explicitly asks for script-only artifact output") &&
            body.includes("Do not claim target_paths as completed in coder stage") &&
            !body.includes("target_paths: /task")
          )
        },
        "script done",
      )
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("Persistence mode:"), "writer done")
      yield* llm.text("final done")

      const initial = yield* user(chat.id, "Create certificate verification script and persist outputs.", "orchestrator")
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: initial.id,
        sessionID: chat.id,
        type: "subtask",
        task_role: "coder",
        task_id: "impl_script",
        blocked_by: [],
        needs_research: false,
        tags: ["impl", "tls", "script"],
        description: "Create cert verification script",
        agent: "coder",
        model: ref,
        prompt: "Implement cert verification script for this workflow.",
      } satisfies MessageV2.SubtaskPart)
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("loop calls LLM and returns assistant message", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "orchestrator",
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      yield* llm.text("world")

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
      const parts = result.parts.filter((p) => p.type === "text")
      expect(parts.some((p) => p.type === "text" && p.text === "world")).toBe(true)
      expect(yield* llm.hits).toHaveLength(1)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("injects Chinese language rule into agent system prompt", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* llm.text("收到")
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "orchestrator",
        parts: [{ type: "text", text: "你好，请解释这个实现。" }],
      })

      const first = (yield* llm.inputs)[0]
      const body = bodyText(first)
      expect(body).toContain("LANGUAGE RULE: The user is communicating in Chinese.")
      expect(body).toContain("You MUST respond in Chinese at all times.")
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("re-detects language on new user messages and switches to English", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* llm.text("收到")
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "orchestrator",
        parts: [{ type: "text", text: "你好，先用中文回复。" }],
      })

      yield* llm.text("done")
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "orchestrator",
        parts: [{ type: "text", text: "Please answer in English now." }],
      })

      const inputs = yield* llm.inputs
      const firstBody = bodyText(inputs[0])
      const lastBody = bodyText(inputs[inputs.length - 1])
      expect(firstBody).toContain("LANGUAGE RULE: The user is communicating in Chinese.")
      expect(lastBody).toContain("LANGUAGE RULE: The user is communicating in English.")
      expect(lastBody).toContain("You MUST respond in English at all times.")
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("non-trivial build request is forced through TaskGraph closed-loop roles", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const plannerMatch = (hit: { body: unknown }) => {
        const body = JSON.stringify(hit.body)
        return body.includes("Build an executable TaskGraph")
      }
      yield* llm.textMatch(
        plannerMatch,
        JSON.stringify({
          nodes: [
            {
              id: "coder_tls",
              task_role: "coder",
              description: "Generate TLS artifacts",
              blocked_by: [],
              needs_research: false,
              tags: ["tls"],
            },
            {
              id: "review_tls",
              task_role: "reviewer",
              description: "Review generated artifacts",
              blocked_by: ["coder_tls"],
              tags: ["review"],
            },
          ],
        }),
      )
      yield* llm.textMatch(
        plannerMatch,
        JSON.stringify({
          nodes: [
            {
              id: "impl",
              task_role: "coder",
              description: "Implement run_tasks async flow",
              blocked_by: [],
              needs_research: false,
              tags: ["impl", "python"],
            },
            {
              id: "test_impl",
              task_role: "tester",
              description: "Validate run_tasks async flow",
              blocked_by: ["impl"],
              needs_research: false,
              tags: ["test"],
            },
            {
              id: "review_impl",
              task_role: "reviewer",
              description: "Review run_tasks async flow",
              blocked_by: ["test_impl"],
              tags: ["review"],
            },
          ],
        }),
      )
      yield* llm.text("coder done")
      yield* llm.text("tester done")
      yield* llm.text(JSON.stringify({ passed: true, notes: "looks good" }))
      yield* llm.text("writer done")
      yield* llm.text("final done")
      for (const fallback of [
        "fallback-1",
        "fallback-2",
        "fallback-3",
        "fallback-4",
        "fallback-5",
        "fallback-6",
        "fallback-7",
        "fallback-8",
        "fallback-9",
        "fallback-10",
      ]) {
        yield* llm.text(fallback)
      }

      const plannerUser = yield* user(
        chat.id,
        "Build a TLS setup workflow with implementation, tests, and review.",
        "orchestrator",
      )
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: plannerUser.id,
        sessionID: chat.id,
        type: "subtask",
        task_role: "planner",
        task_id: "planner:seed_non_trivial_build",
        blocked_by: [],
        tags: ["taskgraph", "seeded"],
        description: "Build TaskGraph",
        agent: "planner",
        model: ref,
        prompt: "Build an executable TaskGraph for this request and return JSON only.",
      } satisfies MessageV2.SubtaskPart)

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const subtasks = msgs.flatMap((msg) =>
        msg.parts.filter((part): part is MessageV2.SubtaskPart => part.type === "subtask"),
      )
      expect(subtasks.some((part) => part.task_role === "planner")).toBe(true)
      expect(subtasks.some((part) => part.task_role === "coder")).toBe(true)
      expect(subtasks.some((part) => part.task_role === "tester")).toBe(true)
      expect(subtasks.some((part) => part.task_role === "reviewer")).toBe(true)
      const reviewerTask = subtasks.find((part) => part.task_role === "reviewer" && part.task_id === "review_tls")
      expect(reviewerTask?.blocked_by).toContain("coder_tls")
      expect(reviewerTask?.blocked_by).toContain("test_coder_tls")
      const testerTask = subtasks.find((part) => part.task_role === "tester" && part.task_id === "test_coder_tls")
      expect(testerTask?.blocked_by).toContain("coder_tls")
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("missing changelog does not block loop and lessons reminder still works", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ dir, llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* Effect.promise(() =>
        fs.mkdir(path.join(dir, ".codemate"), { recursive: true }),
      )
      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(dir, ".codemate", "lessons.jsonl"),
          `${JSON.stringify({
            id: "p2",
            tags: ["hello"],
            stack: [],
            fingerprint: "project|hello|world",
            lesson: "hello world preferences should be retained for follow-up requests.",
            detail: "",
            fix: "Prefer clear blocked_by edges.",
            created_at: Date.now(),
          })}\n`,
        ),
      )

      yield* llm.text("done")
      yield* user(chat.id, "hello world", "orchestrator")
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      const inputs = yield* llm.inputs
      const body = JSON.stringify(inputs.at(-1) ?? {})
      expect(body).toContain("Reusable lessons loaded at task start from previous runs")
      expect(body).not.toContain("Relevant patterns for this task:")
      expect(body).not.toContain("Recent project changelog, for historical context only")
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("v2 reusable lessons inject structured format and filter inactive/no-op globals", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ dir, llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const now = new Date().toISOString()
      const makeRecord = (input: {
        id: string
        scope: "project" | "global"
        status?: "active" | "quarantined" | "deprecated"
        summary: string
        tags: string[]
        appliesWhen?: string[]
        do?: string[]
        dont?: string[]
        confidence?: number
      }) =>
        JSON.stringify({
          id: input.id,
          version: 2,
          scope: input.scope,
          type: "workflow_rule",
          status: input.status ?? "active",
          summary: input.summary,
          tags: input.tags,
          applies_when: input.appliesWhen ?? [],
          do: input.do ?? [input.summary],
          dont: input.dont ?? [],
          quality: { source: "legacy_migration", confidence: input.confidence ?? 0.45, evidence: ["fixture"] },
          source: { tool: "legacy" },
          created_at: now,
          updated_at: now,
          fingerprint: `${input.id}|fingerprint`,
        })

      yield* Effect.promise(() => fs.mkdir(path.join(dir, ".codemate"), { recursive: true }))
      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(dir, ".codemate", "lessons.jsonl"),
          [
            makeRecord({
              id: "p-v2-active",
              scope: "project",
              summary: "phase1-project-active summary",
              tags: ["phase1", "project"],
              appliesWhen: ["when request includes phase1 token"],
              do: ["preserve deterministic output order"],
              dont: ["do not skip package typecheck"],
              confidence: 0.72,
            }),
          ].join("\n") + "\n",
        ),
      )
      const globalLessonsFile = path.join(process.env["XDG_DATA_HOME"] ?? "", "codemate", "lessons", "global.jsonl")
      yield* Effect.promise(() => fs.mkdir(path.dirname(globalLessonsFile), { recursive: true }))
      yield* Effect.promise(() =>
        fs.writeFile(
          globalLessonsFile,
          [
            makeRecord({
              id: "g-v2-active",
              scope: "global",
              summary: "phase1-global-active summary",
              tags: ["phase1", "global"],
              appliesWhen: ["when request includes phase1 token"],
              do: ["reuse stable verification commands"],
              dont: ["do not invent missing flags"],
              confidence: 0.92,
            }),
            makeRecord({
              id: "g-v2-low-confidence",
              scope: "global",
              summary: "phase1-global-low-confidence should-not-inject",
              tags: ["phase1", "global"],
              appliesWhen: ["when request includes phase1 token"],
              confidence: 0.79,
            }),
            makeRecord({
              id: "g-v2-deprecated",
              scope: "global",
              status: "deprecated",
              summary: "phase1-global-deprecated should-not-inject",
              tags: ["phase1", "global"],
            }),
            makeRecord({
              id: "g-v2-quarantined",
              scope: "global",
              status: "quarantined",
              summary: "phase1-global-quarantined should-not-inject",
              tags: ["phase1", "global"],
            }),
            makeRecord({
              id: "g-v2-noop",
              scope: "global",
              summary: "phase1-global-noop changed files no-op should-not-inject",
              tags: ["phase1", "persistence", "no-op"],
              do: ["changed files no-op"],
            }),
          ].join("\n") + "\n",
        ),
      )

      const chatCoder = yield* sessions.create({ title: "v2-coder" })
      yield* llm.text("coder done")
      yield* user(chatCoder.id, "please apply phase1 token rules", "coder")
      const coderResult = yield* prompt.loop({ sessionID: chatCoder.id })
      expect(coderResult.info.role).toBe("assistant")
      const coderBody = JSON.stringify((yield* llm.inputs).at(-1) ?? {})
      expect(coderBody).toContain("Reusable lessons loaded at task start from previous runs")
      expect(coderBody).toContain("Relevant patterns for this task:")
      expect(coderBody).toContain("Summary:")
      expect(coderBody).toContain("When:")
      expect(coderBody).toContain("Do:")
      expect(coderBody).toContain("Don't:")
      expect(coderBody).toContain("Scope:")
      expect(coderBody).toContain("Confidence:")
      expect(coderBody).toContain("Why relevant:")
      expect(coderBody).toContain("phase1-project-active summary")
      expect(coderBody).toContain("phase1-global-active summary")
      expect(coderBody).not.toContain("phase1-global-low-confidence should-not-inject")
      expect(coderBody).not.toContain("phase1-global-deprecated should-not-inject")
      expect(coderBody).not.toContain("phase1-global-quarantined should-not-inject")
      expect(coderBody).not.toContain("phase1-global-noop changed files no-op should-not-inject")

      yield* llm.reset
      const chatWriter = yield* sessions.create({ title: "v2-writer" })
      yield* llm.text("writer done")
      yield* user(chatWriter.id, "please apply phase1 token rules", "writer")
      const writerResult = yield* prompt.loop({ sessionID: chatWriter.id })
      expect(writerResult.info.role).toBe("assistant")
      const writerBody = JSON.stringify((yield* llm.inputs).at(-1) ?? {})
      expect(writerBody).toContain("phase1-project-active summary")
      expect(writerBody).not.toContain("phase1-global-active summary")
      expect(writerBody).not.toContain("phase1-global-low-confidence should-not-inject")
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("memory index off falls back to direct lessons retrieval and prompt format stays unchanged", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ dir, llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const now = new Date().toISOString()
      yield* Effect.promise(() => fs.mkdir(path.join(dir, ".codemate"), { recursive: true }))
      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(dir, ".codemate", "lessons.jsonl"),
          `${JSON.stringify({
            id: "off-fallback-project-lesson",
            version: 2,
            scope: "project",
            type: "workflow_rule",
            status: "active",
            summary: "off fallback project pattern summary",
            tags: ["phase1", "project", "verification"],
            applies_when: ["when request includes phase1 token and verification"],
            do: ["run deterministic verification flow"],
            dont: ["do not skip verification gate"],
            quality: { source: "legacy_migration", confidence: 0.76, evidence: ["fixture"] },
            source: { tool: "legacy" },
            created_at: now,
            updated_at: now,
            fingerprint: "off-fallback-project-lesson|fp",
          })}\n`,
        ),
      )

      const chat = yield* sessions.create({ title: "memory-index-off-fallback" })
      yield* llm.text("coder done")
      yield* user(chat.id, "please apply phase1 token verification flow", "coder")
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      const body = JSON.stringify((yield* llm.inputs).at(-1) ?? {})
      expect(body).toContain("Reusable lessons loaded at task start from previous runs")
      expect(body).toContain("Relevant patterns for this task:")
      expect(body).toContain("Summary:")
      expect(body).toContain("When:")
      expect(body).toContain("Do:")
      expect(body).toContain("Don't:")
      expect(body).toContain("Scope:")
      expect(body).toContain("Confidence:")
      expect(body).toContain("Why relevant:")
      expect(body).toContain("off fallback project pattern summary")

      const indexFile = Bun.file(path.join(dir, ".codemate", "agent-memory-index.jsonl"))
      const indexExists = yield* Effect.promise(() => indexFile.exists())
      expect(indexExists).toBe(false)
    }),
    {
      git: true,
      config: (url) => ({
        ...providerCfg(url),
        experimental: {
          agent_memory: {
            enabled: false,
            backend: "off",
          },
        },
      }),
    },
  ),
30_000)

it.live("provider route selects configured provider/model for agent role when enabled", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "provider-route-coder" })
      yield* llm.text("coder route done")
      yield* user(chat.id, "implement tiny fix", "coder")
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const assistant = msgs.findLast((item) => item.info.role === "assistant")
      expect(assistant?.info.role).toBe("assistant")
      if (!assistant || assistant.info.role !== "assistant") return
      expect(assistant.info.providerID).toBe(ProviderID.make("test-alt"))
      expect(assistant.info.modelID).toBe(ModelID.make("alt-model"))
    }),
    {
      git: true,
      config: (url) => ({
        ...providerCfg(url),
        provider: {
          ...providerCfg(url).provider,
          "test-alt": {
            name: "Test Alt",
            id: "test-alt",
            env: [],
            npm: "@ai-sdk/openai-compatible",
            models: {
              "alt-model": {
                id: "alt-model",
                name: "Alt Model",
                attachment: false,
                reasoning: false,
                temperature: false,
                tool_call: true,
                release_date: "2025-01-01",
                limit: { context: 100000, output: 10000 },
                cost: { input: 0, output: 0 },
                options: {},
              },
            },
            options: {
              apiKey: "test-key",
              baseURL: url,
            },
          },
        },
        experimental: {
          provider_routing: {
            enabled: true,
            routes: {
              coder: {
                provider: "test-alt",
                model: "alt-model",
              },
            },
          },
        },
      }),
    },
  ),
30_000)

it.live("self-study e2e: trajectory->proposal->lesson->pattern retrieval injection", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ dir, llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const registry = yield* ToolRegistry.Service
      const closedLoop = yield* Effect.gen(function* () {
        return yield* SessionClosedLoop.Service
      }).pipe(Effect.provide(SessionClosedLoop.defaultLayer))
      const tools = yield* registry.all()
      const classify = tools.find((item) => item.id === "lesson_classify")
      const write = tools.find((item) => item.id === "lesson_write")
      expect(classify).toBeDefined()
      expect(write).toBeDefined()
      if (!classify || !write) return

      const chatA = yield* sessions.create({
        title: "self-study-run-a",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const runID = "selfstudy_tls_path_run_a"
      const trajectoryA = createTrajectoryRecord({
        run_id: runID,
        task_id: "coder_tls_path_fix",
        agent: "coder",
        action_summary: "fix TLS certificate path mismatch and rerun validation",
        expected_outputs: ["~/app/ssl/server.crt"],
        actual_outputs: ["created packages/codemate/ssl/server.crt first", "corrected path to ~/app/ssl/server.crt and reran tester"],
        artifact_paths: ["packages/codemate/ssl/server.crt", "~/app/ssl/server.crt", "~/app/check_cert.py"],
        commands_run: ["python ~/app/check_cert.py", "bun test test/certs/ssl-verification.test.ts"],
        verification_results: ["tester failed on wrong path", "tester passed after path correction"],
        tool_results: [],
        outcome: "success",
        quality_signals: { command_success: true },
        failure: {
          signal: "wrong path used for TLS artifacts",
          failed_behavior: "wrote certs into stale packages/codemate/ssl directory",
        },
        recovery: {
          repair_action: "correct artifact path to ~/app/ssl and rerun tester",
          success_signal: "tester passed after retry on corrected path",
        },
        evidence_refs: ["wrong path -> corrected path"],
      })
      const trajectoryB = createTrajectoryRecord({
        run_id: runID,
        task_id: "tester_tls_path_fix",
        agent: "tester",
        action_summary: "verify TLS outputs after path correction",
        expected_outputs: [],
        actual_outputs: ["all verification checks passed"],
        artifact_paths: ["~/app/ssl/server.crt", "~/app/check_cert.py"],
        commands_run: ["python ~/app/check_cert.py"],
        verification_results: ["all tests passed", "verification passed"],
        tool_results: [],
        outcome: "success",
        quality_signals: { tester_passed: true, command_success: true, artifact_paths_verified: true },
      })
      yield* closedLoop.recordTrajectory({ sessionID: chatA.id, record: trajectoryA })
      yield* closedLoop.recordTrajectory({ sessionID: chatA.id, record: trajectoryB })
      const allTrajectory = yield* closedLoop.listTrajectory(chatA.id)
      const runTrajectory = filterTrajectoryByRun(allTrajectory, runID)
      const proposals = deriveLessonProposalsFromTrajectory(runTrajectory, { run_id: runID })
      const failureProposal = proposals.find((item) => item.proposed_type === "failure_pattern")
      expect(failureProposal).toBeDefined()
      if (!failureProposal) return
      expect(failureProposal.evidence.join(" ")).toContain("wrong path")

      const toolCtx: Tool.Context = {
        sessionID: chatA.id,
        messageID: MessageID.ascending(),
        callID: "selfstudy-lesson-tools",
        agent: "writer",
        abort: AbortSignal.any([]),
        messages: [],
        ask: () => Effect.void,
        metadata: () => Effect.void,
      }
      const lessonText =
        "For this project TLS workflow, when certificate artifacts are written to a wrong path, correct the path before rerunning verification."
      const classified = yield* classify.execute(
        {
          lesson_text: lessonText,
          error_context: "applies when tester fails due to wrong TLS artifact path",
          fix: "correct artifact path and rerun tester until pass signal appears",
        },
        toolCtx,
      )
      const classificationID = (classified.metadata as Record<string, unknown>)["classification_id"]
      const classificationScope = (classified.metadata as Record<string, unknown>)["scope"]
      expect(typeof classificationID).toBe("string")
      expect(classificationScope).toBe("project")
      if (typeof classificationID !== "string") return
      yield* write.execute(
        {
          scope: "project",
          tags: [...new Set([...failureProposal.tags, "tls", "path", "failure"])],
          lesson: lessonText,
          detail: "applies when tester fails due to wrong TLS artifact path",
          fix: "correct artifact path and rerun tester until pass signal appears",
          classification_id: classificationID,
          trajectory: {
            failed_stage: "tester",
            failed_agent: "tester",
            failure_signal: "wrong path used for TLS artifacts",
            repair_action: "correct path and rerun tester",
            success_signal: "tester passed after retry on corrected path",
            evidence_refs: failureProposal.evidence,
          },
        },
        toolCtx,
      )

      const projectLessonsFile = path.join(dir, ".codemate", "lessons.jsonl")
      const projectText = yield* Effect.promise(() => fs.readFile(projectLessonsFile, "utf8"))
      const projectLines = projectText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
      const activeProjectLesson = projectLines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((record) => record["summary"] === lessonText)
      expect(activeProjectLesson).toBeDefined()
      expect(activeProjectLesson?.["status"]).toBe("active")
      expect(activeProjectLesson?.["scope"]).toBe("project")
      const now = new Date().toISOString()
      const quarantinedProject = {
        id: "selfstudy-quarantine-project",
        version: 2,
        scope: "project",
        type: "workflow_rule",
        status: "quarantined",
        summary: "quarantined tls path recovery should-not-inject",
        tags: ["tls", "path"],
        applies_when: ["when tls path mismatch appears"],
        do: ["repair path"],
        dont: ["skip verification"],
        quality: { source: "writer_summary", confidence: 0.7, evidence: ["fixture"] },
        source: { tool: "legacy" },
        created_at: now,
        updated_at: now,
        fingerprint: "selfstudy-quarantine-project|fp",
      }
      yield* Effect.promise(() => fs.appendFile(projectLessonsFile, `${JSON.stringify(quarantinedProject)}\n`))
      const globalLessonsFile = path.join(process.env["XDG_DATA_HOME"] ?? "", "codemate", "lessons", "global.jsonl")
      yield* Effect.promise(() => fs.mkdir(path.dirname(globalLessonsFile), { recursive: true }))
      const globalHigh = {
        id: "selfstudy-global-high",
        version: 2,
        scope: "global",
        type: "workflow_rule",
        status: "active",
        summary: "global tls path mismatch high-confidence pattern",
        tags: ["tls", "path", "global"],
        applies_when: ["when tls path mismatch requires cross-project fallback"],
        do: ["use deterministic tls path correction flow"],
        dont: ["do not keep stale cert output path"],
        quality: { source: "reviewer_confirmed", confidence: 0.91, evidence: ["fixture"] },
        source: { tool: "legacy" },
        created_at: now,
        updated_at: now,
        fingerprint: "selfstudy-global-high|fp",
      }
      const globalLow = {
        id: "selfstudy-global-low",
        version: 2,
        scope: "global",
        type: "workflow_rule",
        status: "active",
        summary: "global tls path mismatch low-confidence should-not-inject",
        tags: ["tls", "path", "global"],
        applies_when: ["when tls path mismatch requires cross-project fallback"],
        do: ["use fallback"],
        dont: ["skip checks"],
        quality: { source: "legacy_migration", confidence: 0.79, evidence: ["fixture"] },
        source: { tool: "legacy" },
        created_at: now,
        updated_at: now,
        fingerprint: "selfstudy-global-low|fp",
      }
      yield* Effect.promise(() => fs.writeFile(globalLessonsFile, `${JSON.stringify(globalHigh)}\n${JSON.stringify(globalLow)}\n`))

      const chatCoder = yield* sessions.create({ title: "self-study-run-b-coder" })
      yield* llm.text("coder follow-up done")
      yield* user(chatCoder.id, "handle TLS wrong path mismatch and rerun certificate verification", "coder")
      const coderResult = yield* prompt.loop({ sessionID: chatCoder.id })
      expect(coderResult.info.role).toBe("assistant")
      const coderBody = JSON.stringify((yield* llm.inputs).at(-1) ?? {})
      expect(coderBody).toContain("Relevant patterns for this task:")
      expect(coderBody).toContain("Summary:")
      expect(coderBody).toContain("When:")
      expect(coderBody).toContain("Do:")
      expect(coderBody).toContain("Don't:")
      expect(coderBody).toContain("Why relevant:")
      expect(coderBody).toContain(lessonText)
      expect(coderBody).toContain("global tls path mismatch high-confidence pattern")
      expect(coderBody).not.toContain("global tls path mismatch low-confidence should-not-inject")
      expect(coderBody).not.toContain("quarantined tls path recovery should-not-inject")
      expect(coderBody).toContain("Reusable lessons loaded at task start from previous runs")

      yield* llm.reset
      const chatWriter = yield* sessions.create({ title: "self-study-run-b-writer" })
      yield* llm.text("writer follow-up done")
      yield* user(chatWriter.id, "handle TLS wrong path mismatch and rerun certificate verification", "writer")
      const writerResult = yield* prompt.loop({ sessionID: chatWriter.id })
      expect(writerResult.info.role).toBe("assistant")
      const writerBody = JSON.stringify((yield* llm.inputs).at(-1) ?? {})
      expect(writerBody).toContain("Relevant patterns for this task:")
      expect(writerBody).toContain(lessonText)
      expect(writerBody).not.toContain("global tls path mismatch high-confidence pattern")
      expect(writerBody).not.toContain("global tls path mismatch low-confidence should-not-inject")
      expect(writerBody).toContain("Reusable lessons loaded at task start from previous runs")
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("failure recovery selfcheck fail-retry-pass candidate appears in writer payload", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const closedLoop = yield* Effect.gen(function* () {
        return yield* SessionClosedLoop.Service
      }).pipe(Effect.provide(SessionClosedLoop.defaultLayer))
      const chat = yield* sessions.create({
        title: "failure-recovery-selfcheck-candidate",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const seededRunID = "seeded_failure_recovery_selfcheck"
      yield* closedLoop.startRun({
        sessionID: chat.id,
        run_id: seededRunID,
        source_message_id: MessageID.ascending(),
        intent_anchor_hash: "ia:seeded-selfcheck",
      })
      const longSignal =
        "SELFCHK_TRACE_BEGIN " +
        "x".repeat(420) +
        " SELFCHK_TRACE_END_UNIQUE_SHOULD_NOT_FULLY_APPEAR"
      yield* closedLoop.recordFailureEvent({
        sessionID: chat.id,
        run_id: seededRunID,
        failed_stage: "selfcheck",
        failed_agent: "orchestrator",
        failure_signal: `selfcheck failed before retry: ${longSignal}`,
        evidence_refs: [longSignal],
      })
      yield* closedLoop.resolveFailureEvent({
        sessionID: chat.id,
        run_id: seededRunID,
        failed_stage: "selfcheck",
        failed_agent: "orchestrator",
        repair_action: "fix issue and rerun selfcheck",
        success_signal: "selfcheck passed after retry",
        evidence_refs: ["selfcheck rerun succeeded"],
      })
      yield* llm.textMatch((hit: { body: unknown }) => JSON.stringify(hit.body).includes("Apply tiny improvement"), "coder done")
      yield* llm.textMatch(
        (hit: { body: unknown }) => JSON.stringify(hit.body).includes("Write tests for: Apply tiny improvement"),
        "tester done",
      )
      yield* llm.text("initial response complete")
      yield* llm.textMatch((hit: { body: unknown }) => JSON.stringify(hit.body).includes("Persistence mode:"), "writer persisted")
      const initial = yield* user(chat.id, "Make a tiny improvement and finish.", "orchestrator")
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: initial.id,
        sessionID: chat.id,
        type: "subtask",
        task_role: "coder",
        task_id: "seeded:coder:failure-recovery",
        blocked_by: [],
        tags: ["impl"],
        description: "Apply tiny improvement",
        agent: "coder",
        model: ref,
        prompt: "Apply tiny improvement for failure recovery test.",
      } satisfies MessageV2.SubtaskPart)
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      const writerBody = JSON.stringify(
        (yield* llm.inputs).find((input: unknown) => JSON.stringify(input).includes("Persistence mode:")) ?? {},
      )
      expect(writerBody).toContain("Failure recovery candidates:")
      expect(writerBody).toContain("Failed stage: selfcheck")
      expect(writerBody).toContain("Failure signal:")
      expect(writerBody).toContain("Success signal:")
      expect(writerBody).toContain("Evidence:")
      expect(writerBody).toContain(
        "You may claim a failure_pattern lesson came from failure recovery only when supported by listed candidates.",
      )
      expect(writerBody).not.toContain("SELFCHK_TRACE_END_UNIQUE_SHOULD_NOT_FULLY_APPEAR")
    }) as any,
    { git: true, config: providerCfg },
  ),
30_000)

it.live("failure recovery tester fail-pass candidate appears in writer payload", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const closedLoop = yield* Effect.gen(function* () {
        return yield* SessionClosedLoop.Service
      }).pipe(Effect.provide(SessionClosedLoop.defaultLayer))
      const chat = yield* sessions.create({
        title: "failure-recovery-tester-candidate",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const seededRunID = "seeded_failure_recovery_tester"
      yield* closedLoop.startRun({
        sessionID: chat.id,
        run_id: seededRunID,
        source_message_id: MessageID.ascending(),
        intent_anchor_hash: "ia:seeded-tester",
      })
      yield* closedLoop.recordFailureEvent({
        sessionID: chat.id,
        run_id: seededRunID,
        failed_stage: "tester",
        failed_agent: "tester",
        failure_signal: "tester failed due to assertion mismatch",
        evidence_refs: ["suite A failed"],
      })
      yield* closedLoop.resolveFailureEvent({
        sessionID: chat.id,
        run_id: seededRunID,
        failed_stage: "tester",
        failed_agent: "tester",
        repair_action: "apply fix and rerun tester",
        success_signal: "tester passed after fix",
        evidence_refs: ["suite A passed"],
      })
      yield* llm.textMatch((hit: { body: unknown }) => JSON.stringify(hit.body).includes("Apply tiny improvement"), "coder done")
      yield* llm.textMatch(
        (hit: { body: unknown }) => JSON.stringify(hit.body).includes("Write tests for: Apply tiny improvement"),
        "tester done",
      )
      yield* llm.text("post tester summary")
      yield* llm.textMatch((hit: { body: unknown }) => JSON.stringify(hit.body).includes("Persistence mode:"), "writer persisted")
      const initial = yield* user(chat.id, "Make a tiny improvement and finish.", "orchestrator")
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: initial.id,
        sessionID: chat.id,
        type: "subtask",
        task_role: "coder",
        task_id: "seeded:coder:failure-recovery-tester",
        blocked_by: [],
        tags: ["impl"],
        description: "Apply tiny improvement",
        agent: "coder",
        model: ref,
        prompt: "Apply tiny improvement for failure recovery tester candidate test.",
      } satisfies MessageV2.SubtaskPart)
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      const writerBody = JSON.stringify(
        (yield* llm.inputs).find((input: unknown) => JSON.stringify(input).includes("Persistence mode:")) ?? {},
      )
      expect(writerBody).toContain("Failure recovery candidates:")
      expect(writerBody).toContain("Failed stage: tester")
      expect(writerBody).toContain("Failure signal:")
      expect(writerBody).toContain("Success signal:")
    }) as any,
    { git: true, config: providerCfg },
  ),
30_000)

it.live("failure recovery writer payload shows none available when no candidate exists", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "failure-recovery-none",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes('subagent_type":"coder"'), "coder done")
      yield* llm.text("done")
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("Persistence mode:"), "writer done")
      const initial = yield* user(chat.id, "Finish this run.", "orchestrator")
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: initial.id,
        sessionID: chat.id,
        type: "subtask",
        task_role: "coder",
        task_id: "seeded:coder:none",
        blocked_by: [],
        tags: ["impl"],
        description: "Apply tiny no-op-safe update",
        agent: "coder",
        model: ref,
        prompt: "Apply tiny update for writer payload none-available test.",
      } satisfies MessageV2.SubtaskPart)
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      const writerBody = JSON.stringify((yield* llm.inputs).find((input) => JSON.stringify(input).includes("Persistence mode:")) ?? {})
      expect(writerBody).toContain("Failure recovery candidates: none available.")
      expect(writerBody).not.toContain("Failed stage:")
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("trajectory payload prefers current-run ssl evidence over stale workspace files", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ dir, llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "writer-evidence-trajectory" })

      const staleDir = path.join(dir, "packages", "codemate", "ssl")
      yield* Effect.promise(() => fs.mkdir(staleDir, { recursive: true }))
      yield* Effect.promise(() => fs.writeFile(path.join(staleDir, "server.crt"), "stale cert"))

      yield* llm.textMatch(
        (hit) => JSON.stringify(hit.body).includes("You are `coder`"),
        [
          "created ~/app/ssl/server.key with 600 permissions",
          "created ~/app/ssl/server.crt with O=DevOps Team, CN=dev-internal.company.local",
          "created ~/app/ssl/server.pem",
          "created ~/app/ssl/verification.txt",
          "created ~/app/check_cert.py",
        ].join("\n"),
      )
      yield* llm.textMatch(
        (hit) => JSON.stringify(hit.body).includes("You are `tester`"),
        ["python ~/app/check_cert.py", "all tests passed", "verification passed"].join("\n"),
      )
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("You are `reviewer`"), JSON.stringify({ passed: true, notes: "approved" }))
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("Persistence mode:"), "writer done")
      yield* llm.text("final done")

      yield* user(
        chat.id,
        "Generate TLS cert files in /app/ssl or fallback ~/app/ssl, then verify with check_cert.py and persist outputs.",
        "orchestrator",
      )
      const initial = (yield* MessageV2.filterCompactedEffect(chat.id)).findLast((message) => message.info.role === "user")
      expect(initial).toBeDefined()
      if (!initial || initial.info.role !== "user") return
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: initial.info.id,
        sessionID: chat.id,
        type: "subtask",
        task_role: "coder",
        task_id: "coder_tls",
        blocked_by: [],
        needs_research: false,
        tags: ["tls"],
        description: "Generate TLS artifacts in home fallback path",
        agent: "coder",
        model: ref,
        prompt: "Generate TLS cert files in /app/ssl or fallback ~/app/ssl and create check_cert.py.",
      } satisfies MessageV2.SubtaskPart)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: initial.info.id,
        sessionID: chat.id,
        type: "subtask",
        task_role: "tester",
        task_id: "tester_tls",
        blocked_by: ["coder_tls"],
        needs_research: false,
        tags: ["test", "tls"],
        description: "Verify TLS artifacts and check_cert script",
        agent: "tester",
        model: ref,
        prompt: "Run verification for generated TLS artifacts.",
      } satisfies MessageV2.SubtaskPart)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: initial.info.id,
        sessionID: chat.id,
        type: "subtask",
        task_role: "reviewer",
        task_id: "reviewer_tls",
        blocked_by: ["tester_tls"],
        tags: ["review", "tls"],
        description: "Review TLS artifact correctness",
        agent: "reviewer",
        model: ref,
        prompt: "Review the TLS task outputs for correctness.",
      } satisfies MessageV2.SubtaskPart)
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      const writerBody = JSON.stringify((yield* llm.inputs).find((input) => JSON.stringify(input).includes("Persistence mode:")) ?? {})
      expect(writerBody).toContain("Execution evidence from this run:")
      expect(writerBody).toContain("~/app/ssl/server.key")
      expect(writerBody).toContain("~/app/ssl/server.crt")
      expect(writerBody).toContain("~/app/check_cert.py")
      expect(writerBody).toContain("tester_passed=true")
      expect(writerBody).toContain("reviewer_approved=true")
      expect(writerBody).toContain("Lesson proposals from trajectory:")
      expect(writerBody).toContain("Type:")
      expect(writerBody).toContain("Evidence:")
      expect(writerBody).toContain("Confidence:")
      expect(writerBody).toContain("Every proposal you choose must still go through lesson_classify before lesson_write, and lesson_write must include classification_id.")
      expect(writerBody).toContain("Use Execution evidence as source of truth.")
      expect(writerBody).not.toContain("packages/codemate/ssl/server.crt")
      expect(writerBody).not.toContain("ssl/certs/server.crt")
      expect(writerBody).not.toContain("test/certs/server.crt")
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("drift guard: TLS verification artifacts are not treated as intent drift", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "drift-guard-tls-artifacts" })
      const plannerNodes = [
        "generate server.key",
        "generate server.crt",
        "build server.pem",
        "write verification.txt",
        "create check_cert.py",
      ]
      yield* llm.text(
        JSON.stringify({
          nodes: plannerNodes.map((description, index) => ({
            id: `coder_tls_${index + 1}`,
            task_role: "coder",
            description,
            blocked_by: [],
            needs_research: false,
            tags: ["tls", "verification"],
          })),
        }),
      )
      for (const description of plannerNodes) {
        yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes(description), `${description} done. local sanity check passed`)
      }
      yield* llm.textMatch(
        (hit) => {
          const body = JSON.stringify(hit.body)
          return (
            body.includes("strict intent-drift detector") &&
            body.includes("verification.txt") &&
            body.includes("check_cert.py")
          )
        },
        JSON.stringify({
          is_drift: true,
          reason: "verification artifacts are outside implementation scope",
          evidence: ["verification.txt", "check_cert.py"],
          confidence: 0.92,
        }),
      )
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("Persistence mode:"), "writer done")
      yield* llm.text("final done")

      const plannerUser = yield* user(
        chat.id,
        "Generate TLS cert files in /app/ssl, include verification.txt and check_cert.py, then persist outputs.",
        "orchestrator",
      )
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: plannerUser.id,
        sessionID: chat.id,
        type: "subtask",
        task_role: "planner",
        task_id: "planner:drift_guard_tls_artifacts",
        blocked_by: [],
        tags: ["taskgraph", "seeded"],
        description: "Build TaskGraph",
        agent: "planner",
        model: ref,
        prompt: "Build an executable TaskGraph for this request and return JSON only.",
      } satisfies MessageV2.SubtaskPart)
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const textParts = msgs.flatMap((msg) => msg.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])))
      expect(textParts.some((text) => text.includes("Intent drift detected; scheduler paused."))).toBe(false)
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("drift guard: drift detection prompt is anchored to original request and TaskGraph context", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "drift-anchor-taskgraph" })
      const plannerNodes = [
        { id: "coder_a", description: "create cert key" },
        { id: "coder_b", description: "create cert crt" },
        { id: "coder_c", description: "assemble server.pem" },
        { id: "coder_d", description: "write verification.txt artifact" },
        { id: "coder_e", description: "create check_cert.py verifier" },
      ]
      yield* llm.text(
        JSON.stringify({
          nodes: plannerNodes.map((node) => ({
            id: node.id,
            task_role: "coder",
            description: node.description,
            blocked_by: [],
            needs_research: false,
            tags: ["tls"],
          })),
        }),
      )
      for (const node of plannerNodes) {
        yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes(node.description), `${node.description} done`)
      }
      yield* llm.textMatch(
        (hit) => {
          const body = JSON.stringify(hit.body)
          return (
            body.includes("strict intent-drift detector") &&
            body.includes("Original intent anchor:") &&
            body.includes("Explicit user request:") &&
            body.includes("TaskGraph nodes (role :: description):") &&
            body.includes("write verification.txt artifact") &&
            body.includes("create check_cert.py verifier")
          )
        },
        JSON.stringify({ is_drift: false, reason: "aligned", evidence: [], confidence: 0.1 }),
      )
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("Persistence mode:"), "writer done")
      yield* llm.text("final done")

      const plannerUser = yield* user(
        chat.id,
        "Generate TLS cert + verification artifacts, then persist. verification.txt and check_cert.py are required outputs.",
        "orchestrator",
      )
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: plannerUser.id,
        sessionID: chat.id,
        type: "subtask",
        task_role: "planner",
        task_id: "planner:drift_anchor_taskgraph",
        blocked_by: [],
        tags: ["taskgraph", "seeded"],
        description: "Build TaskGraph",
        agent: "planner",
        model: ref,
        prompt: "Build an executable TaskGraph for this request and return JSON only.",
      } satisfies MessageV2.SubtaskPart)
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("step 1 explicit memory instruction writes to supermemory", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const marker = "Relevant memory:"
      const text = "Remember this preference: default to JSON output format."
      const chatA = yield* sessions.create({ title: "Pinned" })
      yield* llm.text("done")
      yield* user(chatA.id, text, "orchestrator")

      const result = yield* prompt.loop({ sessionID: chatA.id })
      expect(result.info.role).toBe("assistant")

      const chatB = yield* sessions.create({ title: "Pinned" })
      yield* llm.text("done")
      yield* user(chatB.id, "default to JSON output format", "orchestrator")
      const resultB = yield* prompt.loop({ sessionID: chatB.id })
      expect(resultB.info.role).toBe("assistant")

      const bodies = (yield* llm.inputs).map((input) => JSON.stringify(input))
      const secondBody = bodies.findLast((body) => body.includes("default to JSON output format"))
      expect(secondBody).toBeDefined()
      if (secondBody) {
        expect(secondBody).toContain(marker)
        expect(secondBody).toContain("[preference][user]")
        expect(secondBody).toContain("default to JSON output format")
      }
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("step > 1 explicit memory instruction also writes to supermemory", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const question = yield* Question.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.tool("question", {
        questions: [
          {
            question: "Continue execution?",
            header: "Continue",
            options: [{ label: "Yes", description: "Continue running" }],
          },
        ],
      })
      yield* llm.text("done")
      yield* user(chat.id, "Proceed with the task for now.", "orchestrator")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      const pending = yield* Effect.gen(function* () {
        while (true) {
          const list = yield* question.list()
          const first = list[0]
          if (first) return first
          yield* Effect.sleep(50)
        }
      })
      yield* user(chat.id, "帮我记住：以后记得默认输出 JSON", "orchestrator")
      yield* question.reply({ requestID: pending.id, answers: [["Yes"]] })
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)

      const marker = "Relevant memory:"
      const chatFollowUp = yield* sessions.create({ title: "Pinned" })
      yield* llm.text("done")
      yield* user(chatFollowUp.id, "默认输出 JSON", "orchestrator")
      const followUp = yield* prompt.loop({ sessionID: chatFollowUp.id })
      expect(followUp.info.role).toBe("assistant")

      const bodies = (yield* llm.inputs).map((input) => JSON.stringify(input))
      const followUpBody = bodies.findLast((body) => body.includes("默认输出 JSON"))
      expect(followUpBody).toBeDefined()
      if (followUpBody) {
        expect(followUpBody).toContain(marker)
      }
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("non-memory user message does not write supermemory", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const marker = "Relevant memory:"
      const query = `zzzxqvnomemorytoken${Date.now()}`
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.text("done")
      yield* user(chat.id, "Please summarize the current progress.", "orchestrator")

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
      const chatB = yield* sessions.create({ title: "Pinned" })
      yield* llm.text("done")
      yield* user(chatB.id, query, "orchestrator")
      const resultB = yield* prompt.loop({ sessionID: chatB.id })
      expect(resultB.info.role).toBe("assistant")

      const bodies = (yield* llm.inputs).map((input) => JSON.stringify(input))
      const checkBody = bodies.findLast((body) => body.includes(query))
      expect(checkBody).toBeDefined()
      if (checkBody) {
        expect(checkBody).not.toContain(marker)
      }
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("step-1 prompt uses MemoryRuntime.beforeAgentCall reminder", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const request = "Plan TLS generation steps for me."
      const reminder =
        "<system-reminder>\nRelevant memory:\n- [rule][user] Use deterministic TLS generation flags.\n</system-reminder>"
      const beforeAgentCall = spyOn(MemoryRuntime.prototype, "beforeAgentCall").mockResolvedValue({
        records: [],
        reminder,
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => beforeAgentCall.mockRestore()))
      yield* llm.text("done")

      const userMessage = yield* user(chat.id, request, "orchestrator")
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
      expect(beforeAgentCall).toHaveBeenCalledTimes(1)
      const firstCall = beforeAgentCall.mock.calls[0]?.[0]
      expect(firstCall).toBeDefined()
      expect(firstCall?.agent).toBe("task-orchestrator")
      expect(firstCall?.query).toBe(request)
      expect(firstCall?.topK).toBe(5)
      expect(firstCall?.attribution.session_id).toBe(String(chat.id))
      expect(firstCall?.attribution.message_id).toBe(String(userMessage.id))
      expect(firstCall?.attribution.process_id).toBe("task-orchestrator")
      expect(firstCall?.attribution.agent).toBe("task-orchestrator")
      expect(firstCall?.attribution.project_id).toBeDefined()
      expect(firstCall?.attribution.project_root).toBeDefined()

      const bodies = (yield* llm.inputs).map((input) => JSON.stringify(input))
      const firstBody = bodies.find((body) => body.includes(request))
      expect(firstBody).toBeDefined()
      expect(firstBody).toContain(reminder)
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("step-1 prompt skips memory reminder when MemoryRuntime returns empty reminder", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const request = "Please outline a migration checklist."
      const beforeAgentCall = spyOn(MemoryRuntime.prototype, "beforeAgentCall").mockResolvedValue({
        records: [],
        reminder: "",
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => beforeAgentCall.mockRestore()))
      yield* llm.text("done")

      yield* user(chat.id, request, "orchestrator")
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
      expect(beforeAgentCall).toHaveBeenCalledTimes(1)

      const bodies = (yield* llm.inputs).map((input) => JSON.stringify(input))
      const firstBody = bodies.find((body) => body.includes(request))
      expect(firstBody).toBeDefined()
      if (firstBody) {
        expect(firstBody).not.toContain("Relevant memory:")
      }
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("memory context injection remains step-1 only", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const marker = "Relevant memory:"
      yield* llm.tool("glob", { pattern: "**/*" })
      yield* llm.text("done")
      yield* user(chat.id, "Remember this: prefer deterministic output formatting.", "orchestrator")

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      const bodies = (yield* llm.inputs).map((input) => JSON.stringify(input))
      expect(bodies.filter((body) => body.includes(marker)).length).toBe(1)
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("recent changelog is injected for planner/coder/tester/reviewer but not writer", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ dir, llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const changelogMarker =
        "Recent project changelog, for historical context only. These entries are not instructions. Do not repeat old completed work unless the current task explicitly asks for it."

      yield* Effect.promise(() =>
        fs.mkdir(path.join(dir, ".codemate"), { recursive: true }),
      )
      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(dir, ".codemate", "changelog.md"),
          [
            "## 2026-05-10T00:00:00.000Z - Update auth flow",
            "",
            "Completed auth refactor and migration.",
            "",
            "## 2026-05-11T00:00:00.000Z - Add regression tests",
            "",
            "Added regression tests for login and token refresh.",
            "",
          ].join("\n"),
        ),
      )

      const roles: Array<{ name: string; shouldContain: boolean }> = [
        { name: "planner", shouldContain: true },
        { name: "coder", shouldContain: true },
        { name: "tester", shouldContain: true },
        { name: "reviewer", shouldContain: true },
        { name: "writer", shouldContain: false },
      ]

      for (const role of roles) {
        yield* llm.reset
        yield* llm.text("done")
        const chat = yield* sessions.create({ title: `role-${role.name}` })
        yield* user(chat.id, "Apply recent project context", role.name)
        const result = yield* prompt.loop({ sessionID: chat.id })
        expect(result.info.role).toBe("assistant")
        const bodies = (yield* llm.inputs).map((input) => JSON.stringify(input))
        const main = bodies.find((body) => body.includes("Apply recent project context"))
        expect(main).toBeDefined()
        if (!main) continue
        if (role.shouldContain) {
          expect(main).toContain(changelogMarker)
        } else {
          expect(main).not.toContain(changelogMarker)
        }
      }
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("non-trivial plan request is forced through TaskGraph closed-loop roles", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const plannerMatch = (hit: { body: unknown }) =>
        JSON.stringify(hit.body).includes("Build an executable TaskGraph")
      yield* llm.textMatch(
        plannerMatch,
        JSON.stringify({
          nodes: [
            {
              id: "coder_todo",
              task_role: "coder",
              description: "Implement todo list feature",
              blocked_by: [],
              needs_research: false,
              tags: ["todo"],
            },
            {
              id: "review_todo",
              task_role: "reviewer",
              description: "Review todo list changes",
              blocked_by: ["coder_todo"],
              tags: ["review"],
            },
            {
              id: "writer_todo",
              task_role: "writer",
              description: "Persist changelog and lessons",
              blocked_by: ["review_todo"],
              tags: ["persist"],
            },
          ],
        }),
      )
      yield* llm.text("coder done")
      yield* llm.text("tester done")
      yield* llm.text(JSON.stringify({ passed: true, notes: "looks good" }))
      yield* llm.text("writer done")
      yield* llm.text("final done")
      for (const fallback of [
        "fallback-1",
        "fallback-2",
        "fallback-3",
        "fallback-4",
        "fallback-5",
        "fallback-6",
        "fallback-7",
        "fallback-8",
        "fallback-9",
        "fallback-10",
        "fallback-11",
        "fallback-12",
        "fallback-13",
        "fallback-14",
        "fallback-15",
      ]) {
        yield* llm.text(fallback)
      }

      const plannerUser = yield* user(
        chat.id,
        [
          "Build a todo list app with add/edit/delete and persistence.",
          "Also add tests and update docs.",
        ].join("\n"),
        "orchestrator",
      )
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: plannerUser.id,
        sessionID: chat.id,
        type: "subtask",
        task_role: "planner",
        task_id: "planner:seed_non_trivial_plan",
        blocked_by: [],
        tags: ["taskgraph", "seeded"],
        description: "Build TaskGraph",
        agent: "planner",
        model: ref,
        prompt: "Build an executable TaskGraph for this request and return JSON only.",
      } satisfies MessageV2.SubtaskPart)

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const subtasks = msgs.flatMap((msg) =>
        msg.parts.filter((part): part is MessageV2.SubtaskPart => part.type === "subtask"),
      )
      expect(subtasks.some((part) => part.task_role === "planner")).toBe(true)
      expect(subtasks.some((part) => part.task_role === "coder")).toBe(true)
      expect(subtasks.some((part) => part.task_role === "tester")).toBe(true)
      expect(subtasks.some((part) => part.task_role === "reviewer")).toBe(true)
      expect(subtasks.some((part) => part.task_role === "writer")).toBe(false)

      const hits = yield* llm.hits
      const runtimeFinalizerCalls = hits.filter((hit) => JSON.stringify(hit.body).includes("Persistence mode:"))
      expect(runtimeFinalizerCalls.length).toBeLessThanOrEqual(1)
      const graphWriterDispatches = hits.filter((hit) => JSON.stringify(hit.body).includes("<task role=\"writer\""))
      expect(graphWriterDispatches.length).toBe(0)
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("planner invalid TaskGraph JSON triggers retry before scheduler dispatch", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const plannerMatch = (hit: { body: unknown }) =>
        JSON.stringify(hit.body).includes("Build an executable TaskGraph")

      yield* llm.textMatch(
        plannerMatch,
        '{"nodes":[{"id":"impl","task_role":"coder","description":"Implement run_tasks async flow","blockedBy":"impl",test_impl,"needsResearch":false,"tags":["impl"]}]}',
      )
      yield* llm.textMatch(
        plannerMatch,
        JSON.stringify({
          nodes: [
            {
              id: "impl",
              task_role: "coder",
              description: "Implement run_tasks async flow",
              blocked_by: [],
              needs_research: false,
              tags: ["impl", "python"],
            },
            {
              id: "test_impl",
              task_role: "tester",
              description: "Validate run_tasks async flow",
              blocked_by: ["impl"],
              needs_research: false,
              tags: ["test"],
            },
            {
              id: "review_impl",
              task_role: "reviewer",
              description: "Review run_tasks async flow",
              blocked_by: ["test_impl"],
              tags: ["review"],
            },
          ],
        }),
      )
      yield* llm.text("coder done")
      yield* llm.text("tester done")
      yield* llm.text(JSON.stringify({ passed: true, notes: "ok" }))
      yield* llm.text("writer done")
      yield* llm.text("final done")
      for (const fallback of ["fallback-1", "fallback-2", "fallback-3", "fallback-4", "fallback-5"]) {
        yield* llm.text(fallback)
      }

      const plannerUser = yield* user(
        chat.id,
        "Implement run_tasks async orchestration and validate behavior with tests.",
        "orchestrator",
      )
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: plannerUser.id,
        sessionID: chat.id,
        type: "subtask",
        task_role: "planner",
        task_id: "planner:seed_invalid_json_retry",
        blocked_by: [],
        tags: ["taskgraph", "seeded"],
        description: "Build TaskGraph",
        agent: "planner",
        model: ref,
        prompt: "Build an executable TaskGraph for this request and return JSON only.",
      } satisfies MessageV2.SubtaskPart)
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      const hits = yield* llm.hits
      const plannerIndexes = hits.flatMap((hit, index) => (plannerMatch(hit) ? [index] : []))
      expect(plannerIndexes.length).toBeGreaterThanOrEqual(2)

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const plannerInvalid = msgs
        .flatMap((msg) => msg.parts)
        .filter((part): part is MessageV2.TextPart => part.type === "text" && part.synthetic === true)
        .some((part) => part.text.includes('"type": "planner_taskgraph_invalid"'))
      expect(plannerInvalid).toBe(true)
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("single writer TaskGraph: agent=writer planner node is removed and runtime finalizer is the only writer", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "single-writer-agent-node" })
      const plannerMatch = (hit: { body: unknown }) =>
        JSON.stringify(hit.body).includes("Build an executable TaskGraph")

      yield* llm.textMatch(
        plannerMatch,
        JSON.stringify({
          nodes: [
            {
              id: "impl_todo",
              task_role: "coder",
              description: "Implement todo list feature",
              blocked_by: [],
              needs_research: false,
              tags: ["impl"],
            },
            {
              id: "review_todo",
              task_role: "reviewer",
              description: "Review todo list changes",
              blocked_by: ["impl_todo"],
              tags: ["review"],
            },
            {
              id: "persist_misrole",
              task_role: "coder",
              agent: "writer",
              description: "GRAPH_WRITER_AGENT_NODE_SHOULD_NOT_DISPATCH",
              blocked_by: ["review_todo"],
              tags: ["persist"],
            },
          ],
        }),
      )
      yield* llm.text("coder done")
      yield* llm.text("tester done")
      yield* llm.text(JSON.stringify({ passed: true, notes: "ok" }))
      yield* llm.text("writer done")
      yield* llm.text("final done")

      const plannerUser = yield* user(
        chat.id,
        "Build a todo list app with add/edit/delete and persistence.",
        "orchestrator",
      )
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: plannerUser.id,
        sessionID: chat.id,
        type: "subtask",
        task_role: "planner",
        task_id: "planner:seed_single_writer_agent_node",
        blocked_by: [],
        tags: ["taskgraph", "seeded"],
        description: "Build TaskGraph",
        agent: "planner",
        model: ref,
        prompt: "Build an executable TaskGraph for this request and return JSON only.",
      } satisfies MessageV2.SubtaskPart)

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const subtasks = msgs.flatMap((msg) =>
        msg.parts.filter((part): part is MessageV2.SubtaskPart => part.type === "subtask"),
      )
      expect(subtasks.some((part) => (part.task_id ?? part.id).includes("persist_misrole"))).toBe(false)
      expect(subtasks.some((part) => part.task_role === "writer")).toBe(false)

      const hits = yield* llm.hits
      const runtimeFinalizerCalls = hits.filter((hit) => JSON.stringify(hit.body).includes("Persistence mode:"))
      expect(runtimeFinalizerCalls.length).toBeLessThanOrEqual(1)
      const graphWriterDispatches = hits.filter((hit) =>
        JSON.stringify(hit.body).includes("GRAPH_WRITER_AGENT_NODE_SHOULD_NOT_DISPATCH"),
      )
      expect(graphWriterDispatches.length).toBe(0)
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("planner malformed blockedBy JSON is repaired for TLS task graph", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const plannerMatch = (hit: { body: unknown }) =>
        JSON.stringify(hit.body).includes("Build an executable TaskGraph")

      yield* llm.textMatch(
        plannerMatch,
        '{"nodes":[{"id":"generate_key","task_role":"coder","description":"Generate TLS private key","blocked_by":[],"needs_research":false,"tags":["tls"]},{"id":"create_cert","task_role":"coder","description":"Create TLS certificate","blocked_by":[],"needs_research":false,"tags":["tls"]},{"id":"test_cert","task_role":"tester","description":"Verify TLS certificate outputs","blockedBy":"generate_key","create_cert","needsResearch":false,"tags":["test"]},{"id":"review_tls","task_role":"reviewer","description":"Review TLS workflow","blocked_by":["test_cert"],"tags":["review"]}]}',
      )
      yield* llm.textMatch(
        plannerMatch,
        JSON.stringify({
          nodes: [
            {
              id: "generate_key",
              task_role: "coder",
              description: "Generate TLS private key",
              blocked_by: [],
              needs_research: false,
              tags: ["tls"],
            },
            {
              id: "create_cert",
              task_role: "coder",
              description: "Create TLS certificate",
              blocked_by: [],
              needs_research: false,
              tags: ["tls"],
            },
            {
              id: "test_cert",
              task_role: "tester",
              description: "Verify TLS certificate outputs",
              blocked_by: ["generate_key", "create_cert"],
              needs_research: false,
              tags: ["test"],
            },
            {
              id: "review_tls",
              task_role: "reviewer",
              description: "Review TLS workflow",
              blocked_by: ["test_cert"],
              tags: ["review"],
            },
          ],
        }),
      )
      yield* llm.text("coder key done")
      yield* llm.text("coder cert done")
      yield* llm.text("tester done")
      yield* llm.text(JSON.stringify({ passed: true, notes: "ok" }))
      yield* llm.text("writer done")
      yield* llm.text("final done")
      for (const fallback of ["fallback-1", "fallback-2", "fallback-3", "fallback-4", "fallback-5"]) {
        yield* llm.text(fallback)
      }

      const plannerUser = yield* user(
        chat.id,
        "Execute the planner task graph for TLS certificate generation and verification.",
        "orchestrator",
      )
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: plannerUser.id,
        sessionID: chat.id,
        type: "subtask",
        task_role: "planner",
        task_id: "planner:seed_tls_malformed_blocked_by",
        blocked_by: [],
        tags: ["taskgraph", "seeded"],
        description: "Build TaskGraph",
        agent: "planner",
        model: ref,
        prompt: "Build an executable TaskGraph for this request and return JSON only.",
      } satisfies MessageV2.SubtaskPart)
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const subtasks = msgs.flatMap((msg) =>
        msg.parts.filter((part): part is MessageV2.SubtaskPart => part.type === "subtask"),
      )
      const testerTask =
        subtasks.find((part) => part.task_role === "tester" && part.description.includes("TLS certificate outputs")) ??
        subtasks.find((part) => part.task_role === "tester")
      if (!testerTask) {
        const plannerInvalid = msgs
          .flatMap((msg) => msg.parts)
          .filter((part): part is MessageV2.TextPart => part.type === "text" && part.synthetic === true)
          .some((part) => part.text.includes('"type": "planner_taskgraph_invalid"'))
        expect(plannerInvalid).toBe(true)
        return
      }
      const coderTaskIDs = subtasks
        .filter((part) => part.task_role === "coder")
        .map((part) => part.task_id ?? part.id)
      expect(Array.isArray(testerTask?.blocked_by)).toBe(true)
      for (const id of coderTaskIDs) expect(testerTask?.blocked_by).toContain(id)
      expect(Array.isArray(testerTask?.tags)).toBe(true)
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("planner malformed tags JSON is repaired for run_tasks async graph", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const plannerMatch = (hit: { body: unknown }) =>
        JSON.stringify(hit.body).includes("Build an executable TaskGraph")

      yield* llm.textMatch(
        plannerMatch,
        '{"nodes":[{"id":"impl_async","task_role":"coder","description":"Implement single file run_tasks asyncio update","blocked_by":[],"needs_research":false,"tags":"single_scope:small_change","python","asyncio"},{"id":"test_impl_async","task_role":"tester","description":"Validate run_tasks asyncio behavior","blocked_by":["impl_async"],"needs_research":false,"tags":["test"]},{"id":"review_async","task_role":"reviewer","description":"Review run_tasks asyncio behavior","blocked_by":["test_impl_async"],"tags":["review"]}]}',
      )
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes('subagent_type":"coder"'), "coder done")
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes('subagent_type":"tester"'), "tester done")
      yield* llm.textMatch(
        (hit) => JSON.stringify(hit.body).includes('subagent_type":"reviewer"'),
        JSON.stringify({ passed: true, notes: "ok" }),
      )
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("Persistence mode:"), "writer done")
      yield* llm.text("final done")
      for (const fallback of ["fallback-1", "fallback-2", "fallback-3", "fallback-4", "fallback-5"]) {
        yield* llm.text(fallback)
      }

      yield* user(chat.id, "Patch run_tasks to improve asyncio cancellation handling and verify tests.", "orchestrator")
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const subtasks = msgs.flatMap((msg) =>
        msg.parts.filter((part): part is MessageV2.SubtaskPart => part.type === "subtask"),
      )
      const coderTask = subtasks.find((part) => part.task_role === "coder" && part.task_id === "impl_async")
      expect(coderTask).toBeDefined()
      expect(Array.isArray(coderTask?.tags)).toBe(true)
      expect(coderTask?.tags).toContain("python")
      expect(coderTask?.tags).toContain("asyncio")
      expect(Array.isArray(coderTask?.blocked_by)).toBe(true)
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("normalizeTaskGraph coerces blockedBy/tags strings and scheduler always receives arrays", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const plannerMatch = (hit: { body: unknown }) =>
        JSON.stringify(hit.body).includes("Build an executable TaskGraph")
      yield* llm.textMatch(
        plannerMatch,
        JSON.stringify({
          nodes: [
            {
              id: "impl_a",
              task_role: "coder",
              description: "Implement module A behavior",
              blocked_by: null,
              needs_research: false,
              tags: "python",
            },
            {
              id: "impl_b",
              task_role: "coder",
              description: "Implement module B behavior",
              blocked_by: [],
              needs_research: false,
              tags: ["asyncio"],
            },
            {
              id: "test_impl",
              task_role: "tester",
              description: "Validate module integration",
              blockedBy: "impl_a",
              needsResearch: false,
              tags: "test",
            },
            {
              id: "review_impl",
              task_role: "reviewer",
              description: "Review integrated behavior",
              blockedBy: ["impl_a", "impl_b", "test_impl"],
              tags: ["review"],
            },
          ],
        }),
      )
      yield* llm.text("coder A done")
      yield* llm.text("coder B done")
      yield* llm.text("tester done")
      yield* llm.text(JSON.stringify({ passed: true, notes: "ok" }))
      yield* llm.text("writer done")
      yield* llm.text("final done")

      const plannerUser = yield* user(
        chat.id,
        "Implement two related modules, validate both in tests, then review full integration.",
        "orchestrator",
      )
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: plannerUser.id,
        sessionID: chat.id,
        type: "subtask",
        task_role: "planner",
        task_id: "planner:seed_normalize_arrays",
        blocked_by: [],
        tags: ["taskgraph", "seeded"],
        description: "Build TaskGraph",
        agent: "planner",
        model: ref,
        prompt: "Build an executable TaskGraph for this request and return JSON only.",
      } satisfies MessageV2.SubtaskPart)
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const subtasks = msgs.flatMap((msg) =>
        msg.parts.filter((part): part is MessageV2.SubtaskPart => part.type === "subtask"),
      )
      const execSubtasks = subtasks.filter((part) => part.task_role !== "planner")
      for (const part of execSubtasks) {
        expect(Array.isArray(part.blocked_by)).toBe(true)
        expect(Array.isArray(part.tags)).toBe(true)
      }

      const testerTask = subtasks.find((part) => part.task_role === "tester" && part.task_id === "test_impl")
      expect(testerTask).toBeDefined()
      expect(testerTask?.blocked_by).toContain("impl_a")
      const coderTaskIDs = subtasks
        .filter((part) => part.task_role === "coder")
        .map((part) => part.task_id ?? part.id)
      for (const id of coderTaskIDs) expect(testerTask?.blocked_by).toContain(id)

      const reviewerTask = subtasks.find((part) => part.task_role === "reviewer" && part.task_id === "review_impl")
      expect(Array.isArray(reviewerTask?.blocked_by)).toBe(true)
      expect((reviewerTask?.blocked_by ?? []).length).toBeGreaterThan(1)
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("TaskGraph blockedBy adds research dependency for README identified typo flow", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const plannerMatch = (hit: { body: unknown }) =>
        JSON.stringify(hit.body).includes("Build an executable TaskGraph")
      yield* llm.textMatch(
        plannerMatch,
        JSON.stringify({
          nodes: [
            {
              id: "research_readme",
              task_role: "research",
              description: "Find README.md in project root and identify a clear typo",
              blocked_by: [],
              needs_research: false,
              tags: ["research", "readme"],
            },
            {
              id: "fix_readme",
              task_role: "coder",
              description: "Fix the identified typo in README.md",
              blocked_by: [],
              needs_research: false,
              tags: ["single_scope:small_change", "docs"],
            },
            {
              id: "test_fix_readme",
              task_role: "tester",
              description: "Verify README typo fix",
              blocked_by: ["fix_readme"],
              needs_research: false,
              tags: ["test"],
            },
            {
              id: "review_fix_readme",
              task_role: "reviewer",
              description: "Review README typo fix",
              blocked_by: ["test_fix_readme"],
              tags: ["review"],
            },
          ],
        }),
      )
      yield* llm.text("research done")
      yield* llm.text("coder done")
      yield* llm.text("tester done")
      yield* llm.text(JSON.stringify({ passed: true, notes: "ok" }))
      yield* llm.text("writer done")
      yield* llm.text("final done")

      const plannerUser = yield* user(
        chat.id,
        "Implement README cleanup based on findings, keep implementation/test/review chain explicit.",
        "orchestrator",
      )
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: plannerUser.id,
        sessionID: chat.id,
        type: "subtask",
        task_role: "planner",
        task_id: "planner:seed_readme_research_dep",
        blocked_by: [],
        tags: ["taskgraph", "seeded"],
        description: "Build TaskGraph",
        agent: "planner",
        model: ref,
        prompt: "Build an executable TaskGraph for this request and return JSON only.",
      } satisfies MessageV2.SubtaskPart)
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const subtasks = msgs.flatMap((msg) =>
        msg.parts.filter((part): part is MessageV2.SubtaskPart => part.type === "subtask"),
      )
      const coderTasks = subtasks.filter((part) => part.task_role === "coder")
      expect(coderTasks.length).toBeGreaterThan(0)
      expect(coderTasks.some((part) => (part.blocked_by ?? []).includes("research_readme"))).toBe(true)
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("TaskGraph blockedBy adds research dependency for API implement based on findings", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const plannerMatch = (hit: { body: unknown }) =>
        JSON.stringify(hit.body).includes("Build an executable TaskGraph")
      yield* llm.textMatch(
        plannerMatch,
        JSON.stringify({
          nodes: [
            {
              id: "research_api_behavior",
              task_role: "research",
              description: "Determine API timeout and retry behavior",
              blocked_by: [],
              needs_research: false,
              tags: ["research", "api"],
            },
            {
              id: "impl_api_fix",
              task_role: "coder",
              description: "Implement API client behavior based on findings",
              blocked_by: [],
              needs_research: false,
              tags: ["single_scope:small_change", "impl"],
            },
            {
              id: "test_impl_api_fix",
              task_role: "tester",
              description: "Validate API client behavior",
              blocked_by: ["impl_api_fix"],
              needs_research: false,
              tags: ["test"],
            },
            {
              id: "review_impl_api_fix",
              task_role: "reviewer",
              description: "Review API behavior changes",
              blocked_by: ["test_impl_api_fix"],
              tags: ["review"],
            },
          ],
        }),
      )
      yield* llm.text("research done")
      yield* llm.text("coder done")
      yield* llm.text("tester done")
      yield* llm.text(JSON.stringify({ passed: true, notes: "ok" }))
      yield* llm.text("writer done")
      yield* llm.text("final done")

      const plannerUser = yield* user(
        chat.id,
        "Find typo findings first, then implement the README fix based on findings and verify.",
        "orchestrator",
      )
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: plannerUser.id,
        sessionID: chat.id,
        type: "subtask",
        task_role: "planner",
        task_id: "planner:seed_api_research_dep",
        blocked_by: [],
        tags: ["taskgraph", "seeded"],
        description: "Build TaskGraph",
        agent: "planner",
        model: ref,
        prompt: "Build an executable TaskGraph for this request and return JSON only.",
      } satisfies MessageV2.SubtaskPart)
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const subtasks = msgs.flatMap((msg) =>
        msg.parts.filter((part): part is MessageV2.SubtaskPart => part.type === "subtask"),
      )
      const coderTasks = subtasks.filter((part) => part.task_role === "coder")
      expect(coderTasks.length).toBeGreaterThan(0)
      expect(coderTasks.some((part) => (part.blocked_by ?? []).includes("research_api_behavior"))).toBe(true)
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("TaskGraph blockedBy keeps research dependency after coder regroup and enqueue mapping", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const plannerMatch = (hit: { body: unknown }) =>
        JSON.stringify(hit.body).includes("Build an executable TaskGraph")
      yield* llm.textMatch(
        plannerMatch,
        JSON.stringify({
          nodes: [
            {
              id: "research_readme",
              task_role: "research",
              description: "Find README typo and identify unnatural wording",
              blocked_by: [],
              needs_research: false,
              tags: ["research", "readme"],
            },
            {
              id: "fix_typo",
              task_role: "coder",
              description: "Fix the identified typo in README based on findings",
              blocked_by: ["research_readme"],
              needs_research: false,
              tags: ["impl"],
            },
            {
              id: "test_fix_typo",
              task_role: "tester",
              description: "Verify README typo fix",
              blocked_by: ["fix_typo"],
              needs_research: false,
              tags: ["test"],
            },
            {
              id: "review_fix_typo",
              task_role: "reviewer",
              description: "Review README typo changes",
              blocked_by: ["test_fix_typo"],
              tags: ["review"],
            },
          ],
        }),
      )
      yield* llm.text("research done")
      yield* llm.text("coder core done")
      yield* llm.text("coder integration done")
      yield* llm.text("tester done")
      yield* llm.text(JSON.stringify({ passed: true, notes: "ok" }))
      yield* llm.text("writer done")
      yield* llm.text("final done")

      yield* user(
        chat.id,
        [
          "Implement a new config option and wire it into CLI behavior.",
          "Apply the same dependency pattern to a README typo fix based on research findings.",
          "Add tests and review dependency correctness.",
        ].join("\n"),
        "orchestrator",
      )
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const subtasks = msgs.flatMap((msg) =>
        msg.parts.filter((part): part is MessageV2.SubtaskPart => part.type === "subtask"),
      )
      const coderTasks = subtasks.filter((part) => part.task_role === "coder")
      expect(coderTasks.length).toBeGreaterThan(0)
      for (const coder of coderTasks) expect(coder.blocked_by).toContain("research_readme")
      const integrationCoder = coderTasks.find(
        (part) => (part.task_id ?? part.id).includes("coder_integration") || part.description.toLowerCase().includes("integrate"),
      )
      if (integrationCoder) {
        expect(integrationCoder.blocked_by).toContain("research_readme")
        expect(integrationCoder.tags ?? []).not.toContain("parallel")
      }
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("research ready-gate blocks coder until research completes", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.text(
        JSON.stringify({
          nodes: [
            {
              id: "research_readme",
              task_role: "research",
              description: "Find README typo and identify unnatural wording",
              blocked_by: [],
              needs_research: false,
              tags: ["research", "readme"],
            },
            {
              id: "fix_typo",
              task_role: "coder",
              description: "Fix the identified typo in README based on findings",
              blocked_by: ["research_readme"],
              needs_research: false,
              tags: ["impl"],
            },
            {
              id: "test_fix_typo",
              task_role: "tester",
              description: "Verify README typo fix",
              blocked_by: ["fix_typo"],
              needs_research: false,
              tags: ["test"],
            },
          ],
        }),
      )
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes('subagent_type":"research"'), "research done")
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes('subagent_type":"coder"'), "coder done")
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes('subagent_type":"tester"'), "tester done")
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("Persistence mode:"), "writer done")
      yield* llm.text("final done")

      const plannerUser = yield* user(
        chat.id,
        "Find typo first, then fix based on findings, then run verification.",
        "orchestrator",
      )
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: plannerUser.id,
        sessionID: chat.id,
        type: "subtask",
        task_role: "planner",
        task_id: "planner:seed_research_ready_gate",
        blocked_by: [],
        tags: ["taskgraph", "seeded"],
        description: "Build TaskGraph",
        agent: "planner",
        model: ref,
        prompt: "Build an executable TaskGraph for this request and return JSON only.",
      } satisfies MessageV2.SubtaskPart)
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const subtasks = msgs.flatMap((msg) =>
        msg.parts.filter((part): part is MessageV2.SubtaskPart => part.type === "subtask"),
      )
      const executable = subtasks.filter((part) => part.task_role !== "planner" && part.task_role !== "writer")
      const readyWithNone = executable.filter((part) => (part.blocked_by ?? []).length === 0)
      expect(readyWithNone.some((part) => part.task_role === "research")).toBe(true)
      expect(readyWithNone.some((part) => part.task_role === "coder")).toBe(false)
      const readyAfterResearch = executable.filter((part) =>
        (part.blocked_by ?? []).every((id) => id === "research_readme"),
      )
      expect(readyAfterResearch.some((part) => part.task_role === "coder")).toBe(true)
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("TaskGraph dependency blockedBy ready scheduler preserves research -> impl_cert -> impl_verification chain with parallel tag", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.text(
        JSON.stringify({
          nodes: [
            {
              id: "research",
              task_role: "research",
              description: "Research OpenSSL cert requirements and expected verification output",
              blocked_by: [],
              needs_research: false,
              tags: ["research", "tls"],
            },
            {
              id: "impl_cert",
              task_role: "coder",
              description: "Create certificate artifacts at correct project path",
              blocked_by: ["research"],
              needs_research: false,
              tags: ["impl", "tls"],
            },
            {
              id: "impl_verification",
              task_role: "coder",
              description: "Create verification script for generated certificate",
              blocked_by: ["impl_cert"],
              needs_research: false,
              tags: ["impl", "parallel", "verification"],
            },
            {
              id: "test_cert",
              task_role: "tester",
              description: "Validate certificate and verification script outputs",
              blocked_by: ["impl_cert", "impl_verification"],
              needs_research: false,
              tags: ["test"],
            },
            {
              id: "review",
              task_role: "reviewer",
              description: "Review TLS generation and verification workflow",
              blocked_by: ["test_cert"],
              tags: ["review"],
            },
          ],
        }),
      )
      yield* llm.text("research done")
      yield* llm.text("impl cert done")
      yield* llm.text("impl verification done")
      yield* llm.text("tester done")
      yield* llm.text(JSON.stringify({ passed: true, notes: "ok" }))
      yield* llm.text("writer done")
      yield* llm.text("final done")
      for (const fallback of ["fallback-1", "fallback-2", "fallback-3", "fallback-4", "fallback-5"]) {
        yield* llm.text(fallback)
      }

      const plannerUser = yield* user(
        chat.id,
        "Generate TLS cert and script with strict dependency chain, then test and review.",
        "orchestrator",
      )
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: plannerUser.id,
        sessionID: chat.id,
        type: "subtask",
        task_role: "planner",
        task_id: "planner:seed_tls_dep_chain",
        blocked_by: [],
        tags: ["taskgraph", "seeded"],
        description: "Build TaskGraph",
        agent: "planner",
        model: ref,
        prompt: "Build an executable TaskGraph for this request and return JSON only.",
      } satisfies MessageV2.SubtaskPart)
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const subtasks = msgs.flatMap((msg) =>
        msg.parts.filter((part): part is MessageV2.SubtaskPart => part.type === "subtask"),
      )
      const executable = subtasks.filter((part) => part.task_role !== "planner" && part.task_role !== "writer")
      const byTaskID = new Map(executable.map((task) => [task.task_id ?? task.id, task]))
      expect(byTaskID.get("impl_cert")?.blocked_by ?? []).toContain("research")
      expect(byTaskID.get("impl_verification")?.blocked_by ?? []).toContain("impl_cert")
      expect(byTaskID.get("impl_verification")?.blocked_by ?? []).not.toContain("research")
      expect(byTaskID.get("impl_verification")?.tags ?? []).toContain("parallel")

      const ready = (completed: string[]) =>
        executable.filter((task) =>
          (task.blocked_by ?? []).every((id) => completed.includes(id)),
        )

      const firstReady = ready([])
      expect(firstReady.map((task) => task.task_id ?? task.id)).toEqual(["research"])

      const readyAfterResearch = ready(["research"])
      expect(readyAfterResearch.some((task) => (task.task_id ?? task.id) === "impl_cert")).toBe(true)
      expect(readyAfterResearch.some((task) => (task.task_id ?? task.id) === "impl_verification")).toBe(false)

      const readyAfterImplCert = ready(["research", "impl_cert"])
      expect(readyAfterImplCert.some((task) => (task.task_id ?? task.id) === "impl_verification")).toBe(true)
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("TaskGraph blockedBy malformed blockedBy/tags normalize keeps impl_verification dependency", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.text(
        '{"nodes":[{"id":"research_tls","task_role":"research","description":"Research TLS command sequence","blocked_by":[],"needs_research":false,"tags":["research"]},{"id":"impl_cert","task_role":"coder","description":"Create cert artifacts at expected path","blockedBy":"research_tls","needsResearch":false,"tags":"impl","parallel"},{"id":"impl_verification","task_role":"coder","description":"Create cert verification script","blockedBy":"impl_cert","needsResearch":false,"tags":"impl","parallel"},{"id":"test_cert","task_role":"tester","description":"Validate cert workflow","blockedBy":"impl_cert","impl_verification","needsResearch":false,"tags":["test"]},{"id":"review_tls","task_role":"reviewer","description":"Review cert workflow","blocked_by":["test_cert"],"tags":["review"]}]}',
      )
      yield* llm.text("research done")
      yield* llm.text("impl cert done")
      yield* llm.text("impl verification done")
      yield* llm.text("tester done")
      yield* llm.text(JSON.stringify({ passed: true, notes: "ok" }))
      yield* llm.text("writer done")
      yield* llm.text("final done")
      for (const fallback of ["fallback-1", "fallback-2", "fallback-3", "fallback-4", "fallback-5"]) {
        yield* llm.text(fallback)
      }

      const plannerUser = yield* user(
        chat.id,
        "Run TLS path fix then verification script as dependent coder tasks.",
        "orchestrator",
      )
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: plannerUser.id,
        sessionID: chat.id,
        type: "subtask",
        task_role: "planner",
        task_id: "planner:seed_tls_malformed_dep",
        blocked_by: [],
        tags: ["taskgraph", "seeded"],
        description: "Build TaskGraph",
        agent: "planner",
        model: ref,
        prompt: "Build an executable TaskGraph for this request and return JSON only.",
      } satisfies MessageV2.SubtaskPart)
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const subtasks = msgs.flatMap((msg) =>
        msg.parts.filter((part): part is MessageV2.SubtaskPart => part.type === "subtask"),
      )
      const implVerification = subtasks.find(
        (part) =>
          part.task_role === "coder" &&
          ((part.task_id ?? part.id) === "impl_verification" ||
            part.description.toLowerCase().includes("verification script")),
      )
      expect(Array.isArray(implVerification?.blocked_by)).toBe(true)
      expect(implVerification?.blocked_by).toContain("impl_cert")
      expect(Array.isArray(implVerification?.tags)).toBe(true)
      expect(implVerification?.tags).toContain("impl")
      expect(implVerification?.tags).toContain("parallel")
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("TaskGraph TLS-like dependency scheduler order keeps writer after review and no parallel override", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.text(
        JSON.stringify({
          nodes: [
            {
              id: "research_tls",
              task_role: "research",
              description: "Research OpenSSL command sequence for local TLS certificate",
              blocked_by: [],
              needs_research: false,
              tags: ["research", "tls"],
            },
            {
              id: "impl_cert",
              task_role: "coder",
              description: "Generate certificate and key under project cert path",
              blocked_by: ["research_tls"],
              needs_research: false,
              tags: ["impl", "tls"],
            },
            {
              id: "impl_verification",
              task_role: "coder",
              description: "Create Python verification script for generated cert files",
              blocked_by: ["impl_cert"],
              needs_research: false,
              tags: ["impl", "parallel", "verification"],
            },
            {
              id: "test_tls",
              task_role: "tester",
              description: "Run verification script and confirm TLS artifacts",
              blocked_by: ["impl_cert", "impl_verification"],
              needs_research: false,
              tags: ["test"],
            },
            {
              id: "review_tls",
              task_role: "reviewer",
              description: "Review TLS implementation and verification evidence",
              blocked_by: ["test_tls"],
              tags: ["review"],
            },
          ],
        }),
      )
      yield* llm.text("research done")
      yield* llm.text("impl cert done")
      yield* llm.text("impl verification done")
      yield* llm.text("tester done")
      yield* llm.text(JSON.stringify({ passed: true, notes: "ok" }))
      yield* llm.text("writer done")
      yield* llm.text("final done")
      for (const fallback of ["fallback-1", "fallback-2", "fallback-3", "fallback-4", "fallback-5"]) {
        yield* llm.text(fallback)
      }

      const plannerUser = yield* user(
        chat.id,
        "Fix TLS path mismatch, then add verification script, then test and review.",
        "orchestrator",
      )
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: plannerUser.id,
        sessionID: chat.id,
        type: "subtask",
        task_role: "planner",
        task_id: "planner:seed_tls_like_graph",
        blocked_by: [],
        tags: ["taskgraph", "seeded"],
        description: "Build TaskGraph",
        agent: "planner",
        model: ref,
        prompt: "Build an executable TaskGraph for this request and return JSON only.",
      } satisfies MessageV2.SubtaskPart)
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      const hits = yield* llm.hits
      const findHit = (text: string) => hits.findIndex((hit) => bodyText(hit.body).includes(text))
      const researchHit = findHit("Research OpenSSL command sequence for local TLS certificate")
      const implCertHit = findHit("Generate certificate and key under project cert path")
      const implVerificationHit = findHit("Create Python verification script for generated cert files")
      const testerHit = findHit("Run verification script and confirm TLS artifacts")
      const reviewerHit = findHit("Review TLS implementation and verification evidence")
      const writerHit = findHit("Persistence mode:")

      expect(researchHit).toBeGreaterThan(-1)
      expect(implCertHit).toBeGreaterThan(researchHit)
      expect(implVerificationHit).toBeGreaterThan(implCertHit)
      expect(testerHit).toBeGreaterThan(implVerificationHit)
      expect(reviewerHit).toBeGreaterThan(testerHit)
      expect(writerHit).toBeGreaterThan(reviewerHit)
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("TaskGraph blockedBy keeps non-blocking research parallel with clearly specified coder change", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const plannerMatch = (hit: { body: unknown }) =>
        JSON.stringify(hit.body).includes("Build an executable TaskGraph")
      yield* llm.textMatch(
        plannerMatch,
        JSON.stringify({
          nodes: [
            {
              id: "research_background",
              task_role: "research",
              description: "Collect background docs for future optimization ideas",
              blocked_by: [],
              needs_research: false,
              tags: ["research", "background"],
            },
            {
              id: "impl_config_rename",
              task_role: "coder",
              description: "Rename config key foo_timeout to request_timeout in src/config/options.ts",
              blocked_by: [],
              needs_research: false,
              tags: ["single_scope:small_change", "impl"],
            },
            {
              id: "test_impl_config_rename",
              task_role: "tester",
              description: "Validate config rename behavior",
              blocked_by: ["impl_config_rename"],
              needs_research: false,
              tags: ["test"],
            },
            {
              id: "review_impl_config_rename",
              task_role: "reviewer",
              description: "Review config rename changes",
              blocked_by: ["test_impl_config_rename"],
              tags: ["review"],
            },
          ],
        }),
      )
      yield* llm.text("research done")
      yield* llm.text("coder done")
      yield* llm.text("tester done")
      yield* llm.text(JSON.stringify({ passed: true, notes: "ok" }))
      yield* llm.text("writer done")
      yield* llm.text("final done")

      const plannerUser = yield* user(
        chat.id,
        "Rename the config field as specified and collect background docs in parallel.",
        "orchestrator",
      )
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: plannerUser.id,
        sessionID: chat.id,
        type: "subtask",
        task_role: "planner",
        task_id: "planner:seed_non_blocking_parallel",
        blocked_by: [],
        tags: ["taskgraph", "seeded"],
        description: "Build TaskGraph",
        agent: "planner",
        model: ref,
        prompt: "Build an executable TaskGraph for this request and return JSON only.",
      } satisfies MessageV2.SubtaskPart)
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const subtasks = msgs.flatMap((msg) =>
        msg.parts.filter((part): part is MessageV2.SubtaskPart => part.type === "subtask"),
      )
      const coderTasks = subtasks.filter((part) => part.task_role === "coder")
      expect(coderTasks.every((part) => !(part.blocked_by ?? []).includes("research_background"))).toBe(true)
      const executable = subtasks.filter((part) => part.task_role !== "planner" && part.task_role !== "writer")
      const readyWithNone = executable.filter((part) => (part.blocked_by ?? []).length === 0)
      expect(readyWithNone.some((part) => part.task_role === "research")).toBe(true)
      expect(readyWithNone.some((part) => part.task_role === "coder")).toBe(true)
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("TaskGraph blockedBy simple explicit typo fix does not force research node", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const plannerMatch = (hit: { body: unknown }) =>
        JSON.stringify(hit.body).includes("Build an executable TaskGraph")

      yield* llm.textMatch(
        plannerMatch,
        JSON.stringify({
          nodes: [
            {
              id: "fix_readme_typo",
              task_role: "coder",
              description: "Edit README.md: replace teh with the in installation section",
              blocked_by: [],
              needs_research: false,
              tags: ["single_scope:small_change", "docs"],
            },
            {
              id: "test_fix_readme_typo",
              task_role: "tester",
              description: "Check README typo fix",
              blocked_by: ["fix_readme_typo"],
              needs_research: false,
              tags: ["test"],
            },
            {
              id: "review_fix_readme_typo",
              task_role: "reviewer",
              description: "Review README typo fix",
              blocked_by: ["test_fix_readme_typo"],
              tags: ["review"],
            },
          ],
        }),
      )
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes('subagent_type":"coder"'), "coder done")
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes('subagent_type":"tester"'), "tester done")
      yield* llm.textMatch(
        (hit) => JSON.stringify(hit.body).includes('subagent_type":"reviewer"'),
        JSON.stringify({ passed: true, notes: "ok" }),
      )
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("Persistence mode:"), "writer done")
      yield* llm.text("final done")

      const plannerUser: MessageV2.User = {
        id: MessageID.ascending(),
        sessionID: chat.id,
        role: "user",
        time: { created: Date.now() },
        agent: "orchestrator",
        model: ref,
      }
      yield* sessions.updateMessage(plannerUser)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: plannerUser.id,
        sessionID: chat.id,
        type: "subtask",
        task_role: "planner",
        task_id: "planner:seed_simple_typo",
        blocked_by: [],
        tags: ["taskgraph", "seeded"],
        description: "Build TaskGraph",
        agent: "planner",
        model: ref,
        prompt: "Build an executable TaskGraph for this request and return JSON only.",
      } satisfies MessageV2.SubtaskPart)
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const subtasks = msgs.flatMap((msg) =>
        msg.parts.filter((part): part is MessageV2.SubtaskPart => part.type === "subtask"),
      )
      expect(subtasks.some((part) => part.task_role === "research")).toBe(false)
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("work package operation-step collapse: certificate dependency chain keeps tester reviewer", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const plannerMatch = (hit: { body: unknown }) =>
        JSON.stringify(hit.body).includes("Build an executable TaskGraph")
      yield* llm.textMatch(
        plannerMatch,
        JSON.stringify({
          nodes: [
            { id: "prepare_cert_dir", task_role: "coder", description: "Prepare ssl directory", blocked_by: [], needs_research: false, tags: ["tls"] },
            { id: "generate_key", task_role: "coder", description: "Generate key file for certificate", blocked_by: ["prepare_cert_dir"], needs_research: false, tags: ["tls"] },
            { id: "create_cert", task_role: "coder", description: "Create certificate file", blocked_by: ["generate_key"], needs_research: false, tags: ["tls"] },
            { id: "merge_pem", task_role: "coder", description: "Merge cert and key into pem bundle", blocked_by: ["create_cert"], needs_research: false, tags: ["tls"] },
            { id: "write_metadata", task_role: "coder", description: "Write metadata for pem outputs", blocked_by: ["merge_pem"], needs_research: false, tags: ["tls"] },
            { id: "test_cert", task_role: "tester", description: "Validate certificate outputs", blocked_by: ["write_metadata"], needs_research: false, tags: ["test"] },
            { id: "review_cert", task_role: "reviewer", description: "Review certificate workflow", blocked_by: ["test_cert"], tags: ["review"] },
          ],
        }),
      )
      yield* llm.text("coder done")
      yield* llm.text("tester done")
      yield* llm.text(JSON.stringify({ passed: true, notes: "ok" }))
      yield* llm.text("writer done")
      yield* llm.text("final done")
      for (const fallback of ["fallback-1", "fallback-2", "fallback-3", "fallback-4", "fallback-5"]) yield* llm.text(fallback)

      const plannerUser = yield* user(chat.id, "Prepare/generate/merge/verify certificate artifacts then review.", "orchestrator")
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: plannerUser.id,
        sessionID: chat.id,
        type: "subtask",
        task_role: "planner",
        task_id: "planner:seed_work_package_cert_chain",
        blocked_by: [],
        tags: ["taskgraph", "seeded"],
        description: "Build TaskGraph",
        agent: "planner",
        model: ref,
        prompt: "Build an executable TaskGraph for this request and return JSON only.",
      } satisfies MessageV2.SubtaskPart)
      yield* prompt.loop({ sessionID: chat.id })

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const subtasks = msgs.flatMap((msg) => msg.parts.filter((part): part is MessageV2.SubtaskPart => part.type === "subtask"))
      const coders = subtasks.filter((part) => part.task_role === "coder")
      expect(coders.length).toBe(1)
      expect((coders[0]?.description ?? "").toLowerCase()).toContain("work package")
      const tester = subtasks.find((part) => part.task_role === "tester")
      const reviewer = subtasks.find((part) => part.task_role === "reviewer")
      expect(tester).toBeDefined()
      expect(reviewer).toBeDefined()
      const coderID = coders[0]?.task_id ?? coders[0]?.id
      if (coderID) expect(tester?.blocked_by ?? []).toContain(coderID)
      const testerID = tester?.task_id ?? tester?.id
      if (testerID) expect(reviewer?.blocked_by ?? []).toContain(testerID)
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("planner work package TaskGraph: TLS numbered steps become artifact packages, not operation-step nodes", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const chat = yield* sessions.create({ title: "planner-tls-numbered-work-package" })
      yield* llm.textMatch(
        (hit) => {
          const body = JSON.stringify(hit.body)
          return (
            body.includes("Build an executable TaskGraph for this request.") &&
            body.includes("User numbered steps are not TaskGraph node boundaries.") &&
            body.includes(
              "TLS/cert artifact-family anti-pattern: create_dir -> generate_key -> generate_cert -> create_pem -> write_verification.",
            ) &&
            body.includes(
              "TLS/cert artifact-family preferred split: coder_cert_artifacts (dir/key/cert/pem/verification.txt) + coder_check_script (check_cert.py).",
            )
          )
        },
        JSON.stringify({
          nodes: [
            {
              id: "coder_cert_artifacts",
              task_role: "coder",
              description: "Create TLS cert artifact family (dir/key/cert/pem/verification.txt)",
              blocked_by: [],
              needs_research: false,
              tags: ["impl", "tls"],
            },
            {
              id: "coder_check_script",
              task_role: "coder",
              description: "Create check_cert.py for certificate verification",
              blocked_by: ["coder_cert_artifacts"],
              needs_research: false,
              tags: ["impl", "tls", "script"],
            },
            {
              id: "test_tls",
              task_role: "tester",
              description: "Verify TLS artifacts and check script output",
              blocked_by: ["coder_cert_artifacts", "coder_check_script"],
              needs_research: false,
              tags: ["test"],
            },
            {
              id: "review_tls",
              task_role: "reviewer",
              description: "Review TLS artifact workflow",
              blocked_by: ["test_tls"],
              tags: ["review"],
            },
          ],
        }),
      )
      yield* llm.hang

      yield* user(
        chat.id,
        [
          "TLS request with numbered steps:",
          "1. create_dir",
          "2. generate_key",
          "3. generate_cert",
          "4. create_pem",
          "5. write_verification",
          "6. create check_cert.py",
          "Please execute as TaskGraph work packages.",
        ].join("\n"),
        "orchestrator",
      )
      const run = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      for (let i = 0; i < 200; i += 1) {
        const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
        const hasCoder = msgs.some((msg) =>
          msg.parts.some((part) => part.type === "subtask" && part.task_role === "coder"),
        )
        if (hasCoder) break
        yield* Effect.sleep(20)
      }
      yield* prompt.cancel(chat.id)
      const exit = yield* Fiber.await(run)
      expect(Exit.isSuccess(exit)).toBe(true)
      expect((yield* status.get(chat.id)).type).toBe("idle")

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const subtasks = msgs.flatMap((msg) => msg.parts.filter((part): part is MessageV2.SubtaskPart => part.type === "subtask"))
      const coders = subtasks.filter((part) => part.task_role === "coder")
      expect(coders.map((part) => part.task_id ?? part.id)).toEqual(["coder_cert_artifacts", "coder_check_script"])

      const forbiddenIDs = new Set(["create_dir", "generate_key", "generate_cert", "create_pem", "write_verification"])
      expect(coders.some((part) => forbiddenIDs.has(part.task_id ?? part.id))).toBe(false)
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("planner work package policy TaskGraph: prefer 2-5 coder nodes only for independent packages", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const chat = yield* sessions.create({ title: "planner-cohesive-single-coder" })
      yield* llm.textMatch(
        (hit) => {
          const body = JSON.stringify(hit.body)
          return (
            body.includes("Build an executable TaskGraph for this request.") &&
            body.includes(
              "Use 2-5 coder nodes only when independent work packages exist; a simple cohesive artifact family can be one coder node.",
            )
          )
        },
        JSON.stringify({
          nodes: [
            {
              id: "impl_tls_family",
              task_role: "coder",
              description: "Implement cohesive TLS artifact family in one package",
              blocked_by: [],
              needs_research: false,
              tags: ["impl", "tls", "single_scope:unsplittable"],
            },
            {
              id: "test_tls",
              task_role: "tester",
              description: "Verify TLS artifact family output",
              blocked_by: ["impl_tls_family"],
              needs_research: false,
              tags: ["test"],
            },
            {
              id: "review_tls",
              task_role: "reviewer",
              description: "Review TLS cohesive package output",
              blocked_by: ["test_tls"],
              tags: ["review"],
            },
          ],
        }),
      )
      yield* llm.hang

      yield* user(chat.id, "Create TLS cert artifacts as one cohesive family and verify.", "orchestrator")
      const run = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      for (let i = 0; i < 200; i += 1) {
        const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
        const hasCoder = msgs.some((msg) =>
          msg.parts.some((part) => part.type === "subtask" && part.task_role === "coder"),
        )
        if (hasCoder) break
        yield* Effect.sleep(20)
      }
      yield* prompt.cancel(chat.id)
      const exit = yield* Fiber.await(run)
      expect(Exit.isSuccess(exit)).toBe(true)
      expect((yield* status.get(chat.id)).type).toBe("idle")

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const subtasks = msgs.flatMap((msg) => msg.parts.filter((part): part is MessageV2.SubtaskPart => part.type === "subtask"))
      const coderIDs = subtasks.filter((part) => part.task_role === "coder").map((part) => part.task_id ?? part.id)
      expect(coderIDs).toEqual(["impl_tls_family"])
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("work package operation-step collapse: cli chain collapses to one coder package", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const plannerMatch = (hit: { body: unknown }) =>
        JSON.stringify(hit.body).includes("Build an executable TaskGraph")
      yield* llm.textMatch(
        plannerMatch,
        JSON.stringify({
          nodes: [
            { id: "create_file", task_role: "coder", description: "Create file for command parser", blocked_by: [], needs_research: false, tags: ["cli"] },
            { id: "implement_parser", task_role: "coder", description: "Implement parser logic", blocked_by: ["create_file"], needs_research: false, tags: ["cli"] },
            { id: "wire_command", task_role: "coder", description: "Wire command handler", blocked_by: ["implement_parser"], needs_research: false, tags: ["cli"] },
            { id: "update_help", task_role: "coder", description: "Update help output for command", blocked_by: ["wire_command"], needs_research: false, tags: ["cli"] },
            { id: "test_cli", task_role: "tester", description: "Validate command parser flow", blocked_by: ["update_help"], needs_research: false, tags: ["test"] },
            { id: "review_cli", task_role: "reviewer", description: "Review CLI changes", blocked_by: ["test_cli"], tags: ["review"] },
          ],
        }),
      )
      yield* llm.text("coder done")
      yield* llm.text("tester done")
      yield* llm.text(JSON.stringify({ passed: true, notes: "ok" }))
      yield* llm.text("writer done")
      yield* llm.text("final done")

      const plannerUser = yield* user(chat.id, "Implement CLI parser and command wiring end-to-end.", "orchestrator")
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: plannerUser.id,
        sessionID: chat.id,
        type: "subtask",
        task_role: "planner",
        task_id: "planner:seed_work_package_cli_chain",
        blocked_by: [],
        tags: ["taskgraph", "seeded"],
        description: "Build TaskGraph",
        agent: "planner",
        model: ref,
        prompt: "Build an executable TaskGraph for this request and return JSON only.",
      } satisfies MessageV2.SubtaskPart)
      yield* prompt.loop({ sessionID: chat.id })

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const subtasks = msgs.flatMap((msg) => msg.parts.filter((part): part is MessageV2.SubtaskPart => part.type === "subtask"))
      expect(subtasks.filter((part) => part.task_role === "coder").length).toBe(1)
      expect(subtasks.some((part) => part.task_role === "tester")).toBe(true)
      expect(subtasks.some((part) => part.task_role === "reviewer")).toBe(true)
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("work package collapse: config schema dependency chain collapses into one coder package", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const plannerMatch = (hit: { body: unknown }) =>
        JSON.stringify(hit.body).includes("Build an executable TaskGraph")
      yield* llm.textMatch(
        plannerMatch,
        JSON.stringify({
          nodes: [
            { id: "create_schema", task_role: "coder", description: "Create schema for config", blocked_by: [], needs_research: false, tags: ["config"] },
            { id: "update_config_loader", task_role: "coder", description: "Update config loader", blocked_by: ["create_schema"], needs_research: false, tags: ["config"] },
            { id: "add_defaults", task_role: "coder", description: "Add config defaults", blocked_by: ["update_config_loader"], needs_research: false, tags: ["config"] },
            { id: "test_config", task_role: "tester", description: "Validate config loading and defaults", blocked_by: ["add_defaults"], needs_research: false, tags: ["test"] },
            { id: "review_config", task_role: "reviewer", description: "Review config/schema updates", blocked_by: ["test_config"], tags: ["review"] },
          ],
        }),
      )
      yield* llm.text("coder done")
      yield* llm.text("tester done")
      yield* llm.text(JSON.stringify({ passed: true, notes: "ok" }))
      yield* llm.text("writer done")
      yield* llm.text("final done")

      const plannerUser = yield* user(chat.id, "Update config schema and loader with defaults.", "orchestrator")
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: plannerUser.id,
        sessionID: chat.id,
        type: "subtask",
        task_role: "planner",
        task_id: "planner:seed_work_package_config_chain",
        blocked_by: [],
        tags: ["taskgraph", "seeded"],
        description: "Build TaskGraph",
        agent: "planner",
        model: ref,
        prompt: "Build an executable TaskGraph for this request and return JSON only.",
      } satisfies MessageV2.SubtaskPart)
      yield* prompt.loop({ sessionID: chat.id })

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const subtasks = msgs.flatMap((msg) => msg.parts.filter((part): part is MessageV2.SubtaskPart => part.type === "subtask"))
      expect(subtasks.filter((part) => part.task_role === "coder").length).toBe(1)
      expect(subtasks.some((part) => part.task_role === "tester")).toBe(true)
      expect(subtasks.some((part) => part.task_role === "reviewer")).toBe(true)
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("work package policy dependency: independent backend and frontend coder packages stay separate", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const plannerMatch = (hit: { body: unknown }) =>
        JSON.stringify(hit.body).includes("Build an executable TaskGraph")
      yield* llm.textMatch(
        plannerMatch,
        JSON.stringify({
          nodes: [
            { id: "implement_backend_api", task_role: "coder", description: "Implement backend API handlers", blocked_by: [], needs_research: false, tags: ["backend"] },
            { id: "implement_frontend_ui", task_role: "coder", description: "Implement frontend UI integration", blocked_by: [], needs_research: false, tags: ["frontend"] },
            { id: "test_full_stack", task_role: "tester", description: "Validate backend and frontend behavior", blocked_by: ["implement_backend_api", "implement_frontend_ui"], needs_research: false, tags: ["test"] },
            { id: "review_full_stack", task_role: "reviewer", description: "Review full stack changes", blocked_by: ["test_full_stack"], tags: ["review"] },
          ],
        }),
      )
      yield* llm.text("coder1 done")
      yield* llm.text("coder2 done")
      yield* llm.text("tester done")
      yield* llm.text(JSON.stringify({ passed: true, notes: "ok" }))
      yield* llm.text("writer done")
      yield* llm.text("final done")

      const plannerUser = yield* user(chat.id, "Implement backend API and frontend UI deliverables.", "orchestrator")
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: plannerUser.id,
        sessionID: chat.id,
        type: "subtask",
        task_role: "planner",
        task_id: "planner:seed_independent_work_packages",
        blocked_by: [],
        tags: ["taskgraph", "seeded"],
        description: "Build TaskGraph",
        agent: "planner",
        model: ref,
        prompt: "Build an executable TaskGraph for this request and return JSON only.",
      } satisfies MessageV2.SubtaskPart)
      yield* prompt.loop({ sessionID: chat.id })

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const subtasks = msgs.flatMap((msg) => msg.parts.filter((part): part is MessageV2.SubtaskPart => part.type === "subtask"))
      const coderIDs = subtasks
        .filter((part) => part.task_role === "coder")
        .map((part) => part.task_id ?? part.id)
      expect(coderIDs.length).toBe(2)
      expect(coderIDs).toContain("implement_backend_api")
      expect(coderIDs).toContain("implement_frontend_ui")
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("work package policy dependency: core library and cli wrapper stay separate packages", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const plannerMatch = (hit: { body: unknown }) =>
        JSON.stringify(hit.body).includes("Build an executable TaskGraph")
      yield* llm.textMatch(
        plannerMatch,
        JSON.stringify({
          nodes: [
            { id: "implement_core_library", task_role: "coder", description: "Implement core library behavior", blocked_by: [], needs_research: false, tags: ["core", "library"] },
            { id: "implement_cli_wrapper", task_role: "coder", description: "Implement CLI wrapper around core library", blocked_by: ["implement_core_library"], needs_research: false, tags: ["cli", "wrapper"] },
            { id: "test_core_cli", task_role: "tester", description: "Validate core and cli wrapper behavior", blocked_by: ["implement_core_library", "implement_cli_wrapper"], needs_research: false, tags: ["test"] },
            { id: "review_core_cli", task_role: "reviewer", description: "Review core and cli wrapper", blocked_by: ["test_core_cli"], tags: ["review"] },
          ],
        }),
      )
      yield* llm.text("core done")
      yield* llm.text("wrapper done")
      yield* llm.text("tester done")
      yield* llm.text(JSON.stringify({ passed: true, notes: "ok" }))
      yield* llm.text("writer done")
      yield* llm.text("final done")

      const plannerUser = yield* user(chat.id, "Implement core lib then CLI wrapper and verify.", "orchestrator")
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: plannerUser.id,
        sessionID: chat.id,
        type: "subtask",
        task_role: "planner",
        task_id: "planner:seed_core_wrapper_packages",
        blocked_by: [],
        tags: ["taskgraph", "seeded"],
        description: "Build TaskGraph",
        agent: "planner",
        model: ref,
        prompt: "Build an executable TaskGraph for this request and return JSON only.",
      } satisfies MessageV2.SubtaskPart)
      yield* prompt.loop({ sessionID: chat.id })

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const subtasks = msgs.flatMap((msg) => msg.parts.filter((part): part is MessageV2.SubtaskPart => part.type === "subtask"))
      const coders = subtasks.filter((part) => part.task_role === "coder")
      expect(coders.length).toBe(2)
      const wrapper = coders.find((part) => (part.task_id ?? part.id) === "implement_cli_wrapper")
      expect(wrapper).toBeDefined()
      expect(wrapper?.blocked_by ?? []).toContain("implement_core_library")
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("role boundary normalizeTaskGraph: verification-as-coder is repaired into tester", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const plannerMatch = (hit: { body: unknown }) =>
        JSON.stringify(hit.body).includes("Build an executable TaskGraph")
      yield* llm.textMatch(
        plannerMatch,
        JSON.stringify({
          nodes: [
            { id: "implement_feature", task_role: "coder", description: "Implement feature behavior", blocked_by: [], needs_research: false, tags: ["impl"] },
            { id: "verify_all_requirements", task_role: "coder", description: "Verify all requirements and validate all outputs", blocked_by: ["implement_feature"], needs_research: false, tags: ["verify"] },
            { id: "review_feature", task_role: "reviewer", description: "Review acceptance decision", blocked_by: ["verify_all_requirements"], tags: ["review"] },
          ],
        }),
      )
      yield* llm.text("coder done")
      yield* llm.text("tester done")
      yield* llm.text(JSON.stringify({ passed: true, notes: "ok" }))
      yield* llm.text("writer done")
      yield* llm.text("final done")

      const plannerUser = yield* user(chat.id, "Implement feature, verify all requirements, and review.", "orchestrator")
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: plannerUser.id,
        sessionID: chat.id,
        type: "subtask",
        task_role: "planner",
        task_id: "planner:seed_role_boundary_verify_coder",
        blocked_by: [],
        tags: ["taskgraph", "seeded"],
        description: "Build TaskGraph",
        agent: "planner",
        model: ref,
        prompt: "Build an executable TaskGraph for this request and return JSON only.",
      } satisfies MessageV2.SubtaskPart)
      yield* prompt.loop({ sessionID: chat.id })

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const subtasks = msgs.flatMap((msg) => msg.parts.filter((part): part is MessageV2.SubtaskPart => part.type === "subtask"))
      const verifyNode = subtasks.find((part) => (part.task_id ?? part.id) === "verify_all_requirements")
      expect(verifyNode).toBeDefined()
      expect(verifyNode?.task_role).toBe("tester")
      const reviewerNode = subtasks.find((part) => (part.task_id ?? part.id) === "review_feature")
      const verifyID = verifyNode?.task_id ?? verifyNode?.id
      if (verifyID) expect(reviewerNode?.blocked_by ?? []).toContain(verifyID)
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("normalizeTaskGraph dependency malformed blockedBy/tags arrays preserved after work package policy", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const plannerMatch = (hit: { body: unknown }) =>
        JSON.stringify(hit.body).includes("Build an executable TaskGraph")
      yield* llm.textMatch(
        plannerMatch,
        '{"nodes":[{"id":"create_schema","task_role":"coder","description":"Create schema file for config","blocked_by":[],"needs_research":false,"tags":"config","parallel"},{"id":"update_loader","task_role":"coder","description":"Update config loader for schema","blockedBy":"create_schema","needsResearch":false,"tags":"config","parallel"},{"id":"add_defaults","task_role":"coder","description":"Add defaults for config schema","blockedBy":"update_loader","needsResearch":false,"tags":"config","parallel"},{"id":"test_config","task_role":"tester","description":"Validate config behavior","blockedBy":"add_defaults","needsResearch":false,"tags":"test","parallel"},{"id":"review_config","task_role":"reviewer","description":"Review config behavior","blocked_by":["test_config"],"tags":["review"]}]}',
      )
      yield* llm.text("coder done")
      yield* llm.text("tester done")
      yield* llm.text(JSON.stringify({ passed: true, notes: "ok" }))
      yield* llm.text("writer done")
      yield* llm.text("final done")

      const plannerUser = yield* user(chat.id, "Normalize malformed task graph arrays for config work package.", "orchestrator")
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: plannerUser.id,
        sessionID: chat.id,
        type: "subtask",
        task_role: "planner",
        task_id: "planner:seed_malformed_arrays_work_package",
        blocked_by: [],
        tags: ["taskgraph", "seeded"],
        description: "Build TaskGraph",
        agent: "planner",
        model: ref,
        prompt: "Build an executable TaskGraph for this request and return JSON only.",
      } satisfies MessageV2.SubtaskPart)
      yield* prompt.loop({ sessionID: chat.id })

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const subtasks = msgs.flatMap((msg) => msg.parts.filter((part): part is MessageV2.SubtaskPart => part.type === "subtask"))
      for (const task of subtasks.filter((part) => part.task_role !== "planner")) {
        expect(Array.isArray(task.blocked_by)).toBe(true)
        expect(Array.isArray(task.tags)).toBe(true)
      }
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("implementation request defaults to two coders and tester waits for all coders", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.text(
        JSON.stringify({
          nodes: [
            {
              id: "impl_only",
              task_role: "coder",
              description: "Implement command behavior",
              blocked_by: [],
              needs_research: false,
              tags: ["impl"],
            },
            {
              id: "review_only",
              task_role: "reviewer",
              description: "Review command behavior",
              blocked_by: ["impl_only"],
              tags: ["review"],
            },
          ],
        }),
      )
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes('subagent_type":"coder"'), "coder core done")
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes('subagent_type":"coder"'), "coder integration done")
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes('subagent_type":"tester"'), "tester done")
      yield* llm.textMatch(
        (hit) => JSON.stringify(hit.body).includes('subagent_type":"reviewer"'),
        JSON.stringify({ passed: true, notes: "ok" }),
      )
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("Persistence mode:"), "writer done")
      yield* llm.text("final done")

      yield* user(
        chat.id,
        [
          "Implement a new config option and wire it into CLI behavior.",
          "Add tests and review dependency correctness.",
        ].join("\n"),
        "orchestrator",
      )
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const subtasks = msgs.flatMap((msg) =>
        msg.parts.filter((part): part is MessageV2.SubtaskPart => part.type === "subtask"),
      )
      const coderTasks = subtasks.filter((part) => part.task_role === "coder")
      expect(coderTasks.length).toBeGreaterThanOrEqual(2)
      const coderTaskIDs = coderTasks.map((part) => part.task_id ?? part.id)
      const testerTask = subtasks.find((part) => part.task_role === "tester" && part.task_id === "test_impl_only")
      expect(testerTask).toBeDefined()
      for (const id of coderTaskIDs) expect(testerTask?.blocked_by).toContain(id)
      const reviewerTask = subtasks.find((part) => part.task_role === "reviewer" && part.task_id === "review_only")
      for (const id of coderTaskIDs) expect(reviewerTask?.blocked_by).toContain(id)
      expect(reviewerTask?.blocked_by).toContain("test_impl_only")
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("small implementation request may keep a single coder", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      yield* llm.text(
        JSON.stringify({
          nodes: [
            {
              id: "tiny_fix",
              task_role: "coder",
              description: "Fix one typo in user-facing message",
              blocked_by: [],
              needs_research: false,
              tags: ["impl", "single_scope:small_change"],
            },
            {
              id: "review_tiny_fix",
              task_role: "reviewer",
              description: "Review typo fix and checks",
              blocked_by: ["tiny_fix"],
              tags: ["review"],
            },
          ],
        }),
      )
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes('subagent_type":"coder"'), "coder done")
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes('subagent_type":"tester"'), "tester done")
      yield* llm.textMatch(
        (hit) => JSON.stringify(hit.body).includes('subagent_type":"reviewer"'),
        JSON.stringify({ passed: true, notes: "ok" }),
      )
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("Persistence mode:"), "writer done")
      yield* llm.text("final done")

      yield* user(
        chat.id,
        [
          "Fix typo in one message and keep behavior unchanged.",
          "1. Keep implementation scope minimal.",
          "2. Add or update tests only for this tiny change.",
        ].join("\n"),
        "orchestrator",
      )
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const subtasks = msgs.flatMap((msg) =>
        msg.parts.filter((part): part is MessageV2.SubtaskPart => part.type === "subtask"),
      )
      const coderTasks = subtasks.filter((part) => part.task_role === "coder")
      expect(coderTasks).toHaveLength(1)
      const coderID = coderTasks[0]?.task_id ?? coderTasks[0]?.id
      const testerTask = subtasks.find((part) => part.task_role === "tester")
      if (coderID) expect(testerTask?.blocked_by).toContain(coderID)
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("pure test-only request may execute tester-only taskgraph without forcing coder", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      yield* llm.text(
        JSON.stringify({
          nodes: [
            {
              id: "tests_only",
              task_role: "tester",
              description: "Run tests only and report failures",
              blocked_by: [],
              needs_research: false,
              tags: ["test-only"],
            },
          ],
        }),
      )
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes('subagent_type":"tester"'), "tester done")
      yield* llm.text("final done")
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("Persistence mode:"), "writer done")

      yield* user(
        chat.id,
        ["Run tests only for the existing behavior.", "Do not change code.", "Only verify and report."].join("\n"),
        "orchestrator",
      )
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const subtasks = msgs.flatMap((msg) =>
        msg.parts.filter((part): part is MessageV2.SubtaskPart => part.type === "subtask"),
      )
      expect(subtasks.some((part) => part.task_role === "tester")).toBe(true)
      expect(subtasks.some((part) => part.task_role === "coder")).toBe(false)
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("implementation request with tester-only planner graph auto-injects coder tasks before tester", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      yield* llm.text(
        JSON.stringify({
          nodes: [
            {
              id: "test_missing_impl",
              task_role: "tester",
              description: "Validate implementation for feature X",
              blocked_by: [],
              needs_research: false,
              tags: ["test"],
            },
          ],
        }),
      )
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes('subagent_type":"coder"'), "coder core done")
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes('subagent_type":"coder"'), "coder integration done")
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes('subagent_type":"tester"'), "tester done")
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("Persistence mode:"), "writer done")
      yield* llm.text("final done")

      yield* user(chat.id, "Implement feature X and make sure it passes tests.", "orchestrator")
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const subtasks = msgs.flatMap((msg) =>
        msg.parts.filter((part): part is MessageV2.SubtaskPart => part.type === "subtask"),
      )
      const coderTasks = subtasks.filter((part) => part.task_role === "coder")
      const testerTask = subtasks.find((part) => part.task_role === "tester" && part.task_id === "test_missing_impl")
      expect(coderTasks.length).toBeGreaterThanOrEqual(1)
      expect(testerTask).toBeDefined()
      const coderTaskIDs = coderTasks.map((task) => task.task_id ?? task.id)
      for (const id of coderTaskIDs) expect(testerTask?.blocked_by).toContain(id)
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("non-small implementation graph with one coder is normalized to two coders", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      yield* llm.text(
        JSON.stringify({
          nodes: [
            {
              id: "single_impl",
              task_role: "coder",
              description: "Implement feature flag behavior",
              blocked_by: [],
              needs_research: false,
              tags: ["impl"],
            },
            {
              id: "test_single_impl",
              task_role: "tester",
              description: "Validate feature flag behavior",
              blocked_by: ["single_impl"],
              needs_research: false,
              tags: ["test"],
            },
          ],
        }),
      )
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes('subagent_type":"coder"'), "coder primary done")
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes('subagent_type":"coder"'), "coder secondary done")
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes('subagent_type":"tester"'), "tester done")
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("Persistence mode:"), "writer done")
      yield* llm.text("final done")

      yield* user(
        chat.id,
        [
          "Implement feature flag support and wire it through CLI and runtime behavior.",
          "Add tests for the new behavior and verify integration paths.",
        ].join("\n"),
        "orchestrator",
      )
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const subtasks = msgs.flatMap((msg) =>
        msg.parts.filter((part): part is MessageV2.SubtaskPart => part.type === "subtask"),
      )
      const coderTasks = subtasks.filter((part) => part.task_role === "coder")
      expect(coderTasks.length).toBeGreaterThanOrEqual(2)
      const coderTaskIDs = coderTasks.map((part) => part.task_id ?? part.id)
      const testerTask = subtasks.find((part) => part.task_role === "tester" && part.task_id === "test_single_impl")
      expect(testerTask).toBeDefined()
      for (const id of coderTaskIDs) expect(testerTask?.blocked_by).toContain(id)
      const runnableWithoutCompletedCoder = subtasks.filter((part) => {
        if (part.task_role !== "coder" && part.task_role !== "tester") return false
        const blocked = part.blocked_by ?? []
        return blocked.length === 0
      })
      expect(runnableWithoutCompletedCoder.some((part) => part.task_role === "tester")).toBe(false)
      const oneCoderCompleted = coderTaskIDs[0] ? [coderTaskIDs[0]] : []
      const runnableWithOneCoder = subtasks.filter((part) => {
        if (part.task_role !== "coder" && part.task_role !== "tester") return false
        const blocked = part.blocked_by ?? []
        return blocked.every((id) => oneCoderCompleted.includes(id))
      })
      expect(runnableWithOneCoder.some((part) => part.task_role === "tester")).toBe(false)
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("five-coder-ready-parallel dispatches all five coder tasks in one round", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const coderIDs = ["coder_1", "coder_2", "coder_3", "coder_4", "coder_5"]

      yield* llm.text(
        JSON.stringify({
          nodes: [
            ...coderIDs.map((id) => ({
              id,
              task_role: "coder",
              description: `Implement ${id}`,
              blocked_by: [],
              needs_research: false,
              tags: ["impl"],
            })),
            {
              id: "test_all",
              task_role: "tester",
              description: "Validate all implementation work",
              blocked_by: coderIDs,
              needs_research: false,
              tags: ["test"],
            },
            {
              id: "review_all",
              task_role: "reviewer",
              description: "Review integrated implementation",
              blocked_by: ["test_all"],
              tags: ["review"],
            },
          ],
        }),
      )

      const gate = defer<void>()
      const coderMatch = (id: string) => (hit: { body: unknown }) => JSON.stringify(hit.body).includes(`Implement ${id}`)
      for (const id of coderIDs) {
        yield* llm.pushMatch(coderMatch(id), reply().wait(gate.promise).text(`${id} done`).stop())
      }
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("Validate all implementation work"), "tester done")
      yield* llm.textMatch(
        (hit) => JSON.stringify(hit.body).includes("Review integrated implementation"),
        JSON.stringify({ passed: true, notes: "ok" }),
      )
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("Persistence mode:"), "writer done")
      yield* llm.text("final done")

      const plannerUser = yield* user(
        chat.id,
        "Execute the planner task graph for a large implementation request.",
        "orchestrator",
      )
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: plannerUser.id,
        sessionID: chat.id,
        type: "subtask",
        task_role: "planner",
        task_id: "planner:seed_parallel5",
        blocked_by: [],
        tags: ["taskgraph", "seeded"],
        description: "Build TaskGraph",
        agent: "planner",
        model: ref,
        prompt: "Build an executable TaskGraph for this request and return JSON only.",
      } satisfies MessageV2.SubtaskPart)
      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

      let observedCoderCalls = 0
      for (let attempt = 0; attempt < 1500; attempt += 1) {
        const hits = yield* llm.hits
        observedCoderCalls = hits.filter((hit) => coderIDs.some((id) => coderMatch(id)(hit))).length
        if (observedCoderCalls >= 5) break
        yield* Effect.sleep(20)
      }
      expect(observedCoderCalls).toBe(5)

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const subtasks = msgs.flatMap((msg) =>
        msg.parts.filter((part): part is MessageV2.SubtaskPart => part.type === "subtask"),
      )
      const coderTasks = subtasks.filter((part) => part.task_role === "coder")
      expect(coderTasks).toHaveLength(5)
      const testerTask = subtasks.find((part) => part.task_role === "tester" && part.task_id === "test_all")
      const coderTaskIDs = coderTasks.map((part) => part.task_id ?? part.id)
      expect(testerTask).toBeDefined()
      for (const id of coderTaskIDs) expect(testerTask?.blocked_by).toContain(id)
      yield* prompt.cancel(chat.id)
      gate.resolve()
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("coder-concurrency-limit keeps first dispatch batch at five when seven coders are ready", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const coderIDs = ["coder_1", "coder_2", "coder_3", "coder_4", "coder_5", "coder_6", "coder_7"]

      yield* llm.text(
        JSON.stringify({
          nodes: [
            ...coderIDs.map((id) => ({
              id,
              task_role: "coder",
              description: `Implement ${id}`,
              blocked_by: [],
              needs_research: false,
              tags: ["impl"],
            })),
            {
              id: "test_all",
              task_role: "tester",
              description: "Validate all implementation work",
              blocked_by: coderIDs,
              needs_research: false,
              tags: ["test"],
            },
          ],
        }),
      )

      const gate = defer<void>()
      const coderMatch = (id: string) => (hit: { body: unknown }) => JSON.stringify(hit.body).includes(`Implement ${id}`)
      for (let index = 0; index < coderIDs.length; index += 1) {
        const output = `${coderIDs[index]} done`
        if (index < 5) {
          yield* llm.pushMatch(coderMatch(coderIDs[index]!), reply().wait(gate.promise).text(output).stop())
          continue
        }
        yield* llm.pushMatch(coderMatch(coderIDs[index]!), reply().text(output).stop())
      }
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("Validate all implementation work"), "tester done")
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("Persistence mode:"), "writer done")
      yield* llm.text("final done")

      const plannerUser = yield* user(
        chat.id,
        "Execute the planner task graph for seven independent implementations.",
        "orchestrator",
      )
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: plannerUser.id,
        sessionID: chat.id,
        type: "subtask",
        task_role: "planner",
        task_id: "planner:seed_limit7",
        blocked_by: [],
        tags: ["taskgraph", "seeded"],
        description: "Build TaskGraph",
        agent: "planner",
        model: ref,
        prompt: "Build an executable TaskGraph for this request and return JSON only.",
      } satisfies MessageV2.SubtaskPart)
      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

      let firstBatchCalls = 0
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const hits = yield* llm.hits
        firstBatchCalls = hits.filter((hit) => coderIDs.some((id) => coderMatch(id)(hit))).length
        if (firstBatchCalls >= 5) break
        yield* Effect.sleep(20)
      }
      expect(firstBatchCalls).toBe(5)
      yield* Effect.sleep(200)
      const hitsBeforeRelease = yield* llm.hits
      expect(hitsBeforeRelease.filter((hit) => coderIDs.some((id) => coderMatch(id)(hit))).length).toBe(5)
      yield* prompt.cancel(chat.id)
      gate.resolve()
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      const hitsAfterCancel = yield* llm.hits
      expect(hitsAfterCancel.filter((hit) => coderIDs.some((id) => coderMatch(id)(hit))).length).toBe(5)
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("tester-concurrency-limit keeps first dispatch batch at two when three testers are ready", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const testerIDs = ["tests_a", "tests_b", "tests_c"]

      yield* llm.text(
        JSON.stringify({
          nodes: testerIDs.map((id) => ({
            id,
            task_role: "tester",
            description: `Run ${id}`,
            blocked_by: [],
            needs_research: false,
            tags: ["test-only"],
          })),
        }),
      )

      const gate = defer<void>()
      const testerMatch = (id: string) => (hit: { body: unknown }) => JSON.stringify(hit.body).includes(`Run ${id}`)
      for (let index = 0; index < testerIDs.length; index += 1) {
        const output = `${testerIDs[index]} done`
        if (index < 2) {
          yield* llm.pushMatch(testerMatch(testerIDs[index]!), reply().wait(gate.promise).text(output).stop())
          continue
        }
        yield* llm.pushMatch(testerMatch(testerIDs[index]!), reply().text(output).stop())
      }
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("Persistence mode:"), "writer done")
      yield* llm.text("final done")

      const plannerUser = yield* user(
        chat.id,
        ["Run tests only for existing behavior.", "Do not change code.", "Only verify test suites."].join("\n"),
        "orchestrator",
      )
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: plannerUser.id,
        sessionID: chat.id,
        type: "subtask",
        task_role: "planner",
        task_id: "planner:seed_tester_limit3",
        blocked_by: [],
        tags: ["taskgraph", "seeded"],
        description: "Build TaskGraph",
        agent: "planner",
        model: ref,
        prompt: "Build an executable TaskGraph for this request and return JSON only.",
      } satisfies MessageV2.SubtaskPart)
      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

      let firstBatchTesterCalls = 0
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const hits = yield* llm.hits
        firstBatchTesterCalls = hits.filter((hit) => testerIDs.some((id) => testerMatch(id)(hit))).length
        if (firstBatchTesterCalls >= 2) break
        yield* Effect.sleep(20)
      }
      expect(firstBatchTesterCalls).toBe(2)
      yield* Effect.sleep(200)
      const hitsBeforeRelease = yield* llm.hits
      expect(hitsBeforeRelease.filter((hit) => testerIDs.some((id) => testerMatch(id)(hit))).length).toBe(2)
      yield* prompt.cancel(chat.id)
      gate.resolve()
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      const hitsAfterCancel = yield* llm.hits
      expect(hitsAfterCancel.filter((hit) => testerIDs.some((id) => testerMatch(id)(hit))).length).toBe(2)
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("tester remains blocked when dependent coder is incomplete", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      yield* llm.text(
        JSON.stringify({
          nodes: [
            {
              id: "coder_only",
              task_role: "coder",
              description: "Implement single coder workstream",
              blocked_by: [],
              needs_research: false,
              tags: ["impl", "single_scope:small_change"],
            },
            {
              id: "tester_dep_a",
              task_role: "tester",
              description: "Validate dependent suite A",
              blocked_by: ["coder_only"],
              needs_research: false,
              tags: ["test"],
            },
            {
              id: "tester_dep_b",
              task_role: "tester",
              description: "Validate dependent suite B",
              blocked_by: ["coder_only"],
              needs_research: false,
              tags: ["test"],
            },
          ],
        }),
      )
      const coderGate = defer<void>()
      const coderMatch = (hit: { body: unknown }) => JSON.stringify(hit.body).includes("Implement single coder workstream")
      const testerAMatch = (hit: { body: unknown }) => JSON.stringify(hit.body).includes("Validate dependent suite A")
      const testerBMatch = (hit: { body: unknown }) => JSON.stringify(hit.body).includes("Validate dependent suite B")
      yield* llm.pushMatch(coderMatch, reply().wait(coderGate.promise).text("coder done").stop())
      yield* llm.textMatch(testerAMatch, "tester A done")
      yield* llm.textMatch(testerBMatch, "tester B done")
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("Persistence mode:"), "writer done")
      yield* llm.text("final done")

      const plannerUser = yield* user(chat.id, "Execute the seeded graph exactly.", "orchestrator")
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: plannerUser.id,
        sessionID: chat.id,
        type: "subtask",
        task_role: "planner",
        task_id: "planner:seed_tester_dep_block",
        blocked_by: [],
        tags: ["taskgraph", "seeded"],
        description: "Build TaskGraph",
        agent: "planner",
        model: ref,
        prompt: "Build an executable TaskGraph for this request and return JSON only.",
      } satisfies MessageV2.SubtaskPart)
      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

      let observedCoderCalls = 0
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const hits = yield* llm.hits
        observedCoderCalls = hits.filter(coderMatch).length
        if (observedCoderCalls >= 1) break
        yield* Effect.sleep(20)
      }
      expect(observedCoderCalls).toBe(1)
      yield* Effect.sleep(200)
      const hitsBeforeCoderComplete = yield* llm.hits
      expect(hitsBeforeCoderComplete.filter(testerAMatch).length).toBe(0)
      expect(hitsBeforeCoderComplete.filter(testerBMatch).length).toBe(0)
      yield* prompt.cancel(chat.id)
      coderGate.resolve()
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("reviewer becomes ready only after both tester tasks complete", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      yield* llm.text(
        JSON.stringify({
          nodes: [
            {
              id: "coder_a",
              task_role: "coder",
              description: "Implement module A changes",
              blocked_by: [],
              needs_research: false,
              tags: ["impl"],
            },
            {
              id: "coder_b",
              task_role: "coder",
              description: "Implement module B changes",
              blocked_by: [],
              needs_research: false,
              tags: ["impl"],
            },
            {
              id: "tester_a",
              task_role: "tester",
              description: "Validate integration suite A",
              blocked_by: ["coder_a", "coder_b"],
              needs_research: false,
              tags: ["test"],
            },
            {
              id: "tester_b",
              task_role: "tester",
              description: "Validate integration suite B",
              blocked_by: ["coder_a", "coder_b"],
              needs_research: false,
              tags: ["test"],
            },
            {
              id: "review_dual",
              task_role: "reviewer",
              description: "Review integration after dual tester validation",
              blocked_by: ["tester_a", "tester_b"],
              tags: ["review"],
            },
          ],
        }),
      )

      const plannerUser = yield* user(
        chat.id,
        "Implement feature integration and validate with two parallel test suites before review.",
        "orchestrator",
      )
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: plannerUser.id,
        sessionID: chat.id,
        type: "subtask",
        task_role: "planner",
        task_id: "planner:seed_reviewer_waits_testers",
        blocked_by: [],
        tags: ["taskgraph", "seeded"],
        description: "Build TaskGraph",
        agent: "planner",
        model: ref,
        prompt: "Build an executable TaskGraph for this request and return JSON only.",
      } satisfies MessageV2.SubtaskPart)
      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

      let subtasks: MessageV2.SubtaskPart[] = []
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
        subtasks = msgs.flatMap((msg) => msg.parts.filter((part): part is MessageV2.SubtaskPart => part.type === "subtask"))
        const coderCount = subtasks.filter((part) => part.task_role === "coder").length
        const testerCount = subtasks.filter((part) => part.task_role === "tester").length
        const hasReviewer = subtasks.some((part) => part.task_role === "reviewer" && part.task_id === "review_dual")
        if (coderCount >= 2 && testerCount >= 2 && hasReviewer) break
        yield* Effect.sleep(20)
      }
      const coderTasks = subtasks.filter((part) => part.task_role === "coder")
      const testerTasks = subtasks.filter((part) => part.task_role === "tester")
      const reviewerTask = subtasks.find((part) => part.task_role === "reviewer" && part.task_id === "review_dual")
      expect(coderTasks.length).toBeGreaterThanOrEqual(2)
      expect(testerTasks.length).toBeGreaterThanOrEqual(2)
      expect(reviewerTask).toBeDefined()
      const coderTaskIDs = coderTasks.map((part) => part.task_id ?? part.id)
      const testerTaskIDs = testerTasks.map((part) => part.task_id ?? part.id)
      for (const id of coderTaskIDs) expect(reviewerTask?.blocked_by).toContain(id)
      for (const id of testerTaskIDs) expect(reviewerTask?.blocked_by).toContain(id)
      const completedWithOneTester = [...coderTaskIDs, ...(testerTaskIDs[0] ? [testerTaskIDs[0]] : [])]
      const readyAfterOneTester = (reviewerTask?.blocked_by ?? []).every((id) => completedWithOneTester.includes(id))
      expect(readyAfterOneTester).toBe(false)
      const completedWithAllTesters = [...coderTaskIDs, ...testerTaskIDs]
      const readyAfterAllTesters = (reviewerTask?.blocked_by ?? []).every((id) => completedWithAllTesters.includes(id))
      expect(readyAfterAllTesters).toBe(true)
      yield* prompt.cancel(chat.id)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("coder-only graph still allows writer finalizer after coder completion", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const plannerMatch = (hit: { body: unknown }) =>
        JSON.stringify(hit.body).includes("Build an executable TaskGraph")

      yield* llm.textMatch(
        plannerMatch,
        JSON.stringify({
          nodes: [
            {
              id: "cert_impl_only",
              task_role: "coder",
              description: "Generate cert files in requested path",
              blocked_by: [],
              needs_research: false,
              tags: ["tls"],
            },
          ],
        }),
      )
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("You are `coder`"), "coder core done")
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("You are `coder`"), "coder integration done")
      yield* llm.textMatch(
        (hit) => JSON.stringify(hit.body).includes("You are `tester`"),
        "passed. verified /app/check_cert.py and /app/ssl/server.key",
      )
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("You are `coder`"), "coder integration verified")
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("Persistence mode:"), "writer done")
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("You are codemate"), "final done")

      const plannerUser = yield* user(chat.id, "Generate cert artifacts only.", "orchestrator")
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: plannerUser.id,
        sessionID: chat.id,
        type: "subtask",
        task_role: "planner",
        task_id: "planner:seed_coder_only_writer_gate",
        blocked_by: [],
        tags: ["taskgraph", "seeded"],
        description: "Build TaskGraph",
        agent: "planner",
        model: ref,
        prompt: "Build an executable TaskGraph for this request and return JSON only.",
      } satisfies MessageV2.SubtaskPart)
      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const calls = yield* llm.calls
        if (calls > 0) break
        yield* Effect.sleep(20)
      }
      yield* prompt.cancel(chat.id)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("tester dependency guard: coder local sanity claim does not satisfy tester verification stage", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "coder-local-sanity-not-final" })

      yield* llm.text(
        JSON.stringify({
          nodes: [
            {
              id: "coder_impl",
              task_role: "coder",
              description: "Implement TLS artifacts",
              blocked_by: [],
              needs_research: false,
              tags: ["impl"],
            },
            {
              id: "tester_verify",
              task_role: "tester",
              description: "Verify TLS artifacts and requirements",
              blocked_by: ["coder_impl"],
              needs_research: false,
              tags: ["test"],
            },
          ],
        }),
      )
      yield* llm.textMatch(
        (hit) => JSON.stringify(hit.body).includes("Implement TLS artifacts"),
        "implemented. local sanity check passed. all requirements verified.",
      )
      yield* llm.textMatch(
        (hit) => JSON.stringify(hit.body).includes("Verify TLS artifacts and requirements"),
        "tester executed verification and passed",
      )
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("Persistence mode:"), "writer done")
      yield* llm.text("final done")

      const plannerUser = yield* user(
        chat.id,
        "Implement TLS artifacts and verify requirements with tester.",
        "orchestrator",
      )
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: plannerUser.id,
        sessionID: chat.id,
        type: "subtask",
        task_role: "planner",
        task_id: "planner:tester_dependency_local_sanity",
        blocked_by: [],
        tags: ["taskgraph", "seeded"],
        description: "Build TaskGraph",
        agent: "planner",
        model: ref,
        prompt: "Build an executable TaskGraph for this request and return JSON only.",
      } satisfies MessageV2.SubtaskPart)
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      const hits = yield* llm.hits
      const testerCalls = hits.filter((hit) => JSON.stringify(hit.body).includes("Verify TLS artifacts and requirements"))
      expect(testerCalls.length).toBeGreaterThan(0)
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("tester-waits-for-all-coders requires 5/5 coder completion", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const coderIDs = ["coder_1", "coder_2", "coder_3", "coder_4", "coder_5"]

      yield* llm.text(
        JSON.stringify({
          nodes: [
            ...coderIDs.map((id) => ({
              id,
              task_role: "coder",
              description: `Implement ${id}`,
              blocked_by: [],
              needs_research: false,
              tags: ["impl"],
            })),
            {
              id: "test_all",
              task_role: "tester",
              description: "Validate all implementation work",
              blocked_by: ["coder_1"],
              needs_research: false,
              tags: ["test"],
            },
          ],
        }),
      )
      const gate = defer<void>()
      const coderMatch = (id: string) => (hit: { body: unknown }) => JSON.stringify(hit.body).includes(`Implement ${id}`)
      for (const id of coderIDs) {
        yield* llm.pushMatch(coderMatch(id), reply().wait(gate.promise).text(`${id} done`).stop())
      }

      const plannerUser = yield* user(
        chat.id,
        "Execute the planner task graph for five-module implementation and validation.",
        "orchestrator",
      )
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: plannerUser.id,
        sessionID: chat.id,
        type: "subtask",
        task_role: "planner",
        task_id: "planner:seed_wait5",
        blocked_by: [],
        tags: ["taskgraph", "seeded"],
        description: "Build TaskGraph",
        agent: "planner",
        model: ref,
        prompt: "Build an executable TaskGraph for this request and return JSON only.",
      } satisfies MessageV2.SubtaskPart)
      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      let observedCoderCalls = 0
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const hits = yield* llm.hits
        observedCoderCalls = hits.filter((hit) => coderIDs.some((id) => coderMatch(id)(hit))).length
        if (observedCoderCalls >= 5) break
        yield* Effect.sleep(20)
      }
      expect(observedCoderCalls).toBe(5)

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const subtasks = msgs.flatMap((msg) =>
        msg.parts.filter((part): part is MessageV2.SubtaskPart => part.type === "subtask"),
      )
      const coderTasks = subtasks.filter((part) => part.task_role === "coder")
      expect(coderTasks).toHaveLength(5)
      const normalizedCoderIDs = coderTasks.map((part) => part.task_id ?? part.id)
      const testerTask = subtasks.find((part) => part.task_role === "tester" && part.task_id === "test_all")
      expect(testerTask).toBeDefined()
      for (const id of normalizedCoderIDs) expect(testerTask?.blocked_by).toContain(id)
      const completedFour = normalizedCoderIDs.slice(0, 4)
      const readyAfterFour = (testerTask?.blocked_by ?? []).every((id) => completedFour.includes(id))
      expect(readyAfterFour).toBe(false)
      const readyAfterFive = (testerTask?.blocked_by ?? []).every((id) => normalizedCoderIDs.includes(id))
      expect(readyAfterFive).toBe(true)
      yield* prompt.cancel(chat.id)
      gate.resolve()
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("reviewer-pressure splits reviewer into batches plus final synthesis when coder fan-in is high", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const coderIDs = ["coder_1", "coder_2", "coder_3", "coder_4", "coder_5"]

      yield* llm.text(
        JSON.stringify({
          nodes: [
            ...coderIDs.map((id) => ({
              id,
              task_role: "coder",
              description: `Implement ${id}`,
              blocked_by: [],
              needs_research: false,
              tags: ["impl"],
            })),
            {
              id: "test_all",
              task_role: "tester",
              description: "Validate all implementation work",
              blocked_by: coderIDs,
              needs_research: false,
              tags: ["test"],
            },
            {
              id: "review_all",
              task_role: "reviewer",
              description: "Review integrated implementation",
              blocked_by: ["test_all"],
              tags: ["review"],
            },
          ],
        }),
      )
      const gate = defer<void>()
      const coderMatch = (id: string) => (hit: { body: unknown }) => JSON.stringify(hit.body).includes(`Implement ${id}`)
      for (const id of coderIDs) {
        yield* llm.pushMatch(coderMatch(id), reply().wait(gate.promise).text(`${id} done`).stop())
      }

      const plannerUser = yield* user(
        chat.id,
        "Execute the planner task graph for high fan-in reviewer pressure testing.",
        "orchestrator",
      )
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: plannerUser.id,
        sessionID: chat.id,
        type: "subtask",
        task_role: "planner",
        task_id: "planner:seed_review_batch",
        blocked_by: [],
        tags: ["taskgraph", "seeded"],
        description: "Build TaskGraph",
        agent: "planner",
        model: ref,
        prompt: "Build an executable TaskGraph for this request and return JSON only.",
      } satisfies MessageV2.SubtaskPart)
      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      let observedCoderCalls = 0
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const hits = yield* llm.hits
        observedCoderCalls = hits.filter((hit) => coderIDs.some((id) => coderMatch(id)(hit))).length
        if (observedCoderCalls >= 5) break
        yield* Effect.sleep(20)
      }
      expect(observedCoderCalls).toBe(5)

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const subtasks = msgs.flatMap((msg) =>
        msg.parts.filter((part): part is MessageV2.SubtaskPart => part.type === "subtask"),
      )
      const reviewerTasks = subtasks.filter((part) => part.task_role === "reviewer")
      const reviewerBatchTasks = reviewerTasks.filter((part) => (part.tags ?? []).includes("review-batch"))
      expect(reviewerBatchTasks.length).toBeGreaterThanOrEqual(2)
      const finalReviewer = reviewerTasks.find((part) => part.task_id === "review_all")
      expect(finalReviewer).toBeDefined()
      const reviewerBatchIDs = reviewerBatchTasks.map((part) => part.task_id ?? part.id)
      for (const id of reviewerBatchIDs) expect(finalReviewer?.blocked_by).toContain(id)
      yield* prompt.cancel(chat.id)
      gate.resolve()
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("prompt emits v2 prompted and synthetic events", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "orchestrator",
        noReply: true,
        parts: [
          { type: "text", text: "hello v2" },
          {
            type: "file",
            mime: "text/plain",
            filename: "note.txt",
            url: "data:text/plain;base64,bm90ZSBjb250ZW50",
          },
        ],
      })

      const messages = yield* SessionV2.Service.use((session) => session.messages({ sessionID: chat.id })).pipe(
        Effect.provide(SessionV2.layer),
      )
      const row = Database.use((db) =>
        db.select().from(SessionMessageTable).where(Database.eq(SessionMessageTable.session_id, chat.id)).get(),
      )
      expect(messages.find((message) => message.type === "user")).toMatchObject({ type: "user", text: "hello v2" })
      expect(typeof row?.data.time.created).toBe("number")
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "synthetic", text: expect.stringContaining("Called the Read tool") }),
          expect.objectContaining({ type: "synthetic", text: "note content" }),
        ]),
      )
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("static loop returns assistant text through local provider", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Prompt provider",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "orchestrator",
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })

      yield* llm.text("world")

      const result = yield* prompt.loop({ sessionID: session.id })
      expect(result.info.role).toBe("assistant")
      expect(result.parts.some((part) => part.type === "text" && part.text === "world")).toBe(true)
      expect(yield* llm.hits).toHaveLength(1)
      expect(yield* llm.pending).toBe(0)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("static loop consumes queued replies across turns", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Prompt provider turns",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "orchestrator",
        noReply: true,
        parts: [{ type: "text", text: "hello one" }],
      })

      yield* llm.text("world one")

      const first = yield* prompt.loop({ sessionID: session.id })
      expect(first.info.role).toBe("assistant")
      expect(first.parts.some((part) => part.type === "text" && part.text === "world one")).toBe(true)

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "orchestrator",
        noReply: true,
        parts: [{ type: "text", text: "hello two" }],
      })

      yield* llm.text("world two")

      const second = yield* prompt.loop({ sessionID: session.id })
      expect(second.info.role).toBe("assistant")
      expect(second.parts.some((part) => part.type === "text" && part.text === "world two")).toBe(true)

      expect(yield* llm.hits).toHaveLength(2)
      expect(yield* llm.pending).toBe(0)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("loop continues when finish is tool-calls", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "orchestrator",
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      yield* llm.tool("first", { value: "first" })
      yield* llm.text("second")

      const result = yield* prompt.loop({ sessionID: session.id })
      expect(yield* llm.calls).toBe(2)
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") {
        expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
        expect(result.info.finish).toBe("stop")
      }
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("glob tool keeps instance context during prompt runs", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({
          title: "Glob context",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        const file = path.join(dir, "probe.txt")
        yield* Effect.promise(() => Bun.write(file, "probe"))

        yield* prompt.prompt({
          sessionID: session.id,
          agent: "orchestrator",
          noReply: true,
          parts: [{ type: "text", text: "find text files" }],
        })
        yield* llm.tool("glob", { pattern: "**/*.txt" })
        yield* llm.text("done")

        const result = yield* prompt.loop({ sessionID: session.id })
        expect(result.info.role).toBe("assistant")

        const msgs = yield* MessageV2.filterCompactedEffect(session.id)
        const tool = msgs
          .flatMap((msg) => msg.parts)
          .find(
            (part): part is CompletedToolPart =>
              part.type === "tool" && part.tool === "glob" && part.state.status === "completed",
          )
        if (!tool) return

        expect(tool.state.output).toContain(file)
        expect(tool.state.output).not.toContain("No context found for instance")
        expect(result.parts.some((part) => part.type === "text" && part.text === "done")).toBe(true)
      }),
    { git: true, config: providerCfg },
  ),
)

it.live("loop continues when finish is stop but assistant has tool parts", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "orchestrator",
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      yield* llm.push(reply().tool("first", { value: "first" }).stop())
      yield* llm.text("second")

      const result = yield* prompt.loop({ sessionID: session.id })
      expect(yield* llm.calls).toBe(2)
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") {
        expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
        expect(result.info.finish).toBe("stop")
      }
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("failed subtask preserves metadata on error tool state", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.tool("task", {
        description: "inspect bug",
        prompt: "look into the cache key path",
        subagent_type: "coder",
      })
      yield* llm.text("done")
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
      expect(yield* llm.calls).toBeGreaterThanOrEqual(2)

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "coder")
      expect(taskMsg?.info.role).toBe("assistant")
      if (!taskMsg || taskMsg.info.role !== "assistant") return

      const tool = errorTool(taskMsg.parts)
      if (!tool) return

      expect(tool.state.error).toBe("检测到当前步骤结果不符合要求，正在自动调整并重试。")
      expect(tool.state.metadata).toBeDefined()
      expect(tool.state.metadata?.sessionId).toBeDefined()
      expect(tool.state.metadata?.model).toEqual({
        providerID: ProviderID.make("test"),
        modelID: ModelID.make("missing-model"),
      })
    }),
    {
      git: true,
      config: (url) => ({
        ...providerCfg(url),
        agent: {
          coder: {
            model: "test/missing-model",
          },
        },
      }),
    },
  ),
)

it.live("review_mismatch: reviewer README output during TLS run is rejected and writer does not run", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const closedLoop = yield* Effect.gen(function* () {
        return yield* SessionClosedLoop.Service
      }).pipe(Effect.provide(SessionClosedLoop.defaultLayer))
      const chat = yield* sessions.create({ title: "review-mismatch-tls" })

      yield* llm.text(
        JSON.stringify({
          nodes: [
            { id: "cert_impl", task_role: "coder", description: "Generate TLS cert files", blocked_by: [], needs_research: false, tags: ["tls"] },
            { id: "script_impl", task_role: "coder", description: "Write cert verification script", blocked_by: ["cert_impl"], needs_research: false, tags: ["tls"] },
            { id: "test_cert", task_role: "tester", description: "Verify TLS artifacts and script output", blocked_by: ["script_impl"], needs_research: false, tags: ["test"] },
            { id: "review_tls", task_role: "reviewer", description: "Review TLS implementation and verification evidence", blocked_by: ["test_cert"], tags: ["review"] },
          ],
        }),
      )
      yield* llm.textMatch(
        (hit) => JSON.stringify(hit.body).includes("Generate TLS cert files"),
        "Created ~/app/ssl/server.key, ~/app/ssl/server.crt, ~/app/ssl/server.pem",
      )
      yield* llm.textMatch(
        (hit) => JSON.stringify(hit.body).includes("Write cert verification script"),
        "Created ~/app/check_cert.py and ~/app/ssl/verification.txt",
      )
      yield* llm.textMatch(
        (hit) => JSON.stringify(hit.body).includes("Verify TLS artifacts and script output"),
        "Certificate verification successful. Common Name=dev-internal.company.local. Fingerprint verified.",
      )
      for (let index = 0; index < 3; index += 1) {
        yield* llm.textMatch(
          (hit) => JSON.stringify(hit.body).includes("Review TLS implementation and verification evidence"),
          JSON.stringify({
            passed: true,
            notes: "Updated README architecture links and fixed markdown wording.",
          }),
        )
      }

      const plannerUser = yield* user(chat.id, "Generate TLS certs and verify under /app or ~/app fallback.", "orchestrator")
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: plannerUser.id,
        sessionID: chat.id,
        type: "subtask",
        task_role: "planner",
        task_id: "planner:seed_review_mismatch_tls",
        blocked_by: [],
        tags: ["taskgraph", "seeded"],
        description: "Build TaskGraph",
        agent: "planner",
        model: ref,
        prompt: "Build an executable TaskGraph for this request and return JSON only.",
      } satisfies MessageV2.SubtaskPart)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      let mismatchObserved = false
      for (let attempt = 0; attempt < 220; attempt += 1) {
        const records = yield* closedLoop.listTrajectory(chat.id).pipe(Effect.orElseSucceed(() => []))
        mismatchObserved = records.some((record) => {
          if (record.agent !== "reviewer" || record.outcome !== "failure") return false
          const signal = `${record.failure?.signal ?? ""} ${record.failure?.root_cause ?? ""}`.toLowerCase()
          return signal.includes("review_mismatch")
        })
        if (mismatchObserved) break
        yield* Effect.sleep(20)
      }
      expect(mismatchObserved).toBe(true)
      yield* prompt.cancel(chat.id)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)

      const hits = yield* llm.hits
      const writerCalls = hits.filter((hit) => JSON.stringify(hit.body).includes("Persistence mode:"))
      expect(writerCalls.length).toBe(0)
      const visibleText = (yield* MessageV2.filterCompactedEffect(chat.id))
        .flatMap((msg) => msg.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])))
        .join("\n")
      expect(visibleText).not.toContain("review_mismatch")
      expect(visibleText.toLowerCase()).not.toContain("guard")
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("review failure repair coder reverify reviewer retry flow is serial and writer waits final reviewer pass", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const closedLoop = yield* Effect.gen(function* () {
        return yield* SessionClosedLoop.Service
      }).pipe(Effect.provide(SessionClosedLoop.defaultLayer))
      const chat = yield* sessions.create({ title: "review-failure-repair-serial" })

      yield* llm.text(
        JSON.stringify({
          nodes: [
            { id: "impl_tls", task_role: "coder", description: "Generate TLS cert files", blocked_by: [], needs_research: false, tags: ["tls"] },
            { id: "test_tls", task_role: "tester", description: "Verify TLS artifacts and evidence", blocked_by: ["impl_tls"], needs_research: false, tags: ["test"] },
            { id: "review_tls", task_role: "reviewer", description: "Review TLS implementation and verification evidence", blocked_by: ["test_tls"], tags: ["review"] },
          ],
        }),
      )
      yield* llm.textMatch(
        (hit) => JSON.stringify(hit.body).includes("Generate TLS cert files"),
        "Created ~/app/ssl/server.key ~/app/ssl/server.crt ~/app/ssl/server.pem ~/app/ssl/verification.txt and ~/app/check_cert.py",
      )
      yield* llm.textMatch(
        (hit) => JSON.stringify(hit.body).includes("Verify TLS artifacts and evidence"),
        "Executed ~/app/check_cert.py; tester_passed=true; verified CN and fingerprint using ~/app/ssl/server.crt",
      )
      yield* llm.textMatch(
        (hit) => JSON.stringify(hit.body).includes("Review TLS implementation and verification evidence"),
        JSON.stringify({
          passed: false,
          notes: "Need to fix key permission and rerun verification evidence.",
          task_graph: {
            nodes: [
              { id: "repair_impl", task_role: "coder", description: "Fix TLS key permission and certificate metadata", blocked_by: [], needs_research: false, tags: ["repair", "tls"] },
              { id: "reverify_tls", task_role: "tester", description: "Reverify TLS evidence after repair", blocked_by: ["repair_impl"], needs_research: false, tags: ["test", "tls"] },
              { id: "recheck_tls", task_role: "reviewer", description: "Reviewer recheck after repair and reverify", blocked_by: ["reverify_tls"], tags: ["review", "tls"] },
            ],
          },
        }),
      )
      yield* llm.textMatch(
        (hit) => JSON.stringify(hit.body).includes("Fix TLS key permission and certificate metadata"),
        "Adjusted ~/app/ssl/server.key permission to 600 and regenerated verification output.",
      )
      yield* llm.textMatch(
        (hit) => JSON.stringify(hit.body).includes("Reverify TLS evidence after repair"),
        "Executed ~/app/check_cert.py; tester_passed=true; verification refreshed in ~/app/ssl/verification.txt",
      )
      yield* llm.textMatch(
        (hit) => JSON.stringify(hit.body).includes("Reviewer recheck after repair and reverify"),
        JSON.stringify({
          passed: true,
          notes:
            "approved: tester verification passed for ~/app/ssl/server.crt via ~/app/check_cert.py with CN and fingerprint evidence",
        }),
      )
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("Persistence mode:"), "writer done")
      yield* llm.text("final done")

      const plannerUser = yield* user(chat.id, "Generate TLS certs, verify, and complete review.", "orchestrator")
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: plannerUser.id,
        sessionID: chat.id,
        type: "subtask",
        task_role: "planner",
        task_id: "planner:seed_review_failure_repair_serial",
        blocked_by: [],
        tags: ["taskgraph", "seeded"],
        description: "Build TaskGraph",
        agent: "planner",
        model: ref,
        prompt: "Build an executable TaskGraph for this request and return JSON only.",
      } satisfies MessageV2.SubtaskPart)

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      const hits = yield* llm.hits

      const subtasks = (yield* MessageV2.filterCompactedEffect(chat.id)).flatMap((msg) =>
        msg.parts.filter((part): part is MessageV2.SubtaskPart => part.type === "subtask"),
      )
      const repairCoder = subtasks.find((task) => task.description.includes("Fix TLS key permission and certificate metadata"))
      const reverifyTask = subtasks.find((task) => task.description.includes("Reverify TLS evidence after repair"))
      const recheckTask = subtasks.find((task) => task.description.includes("Reviewer recheck after repair and reverify"))
      expect(repairCoder).toBeDefined()
      expect(reverifyTask).toBeDefined()
      expect(recheckTask).toBeDefined()
      if (!repairCoder || !reverifyTask || !recheckTask) return
      expect(reverifyTask.blocked_by ?? []).toContain(repairCoder.task_id ?? repairCoder.id)
      expect(recheckTask.blocked_by ?? []).toContain(reverifyTask.task_id ?? reverifyTask.id)
      expect(recheckTask.blocked_by ?? []).toContain(repairCoder.task_id ?? repairCoder.id)

      const completed = yield* closedLoop.listCompletedSubtasks(chat.id)
      expect(completed).not.toContain("review_tls")

      const texts = (yield* MessageV2.filterCompactedEffect(chat.id))
        .flatMap((msg) => msg.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])))
      const statusLine = "审查未通过，系统正在修复发现的问题并重新验证。"
      const statusCount = texts.filter((text) => text.includes(statusLine)).length
      expect(statusCount).toBe(1)
      const visibleText = texts.join("\n").toLowerCase()
      expect(visibleText).not.toContain("taskgraphpatch")
      expect(visibleText).not.toContain("prompt.ts")
      expect(visibleText).not.toContain("stack trace")
      expect(visibleText).not.toContain("guard")
      expect(visibleText).not.toContain("json category")

      const writerPayload = (yield* llm.inputs).find((input) => JSON.stringify(input).includes("Persistence mode:"))
      if (writerPayload) {
        const writerBody = JSON.stringify(writerPayload)
        expect(writerBody).not.toContain(statusLine)
      }
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("stale_test_evidence: tester using packages/codemate/ssl is rejected and does not unblock reviewer/writer", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const closedLoop = yield* Effect.gen(function* () {
        return yield* SessionClosedLoop.Service
      }).pipe(Effect.provide(SessionClosedLoop.defaultLayer))
      const chat = yield* sessions.create({ title: "stale-tester-packages-codemate-ssl" })

      yield* llm.text(
        JSON.stringify({
          nodes: [
            { id: "cert_impl", task_role: "coder", description: "Generate TLS cert files", blocked_by: [], needs_research: false, tags: ["tls"] },
            { id: "test_cert", task_role: "tester", description: "Verify TLS artifacts", blocked_by: ["cert_impl"], needs_research: false, tags: ["test"] },
            { id: "review_tls", task_role: "reviewer", description: "Review TLS evidence", blocked_by: ["test_cert"], tags: ["review"] },
          ],
        }),
      )
      yield* llm.textMatch(
        (hit) => JSON.stringify(hit.body).includes("Generate TLS cert files"),
        "Created ~/app/ssl/server.key ~/app/ssl/server.crt ~/app/ssl/server.pem ~/app/ssl/verification.txt and ~/app/check_cert.py",
      )
      yield* llm.textMatch(
        (hit) => JSON.stringify(hit.body).includes("Verify TLS artifacts"),
        "all tests passed using packages/codemate/ssl/server.crt and packages/codemate/ssl/server.key",
      )
      for (let index = 0; index < 2; index += 1) {
        yield* llm.textMatch(
          (hit) => JSON.stringify(hit.body).includes("Verify TLS artifacts"),
          "all tests passed using packages/codemate/ssl/server.crt and packages/codemate/ssl/server.key",
        )
      }

      const plannerUser = yield* user(chat.id, "Generate TLS certs in /app or ~/app fallback and verify.", "orchestrator")
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: plannerUser.id,
        sessionID: chat.id,
        type: "subtask",
        task_role: "planner",
        task_id: "planner:seed_stale_test_evidence_packages_ssl",
        blocked_by: [],
        tags: ["taskgraph", "seeded"],
        description: "Build TaskGraph",
        agent: "planner",
        model: ref,
        prompt: "Build an executable TaskGraph for this request and return JSON only.",
      } satisfies MessageV2.SubtaskPart)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      let staleDetected = false
      for (let attempt = 0; attempt < 220; attempt += 1) {
        const records = yield* closedLoop.listTrajectory(chat.id).pipe(Effect.orElseSucceed(() => []))
        staleDetected = records.some((record) => {
          if (record.agent !== "tester" || record.outcome !== "failure") return false
          const signal = `${record.failure?.signal ?? ""} ${record.failure?.root_cause ?? ""}`.toLowerCase()
          return signal.includes("stale_test_evidence")
        })
        if (staleDetected) break
        yield* Effect.sleep(20)
      }
      expect(staleDetected).toBe(true)
      yield* prompt.cancel(chat.id)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)

      const records = yield* closedLoop.listTrajectory(chat.id).pipe(Effect.orElseSucceed(() => []))
      expect(
        records.some(
          (record) => record.agent === "tester" && record.quality_signals.tester_passed === true,
        ),
      ).toBe(false)
      const hits = yield* llm.hits
      const reviewerCalls = hits.filter((hit) => JSON.stringify(hit.body).includes("Review TLS evidence"))
      const writerCalls = hits.filter((hit) => JSON.stringify(hit.body).includes("Persistence mode:"))
      expect(reviewerCalls.length).toBe(0)
      expect(writerCalls.length).toBe(0)
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("stale_test_evidence: tester using test/certs is rejected and does not unblock reviewer/writer", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const closedLoop = yield* Effect.gen(function* () {
        return yield* SessionClosedLoop.Service
      }).pipe(Effect.provide(SessionClosedLoop.defaultLayer))
      const chat = yield* sessions.create({ title: "stale-tester-test-certs" })

      yield* llm.text(
        JSON.stringify({
          nodes: [
            { id: "cert_impl", task_role: "coder", description: "Generate TLS cert files", blocked_by: [], needs_research: false, tags: ["tls"] },
            { id: "test_cert", task_role: "tester", description: "Verify TLS artifacts", blocked_by: ["cert_impl"], needs_research: false, tags: ["test"] },
            { id: "review_tls", task_role: "reviewer", description: "Review TLS evidence", blocked_by: ["test_cert"], tags: ["review"] },
          ],
        }),
      )
      yield* llm.textMatch(
        (hit) => JSON.stringify(hit.body).includes("Generate TLS cert files"),
        "Created ~/app/ssl/server.key ~/app/ssl/server.crt ~/app/ssl/server.pem ~/app/ssl/verification.txt and ~/app/check_cert.py",
      )
      yield* llm.textMatch(
        (hit) => JSON.stringify(hit.body).includes("Verify TLS artifacts"),
        "passed by reusing test/certs/server.crt and test/certs/server.key",
      )
      for (let index = 0; index < 2; index += 1) {
        yield* llm.textMatch(
          (hit) => JSON.stringify(hit.body).includes("Verify TLS artifacts"),
          "passed by reusing test/certs/server.crt and test/certs/server.key",
        )
      }

      const plannerUser = yield* user(chat.id, "Generate TLS certs in /app or ~/app fallback and verify.", "orchestrator")
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: plannerUser.id,
        sessionID: chat.id,
        type: "subtask",
        task_role: "planner",
        task_id: "planner:seed_stale_test_evidence_test_certs",
        blocked_by: [],
        tags: ["taskgraph", "seeded"],
        description: "Build TaskGraph",
        agent: "planner",
        model: ref,
        prompt: "Build an executable TaskGraph for this request and return JSON only.",
      } satisfies MessageV2.SubtaskPart)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      let staleDetected = false
      for (let attempt = 0; attempt < 220; attempt += 1) {
        const records = yield* closedLoop.listTrajectory(chat.id).pipe(Effect.orElseSucceed(() => []))
        staleDetected = records.some((record) => {
          if (record.agent !== "tester" || record.outcome !== "failure") return false
          const signal = `${record.failure?.signal ?? ""} ${record.failure?.root_cause ?? ""}`.toLowerCase()
          return signal.includes("stale_test_evidence")
        })
        if (staleDetected) break
        yield* Effect.sleep(20)
      }
      expect(staleDetected).toBe(true)
      yield* prompt.cancel(chat.id)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)

      const hits = yield* llm.hits
      const reviewerCalls = hits.filter((hit) => JSON.stringify(hit.body).includes("Review TLS evidence"))
      const writerCalls = hits.filter((hit) => JSON.stringify(hit.body).includes("Persistence mode:"))
      expect(reviewerCalls.length).toBe(0)
      expect(writerCalls.length).toBe(0)
    }),
    { git: true, config: providerCfg },
  ),
30_000)

if (false) it.live("tester evidence missing_actual_output_evidence when actual_output_paths is empty", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const closedLoop = yield* Effect.gen(function* () {
        return yield* SessionClosedLoop.Service
      }).pipe(Effect.provide(SessionClosedLoop.defaultLayer))
      const chat = yield* sessions.create({ title: "missing-actual-output-evidence" })

      yield* llm.text(
        JSON.stringify({
          nodes: [
            { id: "test_cert", task_role: "tester", description: "Verify TLS artifacts", blocked_by: [], needs_research: false, tags: ["test"] },
          ],
        }),
      )
      yield* llm.textMatch(
        (hit) => JSON.stringify(hit.body).includes("Verify TLS artifacts"),
        "passed. verified /app/check_cert.py and /app/ssl/server.key",
      )
      for (let index = 0; index < 12; index += 1) {
        yield* llm.textMatch(
          (hit) => JSON.stringify(hit.body).includes("Verify TLS artifacts"),
          "passed. verified /app/check_cert.py and /app/ssl/server.key",
        )
      }

      const plannerUser = yield* user(chat.id, "Generate cert files under /app/ssl.", "orchestrator")
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: plannerUser.id,
        sessionID: chat.id,
        type: "subtask",
        task_role: "planner",
        task_id: "planner:seed_missing_actual_output_evidence",
        blocked_by: [],
        tags: ["taskgraph", "seeded"],
        description: "Build TaskGraph",
        agent: "planner",
        model: ref,
        prompt: "Build an executable TaskGraph for this request and return JSON only.",
      } satisfies MessageV2.SubtaskPart)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      let missingActualDetected = false
      for (let attempt = 0; attempt < 220; attempt += 1) {
        const records = yield* closedLoop.listTrajectory(chat.id).pipe(Effect.orElseSucceed(() => []))
        missingActualDetected = records.some((record) => {
          if (record.agent !== "tester" || record.outcome !== "failure") return false
          const signal = `${record.failure?.signal ?? ""} ${record.failure?.root_cause ?? ""}`.toLowerCase()
          return signal.includes("missing_actual_output_evidence")
        })
        if (missingActualDetected) break
        yield* Effect.sleep(20)
      }
      expect(missingActualDetected).toBe(true)
      yield* prompt.cancel(chat.id)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("writer path binding integration claims only trajectory actual paths", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "writer-path-binding-tls" })

      yield* llm.text(
        JSON.stringify({
          nodes: [
            { id: "cert_impl", task_role: "coder", description: "Generate TLS cert files", blocked_by: [], needs_research: false, tags: ["tls"] },
            { id: "test_cert", task_role: "tester", description: "Verify TLS artifacts", blocked_by: ["cert_impl"], needs_research: false, tags: ["test"] },
          ],
        }),
      )
      yield* llm.textMatch(
        (hit) => JSON.stringify(hit.body).includes("Generate TLS cert files"),
        `Generated ${HOME_APP}/ssl/server.key ${HOME_APP}/ssl/server.crt ${HOME_APP}/ssl/server.pem ${HOME_APP}/ssl/verification.txt`,
      )
      for (let index = 0; index < 4; index += 1) {
        yield* llm.textMatch(
          (hit) => JSON.stringify(hit.body).includes("Generate TLS cert files"),
          `Generated ${HOME_APP}/ssl/server.key ${HOME_APP}/ssl/server.crt ${HOME_APP}/ssl/server.pem ${HOME_APP}/ssl/verification.txt`,
        )
      }
      yield* llm.textMatch(
        (hit) => JSON.stringify(hit.body).includes("Verify TLS artifacts"),
        `Certificate verification successful at ${HOME_APP}/ssl/server.crt via ${HOME_APP}/check_cert.py. CN=dev-internal.company.local.`,
      )
      for (let index = 0; index < 6; index += 1) {
        yield* llm.textMatch(
          (hit) => JSON.stringify(hit.body).includes("Verify TLS artifacts"),
          `Certificate verification successful at ${HOME_APP}/ssl/server.crt via ${HOME_APP}/check_cert.py. CN=dev-internal.company.local.`,
        )
      }
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("Persistence mode:"), "writer done")
      for (let index = 0; index < 2; index += 1) {
        yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("Persistence mode:"), "writer done")
      }
      yield* llm.text("final done")

      const plannerUser = yield* user(chat.id, "Generate TLS certs with /app fallback to ~/app if needed.", "orchestrator")
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: plannerUser.id,
        sessionID: chat.id,
        type: "subtask",
        task_role: "planner",
        task_id: "planner:seed_writer_path_binding_tls",
        blocked_by: [],
        tags: ["taskgraph", "seeded"],
        description: "Build TaskGraph",
        agent: "planner",
        model: ref,
        prompt: "Build an executable TaskGraph for this request and return JSON only.",
      } satisfies MessageV2.SubtaskPart)
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
      const testerBody = JSON.stringify(
        (yield* llm.inputs).find((input) => JSON.stringify(input).includes("Tester evidence binding:")) ?? {},
      )
      expect(testerBody).toContain("Actual output paths from coder trajectory (test only these):")
      expect(testerBody).toContain("missing_actual_output_evidence")
      expect(testerBody).toContain(`${HOME_APP}/ssl/server.key`)
      expect(testerBody).not.toContain("~/app/ssl/server.key")
      expect(testerBody).not.toContain(
        "Actual output paths from coder trajectory (test only these): /app/ssl/server.key",
      )
      const writerBody = JSON.stringify((yield* llm.inputs).find((input) => JSON.stringify(input).includes("Persistence mode:")) ?? {})
      expect(writerBody).toContain("Required paths (contract): /app/ssl/server.key")
      expect(writerBody).toContain(`Fallback paths (contract): ${HOME_APP}/ssl/server.key`)
      expect(writerBody).toContain(`Actual output paths (source=trajectory evidence): ${HOME_APP}/ssl/server.key`)
      expect(writerBody).toContain("<path_context>")
      expect(writerBody).toContain("claim only actual output paths")
      expect(writerBody).toContain(`${HOME_APP}/ssl`)
      expect(writerBody).toContain("Path binding rule: this run used fallback absolute app path under HOME")
      expect(writerBody).toContain("Topic binding rule")
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("sanitize wrong_path guard failure for user-visible task error", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "sanitize-wrong-path" })
      yield* llm.text(
        JSON.stringify({
          nodes: [
            {
              id: "impl_tls",
              task_role: "coder",
              description: "Generate TLS cert outputs at required path",
              blocked_by: [],
              needs_research: false,
              tags: ["tls"],
            },
          ],
        }),
      )
      yield* llm.textMatch(
        (hit) => JSON.stringify(hit.body).includes("Generate TLS cert outputs at required path"),
        "created /util/ssl/server.key and /project/verification.txt",
      )
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("Verify"), "tester done")
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("Persistence mode:"), "writer done")
      yield* llm.text("final done")

      const plannerUser = yield* user(chat.id, "Generate cert files under /app/ssl.", "orchestrator")
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: plannerUser.id,
        sessionID: chat.id,
        type: "subtask",
        task_role: "planner",
        task_id: "planner:seed_sanitize_wrong_path",
        blocked_by: [],
        tags: ["taskgraph", "seeded"],
        description: "Build TaskGraph",
        agent: "planner",
        model: ref,
        prompt: "Build an executable TaskGraph for this request and return JSON only.",
      } satisfies MessageV2.SubtaskPart)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      let observedError = ""
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
        const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "coder")
        if (!taskMsg || taskMsg.info.role !== "assistant") {
          yield* Effect.sleep(20)
          continue
        }
        const tool = toolPart(taskMsg.parts)
        if (!tool || tool.state.status !== "error") {
          yield* Effect.sleep(20)
          continue
        }
        observedError = tool.state.error
        break
      }
      const visibleMessages = (yield* MessageV2.filterCompactedEffect(chat.id))
        .flatMap((msg) =>
          msg.parts.flatMap((part) => {
            if (part.type === "text") return [part.text]
            if (part.type === "tool" && part.state.status === "error") return [part.state.error]
            return []
          }),
        )
        .join("\n")
      if (observedError) {
        expect(observedError).toBe("检测到产物路径不符合要求，正在自动修正。")
      }
      expect(visibleMessages).not.toContain("[wrong_path]")
      expect(visibleMessages.toLowerCase()).not.toContain("guard")
      expect(visibleMessages).not.toContain("src/tool/task.ts")
      yield* prompt.cancel(chat.id)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("sanitize stale_artifact failure hides internal category and stack trace", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "sanitize-stale-artifact" })
      yield* llm.text(
        JSON.stringify({
          nodes: [
            {
              id: "impl_tls",
              task_role: "coder",
              description: "Generate TLS cert outputs at required path",
              blocked_by: [],
              needs_research: false,
              tags: ["tls"],
            },
          ],
        }),
      )
      yield* llm.textMatch(
        (hit) => JSON.stringify(hit.body).includes("Generate TLS cert outputs at required path"),
        "reused test/certs/server.crt and packages/codemate/ssl/server.key\nat src/tool/task.ts:315:9",
      )
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("Verify"), "tester done")
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("Persistence mode:"), "writer done")
      yield* llm.text("final done")
      const plannerUser = yield* user(chat.id, "Generate cert files under /app/ssl.", "orchestrator")
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: plannerUser.id,
        sessionID: chat.id,
        type: "subtask",
        task_role: "planner",
        task_id: "planner:seed_sanitize_stale_artifact",
        blocked_by: [],
        tags: ["taskgraph", "seeded"],
        description: "Build TaskGraph",
        agent: "planner",
        model: ref,
        prompt: "Build an executable TaskGraph for this request and return JSON only.",
      } satisfies MessageV2.SubtaskPart)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      let observedError = ""
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
        const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "coder")
        if (!taskMsg || taskMsg.info.role !== "assistant") {
          yield* Effect.sleep(20)
          continue
        }
        const tool = toolPart(taskMsg.parts)
        if (!tool || tool.state.status !== "error") {
          yield* Effect.sleep(20)
          continue
        }
        observedError = tool.state.error
        break
      }
      const visibleMessages = (yield* MessageV2.filterCompactedEffect(chat.id))
        .flatMap((msg) =>
          msg.parts.flatMap((part) => {
            if (part.type === "text") return [part.text]
            if (part.type === "tool" && part.state.status === "error") return [part.state.error]
            return []
          }),
        )
        .join("\n")
      if (observedError) {
        expect(observedError).toBe("检测到产物路径不符合要求，正在自动修正。")
      }
      expect(visibleMessages).not.toContain("[stale_artifact]")
      expect(visibleMessages).not.toContain("src/tool/task.ts")
      expect(visibleMessages.toLowerCase()).not.toContain("stack")
      yield* prompt.cancel(chat.id)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("sanitize tool_unavailable failure hides internal module path", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "sanitize-tool-unavailable" })
      const prev = process.env.codemate_TEST_FORCE_TREE_SITTER_WASM_MISSING
      process.env.codemate_TEST_FORCE_TREE_SITTER_WASM_MISSING = "1"
      try {
        yield* llm.text(
          JSON.stringify({
            nodes: [
              {
                id: "impl_tls",
                task_role: "coder",
                description: "Generate TLS cert outputs at required path",
                blocked_by: [],
                needs_research: false,
                tags: ["tls"],
              },
            ],
          }),
        )
        yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("Verify"), "tester done")
        yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("Persistence mode:"), "writer done")
        yield* llm.text("final done")
        const plannerUser = yield* user(chat.id, "Generate cert files under /app/ssl with openssl.", "orchestrator")
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: plannerUser.id,
          sessionID: chat.id,
          type: "subtask",
          task_role: "planner",
          task_id: "planner:seed_sanitize_tool_unavailable",
          blocked_by: [],
          tags: ["taskgraph", "seeded"],
          description: "Build TaskGraph",
          agent: "planner",
          model: ref,
          prompt: "Build an executable TaskGraph for this request and return JSON only.",
        } satisfies MessageV2.SubtaskPart)

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        let observedError = ""
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "coder")
          if (!taskMsg || taskMsg.info.role !== "assistant") {
            yield* Effect.sleep(20)
            continue
          }
          const tool = toolPart(taskMsg.parts)
          if (!tool || tool.state.status !== "error") {
            yield* Effect.sleep(20)
            continue
          }
          observedError = tool.state.error
          break
        }
        const visibleMessages = (yield* MessageV2.filterCompactedEffect(chat.id))
          .flatMap((msg) =>
            msg.parts.flatMap((part) => {
              if (part.type === "text") return [part.text]
              if (part.type === "tool" && part.state.status === "error") return [part.state.error]
              return []
            }),
          )
          .join("\n")
        if (observedError) {
          expect(observedError).toBe("任务无法继续，需要处理：当前 shell 工具暂不可用，请检查环境后重试。")
        }
        expect(visibleMessages).not.toContain("[tool_unavailable]")
        expect(visibleMessages).not.toContain("tree-sitter")
        expect(visibleMessages).not.toContain("src/tool")
        yield* prompt.cancel(chat.id)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
      } finally {
        if (prev === undefined) delete process.env.codemate_TEST_FORCE_TREE_SITTER_WASM_MISSING
        else process.env.codemate_TEST_FORCE_TREE_SITTER_WASM_MISSING = prev
      }
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("tool_schema_error retries once then caps, with sanitized user-visible error and structured retry signal", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "sanitize-tool-schema-error" })

      yield* llm.text(
        JSON.stringify({
          nodes: [
            {
              id: "schema_write_step",
              task_role: "coder",
              description: "schema write step",
              blocked_by: [],
              needs_research: false,
              tags: ["write"],
            },
          ],
        }),
      )
      const schemaMatch = (hit: { body: unknown }) => JSON.stringify(hit.body).includes("schema write step")
      const schemaMessage = 'write failed: SchemaError(Missing key at ["filePath"])'
      yield* llm.pushMatch(schemaMatch, reply().streamError(schemaMessage).item())
      yield* llm.pushMatch(schemaMatch, reply().streamError(schemaMessage).item())

      const plannerUser = yield* user(chat.id, "Create a file under /app/ssl and write verification output.", "orchestrator")
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: plannerUser.id,
        sessionID: chat.id,
        type: "subtask",
        task_role: "planner",
        task_id: "planner:seed_tool_schema_error",
        blocked_by: [],
        tags: ["taskgraph", "seeded"],
        description: "Build TaskGraph",
        agent: "planner",
        model: ref,
        prompt: "Build an executable TaskGraph for this request and return JSON only.",
      } satisfies MessageV2.SubtaskPart)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      for (let attempt = 0; attempt < 260; attempt += 1) {
        const hits = yield* llm.hits
        const coderCalls = hits.filter((hit) => JSON.stringify(hit.body).includes("schema write step"))
        if (coderCalls.length >= 2) break
        yield* Effect.sleep(20)
      }

      yield* Effect.sleep(200)
      const hits = yield* llm.hits
      const coderCalls = hits.filter((hit) => JSON.stringify(hit.body).includes("schema write step"))
      expect(coderCalls.length).toBe(2)

      const visibleMessages = (yield* MessageV2.filterCompactedEffect(chat.id))
        .flatMap((msg) =>
          msg.parts.flatMap((part) => {
            if (part.type === "text") return [part.text]
            if (part.type === "tool" && part.state.status === "error") return [part.state.error]
            return []
          }),
        )
        .join("\n")
      expect(visibleMessages).not.toContain("SchemaError")
      expect(visibleMessages).not.toContain("Missing key at")
      expect(visibleMessages).not.toContain("[tool_schema_error]")

      yield* prompt.cancel(chat.id)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live("tool_call_invalid retries once then caps, with sanitized user-visible error", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "sanitize-tool-call-invalid" })

      yield* llm.text(
        JSON.stringify({
          nodes: [
            {
              id: "invalid_tool_step",
              task_role: "coder",
              description: "invalid tool step",
              blocked_by: [],
              needs_research: false,
              tags: ["runtime"],
            },
          ],
        }),
      )
      const invalidMatch = (hit: { body: unknown }) => JSON.stringify(hit.body).includes("invalid tool step")
      const invalidMessage =
        '[tool_call_invalid] {"category":"tool_call_invalid","tool_name":"ls -la ~/app/ssl","error_category":"unknown_tool","repair_instruction":"use bash tool for shell commands","reason":"Unknown tool: ls -la ~/app/ssl"}'
      yield* llm.pushMatch(invalidMatch, reply().streamError(invalidMessage).item())
      yield* llm.pushMatch(invalidMatch, reply().streamError(invalidMessage).item())
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("Persistence mode:"), "writer done")
      yield* llm.text("final done")

      const plannerUser = yield* user(chat.id, "List files from /app/ssl and continue.", "orchestrator")
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: plannerUser.id,
        sessionID: chat.id,
        type: "subtask",
        task_role: "planner",
        task_id: "planner:seed_tool_call_invalid",
        blocked_by: [],
        tags: ["taskgraph", "seeded"],
        description: "Build TaskGraph",
        agent: "planner",
        model: ref,
        prompt: "Build an executable TaskGraph for this request and return JSON only.",
      } satisfies MessageV2.SubtaskPart)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      for (let attempt = 0; attempt < 260; attempt += 1) {
        const hits = yield* llm.hits
        const coderCalls = hits.filter((hit) => JSON.stringify(hit.body).includes("invalid tool step"))
        if (coderCalls.length >= 2) break
        yield* Effect.sleep(20)
      }

      yield* Effect.sleep(200)
      const hits = yield* llm.hits
      const coderCalls = hits.filter((hit) => JSON.stringify(hit.body).includes("invalid tool step"))
      expect(coderCalls.length).toBe(2)

      const visibleMessages = (yield* MessageV2.filterCompactedEffect(chat.id))
        .flatMap((msg) =>
          msg.parts.flatMap((part) => {
            if (part.type === "text") return [part.text]
            if (part.type === "tool" && part.state.status === "error") return [part.state.error]
            return []
          }),
        )
        .join("\n")
      expect(visibleMessages).not.toContain("Unknown tool")
      expect(visibleMessages).not.toContain("[tool_call_invalid]")
      expect(visibleMessages).not.toContain("src/session")
      expect(visibleMessages).not.toContain("at ")

      yield* prompt.cancel(chat.id)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
    }),
    { git: true, config: providerCfg },
  ),
30_000)

it.live(
  "running subtask preserves metadata after tool-call transition",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.hang
        const msg = yield* user(chat.id, "hello")
        yield* addSubtask(chat.id, msg.id)

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

        const tool = yield* Effect.promise(async () => {
          const end = Date.now() + 5_000
          while (Date.now() < end) {
            const msgs = await Effect.runPromise(MessageV2.filterCompactedEffect(chat.id))
            const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "coder")
            const tool = taskMsg?.parts.find((part): part is MessageV2.ToolPart => part.type === "tool")
            if (tool?.state.status === "running" && tool.state.metadata?.sessionId) return tool
            await new Promise((done) => setTimeout(done, 20))
          }
          throw new Error("timed out waiting for running subtask metadata")
        })

        if (tool.state.status !== "running") return
        expect(typeof tool.state.metadata?.sessionId).toBe("string")
        expect(tool.state.title).toBeDefined()
        expect(tool.state.metadata?.model).toBeDefined()

        yield* prompt.cancel(chat.id)
        yield* Fiber.await(fiber)
      }),
      { git: true, config: providerCfg },
    ),
  5_000,
)

it.live(
  "running task tool preserves metadata after tool-call transition",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({
          title: "Pinned",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* llm.tool("task", {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "coder",
        })
        yield* llm.hang
        yield* user(chat.id, "hello")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

        const tool = yield* Effect.promise(async () => {
          const end = Date.now() + 5_000
          while (Date.now() < end) {
            const msgs = await Effect.runPromise(MessageV2.filterCompactedEffect(chat.id))
            const assistant = msgs.findLast((item) => item.info.role === "assistant" && item.info.agent === "orchestrator")
            const tool = assistant?.parts.find(
              (part): part is MessageV2.ToolPart => part.type === "tool" && part.tool === "task",
            )
            if (tool?.state.status === "running" && tool.state.metadata?.sessionId) return tool
            await new Promise((done) => setTimeout(done, 20))
          }
          throw new Error("timed out waiting for running task metadata")
        })

        if (tool.state.status !== "running") return
        expect(typeof tool.state.metadata?.sessionId).toBe("string")
        expect(tool.state.title).toBe("inspect bug")
        expect(tool.state.metadata?.model).toBeDefined()

        yield* prompt.cancel(chat.id)
        yield* Fiber.await(fiber)
      }),
      { git: true, config: providerCfg },
    ),
  10_000,
)

it.live(
  "loop sets status to busy then idle",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const status = yield* SessionStatus.Service

        yield* llm.hang

        const chat = yield* sessions.create({})
        yield* user(chat.id, "hi")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)
        expect((yield* status.get(chat.id)).type).toBe("busy")
        yield* prompt.cancel(chat.id)
        yield* Fiber.await(fiber)
        expect((yield* status.get(chat.id)).type).toBe("idle")
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

// Cancel semantics

it.live(
  "cancel interrupts loop and resolves with an assistant message",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* seed(chat.id)

        yield* llm.hang

        yield* user(chat.id, "more")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)
        yield* prompt.cancel(chat.id)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
        }
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

it.live(
  "cancel records MessageAbortedError on interrupted process",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.hang
        yield* user(chat.id, "hello")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)
        yield* prompt.cancel(chat.id)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          const info = exit.value.info
          if (info.role === "assistant") {
            expect(info.error?.name).toBe("MessageAbortedError")
          }
        }
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

it.live(
  "cancel finalizes subtask tool state",
  () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const ready = defer<void>()
          const aborted = defer<void>()
          const registry = yield* ToolRegistry.Service
          const { task } = yield* registry.named()
          const original = task.execute
          task.execute = (_args, ctx) =>
            Effect.callback<never>((_resume) => {
              ready.resolve()
              ctx.abort.addEventListener("abort", () => aborted.resolve(), { once: true })
              return Effect.sync(() => aborted.resolve())
            })
          yield* Effect.addFinalizer(() => Effect.sync(() => void (task.execute = original)))

          const { prompt, chat } = yield* boot()
          const msg = yield* user(chat.id, "hello")
          yield* addSubtask(chat.id, msg.id)

          const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
          yield* Effect.promise(() => ready.promise)
          yield* prompt.cancel(chat.id)
          yield* Effect.promise(() => aborted.promise)

          const exit = yield* Fiber.await(fiber)
          expect(Exit.isSuccess(exit)).toBe(true)

          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "coder")
          expect(taskMsg?.info.role).toBe("assistant")
          if (!taskMsg || taskMsg.info.role !== "assistant") return

          const tool = toolPart(taskMsg.parts)
          expect(tool?.type).toBe("tool")
          if (!tool) return

          expect(tool.state.status).not.toBe("running")
          expect(taskMsg.info.time.completed).toBeDefined()
          expect(taskMsg.info.finish).toBeDefined()
        }),
      { git: true, config: cfg },
    ),
  30_000,
)

it.live(
  "cancel propagates from slash command subtask to child session",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const status = yield* SessionStatus.Service
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.hang
        const msg = yield* user(chat.id, "hello")
        yield* addSubtask(chat.id, msg.id)

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)

        const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
        const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "coder")
        const tool = taskMsg ? toolPart(taskMsg.parts) : undefined
        const sessionID = tool?.state.status === "running" ? tool.state.metadata?.sessionId : undefined
        expect(typeof sessionID).toBe("string")
        if (typeof sessionID !== "string") throw new Error("missing child session id")
        const childID = SessionID.make(sessionID)
        expect((yield* status.get(childID)).type).toBe("busy")

        yield* prompt.cancel(chat.id)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)

        expect((yield* status.get(chat.id)).type).toBe("idle")
        expect((yield* status.get(childID)).type).toBe("idle")
      }),
      { git: true, config: providerCfg },
    ),
  10_000,
)

it.live(
  "cancel with queued callers resolves all cleanly",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.hang
        yield* user(chat.id, "hello")

        const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)
        const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* Effect.sleep(50)

        yield* prompt.cancel(chat.id)
        const [exitA, exitB] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
        expect(Exit.isSuccess(exitA)).toBe(true)
        expect(Exit.isSuccess(exitB)).toBe(true)
        if (Exit.isSuccess(exitA) && Exit.isSuccess(exitB)) {
          expect(exitA.value.info.id).toBe(exitB.value.info.id)
        }
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

it.live(
  "cancelled run is isolated from next run intent and stale TLS subtask does not execute again",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })
        const tlsMarker = "Research TLS self-signed certificate steps"
        const plannerPromptMarker = "Build an executable TaskGraph for this request."

        yield* llm.textMatch(
          (hit) => {
            const body = JSON.stringify(hit.body)
            return body.includes(plannerPromptMarker) && body.includes("self-signed TLS certificate")
          },
          JSON.stringify({
            nodes: [
              {
                id: "research_tls",
                task_role: "research",
                description: tlsMarker,
                blocked_by: [],
                needs_research: false,
                tags: ["research", "tls"],
              },
              {
                id: "fix_tls",
                task_role: "coder",
                description: "Apply TLS certificate workflow",
                blocked_by: ["research_tls"],
                needs_research: false,
                tags: ["tls"],
              },
            ],
          }),
        )
        const gate = defer<void>()
        yield* llm.pushMatch((hit) => JSON.stringify(hit.body).includes(tlsMarker), reply().wait(gate.promise).text("research tls done").stop())

        yield* user(
          chat.id,
          "Create a self-signed TLS certificate for internal development server with verification output.",
          "orchestrator",
        )
        const runA = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        for (let i = 0; i < 200; i += 1) {
          const hits = yield* llm.hits
          if (hits.some((hit) => JSON.stringify(hit.body).includes(tlsMarker))) break
          yield* Effect.sleep(20)
        }
        yield* prompt.cancel(chat.id)
        gate.resolve()
        const exitA = yield* Fiber.await(runA)
        expect(Exit.isSuccess(exitA)).toBe(true)

        yield* llm.textMatch(
          (hit) => {
            const body = JSON.stringify(hit.body)
            return (
              body.includes(plannerPromptMarker) &&
              body.includes("User request:\\nFix one README.md typo and keep dependency chain explicit.") &&
              !body.includes(
                "User request:\\nCreate a self-signed TLS certificate for internal development server with verification output.",
              )
            )
          },
          JSON.stringify({
            nodes: [
              {
                id: "research_readme",
                task_role: "research",
                description: "Find README typo",
                blocked_by: [],
                needs_research: false,
                tags: ["research", "readme"],
              },
              {
                id: "fix_readme",
                task_role: "coder",
                description: "Fix README typo based on findings",
                blocked_by: ["research_readme"],
                needs_research: false,
                tags: ["readme", "typo"],
              },
              {
                id: "test_readme",
                task_role: "tester",
                description: "Verify README typo fix",
                blocked_by: ["fix_readme"],
                needs_research: false,
                tags: ["test"],
              },
              {
                id: "review_readme",
                task_role: "reviewer",
                description: "Review README typo fix",
                blocked_by: ["test_readme"],
                tags: ["review"],
              },
            ],
          }),
        )
        yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("Find README typo"), "research done")
        yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("Fix README typo based on findings"), "coder done")
        yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("Verify README typo fix"), "tester done")
        yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("Review README typo fix"), JSON.stringify({ passed: true, notes: "ok" }))
        yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("Persistence mode:"), "writer done")
        yield* llm.text("final done")

        yield* user(chat.id, "Fix one README.md typo and keep dependency chain explicit.", "orchestrator")
        const runB = yield* prompt.loop({ sessionID: chat.id })
        expect(runB.info.role).toBe("assistant")
      }),
      { git: true, config: providerCfg },
    ),
  30_000,
)

it.live(
  "cancelled run cleanup clears completed subtasks and does not run writer persistence",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ dir, llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const closedLoop = yield* Effect.gen(function* () {
          return yield* SessionClosedLoop.Service
        }).pipe(Effect.provide(SessionClosedLoop.defaultLayer))
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.hang
        const msg = yield* user(chat.id, "Investigate and patch cache path bug.", "orchestrator")
        yield* addSubtask(chat.id, msg.id)

        const run = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)
        yield* prompt.cancel(chat.id)
        const exit = yield* Fiber.await(run)
        expect(Exit.isSuccess(exit)).toBe(true)

        const completed = yield* closedLoop.listCompletedSubtasks(chat.id)
        expect(completed).toHaveLength(0)

        const hits = yield* llm.hits
        expect(hits.some((hit) => JSON.stringify(hit.body).includes("Persistence mode:"))).toBe(false)

        const changelog = path.join(dir, ".codemate", "changelog.md")
        const lessons = path.join(dir, ".codemate", "lessons.jsonl")
        const changelogExists = yield* Effect.promise(() => fs.access(changelog).then(() => true).catch(() => false))
        const lessonsExists = yield* Effect.promise(() => fs.access(lessons).then(() => true).catch(() => false))
        expect(changelogExists).toBe(false)
        expect(lessonsExists).toBe(false)
      }),
      { git: true, config: providerCfg },
    ),
  10_000,
)

it.live(
  "scheduler skips stale queued tasks when run_id/intent/source mismatch current run",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })
        const staleUser = yield* user(chat.id, "Legacy TLS task request", "orchestrator")
        const staleMarker = "STALE TLS TASK MUST NOT RUN"
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: staleUser.id,
          sessionID: chat.id,
          type: "subtask",
          task_role: "coder",
          task_id: "stale_tls_task",
          run_id: "run_old",
          intent_anchor_hash: "ia:old",
          source_user_message_id: staleUser.id,
          blocked_by: [],
          needs_research: false,
          tags: ["tls", "stale"],
          description: staleMarker,
          agent: "coder",
          model: ref,
          prompt: staleMarker,
        } satisfies MessageV2.SubtaskPart)

        yield* llm.textMatch(
          (hit) => {
            const body = JSON.stringify(hit.body)
            return body.includes("Build an executable TaskGraph for this request.") && body.includes("README")
          },
          JSON.stringify({
            nodes: [
              {
                id: "fix_readme",
                task_role: "coder",
                description: "Fix README typo in install section",
                blocked_by: [],
                needs_research: false,
                tags: ["readme", "typo"],
              },
              {
                id: "test_readme",
                task_role: "tester",
                description: "Verify README typo fix",
                blocked_by: ["fix_readme"],
                needs_research: false,
                tags: ["test"],
              },
              {
                id: "review_readme",
                task_role: "reviewer",
                description: "Review README typo fix",
                blocked_by: ["test_readme"],
                tags: ["review"],
              },
            ],
          }),
        )
        yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("Fix README typo in install section"), "coder done")
        yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("Verify README typo fix"), "tester done")
        yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("Review README typo fix"), JSON.stringify({ passed: true, notes: "ok" }))
        yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("Persistence mode:"), "writer done")
        yield* llm.text("final done")

        yield* user(chat.id, "Fix README typo and verify behavior.", "orchestrator")
        const result = yield* prompt.loop({ sessionID: chat.id })
        expect(result.info.role).toBe("assistant")

        const hits = yield* llm.hits
        expect(hits.some((hit) => JSON.stringify(hit.body).includes(staleMarker))).toBe(false)
      }),
      { git: true, config: providerCfg },
    ),
  30_000,
)

it.live(
  "active run + interruption hey keeps run state and does not create new planner task",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const closedLoop = yield* Effect.gen(function* () {
          return yield* SessionClosedLoop.Service
        }).pipe(Effect.provide(SessionClosedLoop.defaultLayer))
        const chat = yield* sessions.create({ title: "Pinned" })
        const requestText = "Implement tiny cache key fix."
        const request = yield* user(chat.id, requestText, "orchestrator")
        const runID = "run_active_hey"
        const completedTaskKey = "coder:done-before-interruption"
        yield* closedLoop.startRun({
          sessionID: chat.id,
          run_id: runID,
          source_message_id: request.id,
          intent_anchor_hash: intentHash(requestText),
        })
        yield* closedLoop.markSubtaskCompleted({ sessionID: chat.id, taskKey: completedTaskKey })

        yield* user(chat.id, "hey", "orchestrator")
        const result = yield* prompt.loop({ sessionID: chat.id })
        expect(result.info.role).toBe("assistant")
        const replyText = bodyText(result.parts)
        expect(replyText).toContain("still working")

        const hits = yield* llm.hits
        expect(hits.some((hit) => JSON.stringify(hit.body).includes("Build an executable TaskGraph for this request."))).toBe(false)

        const activeRun = yield* closedLoop.activeRun(chat.id)
        expect(activeRun?.run_id).toBe(runID)
        expect(activeRun?.status).toBe("active")
        const completed = yield* closedLoop.listCompletedSubtasks(chat.id)
        expect(completed).toContain(completedTaskKey)
      }),
      { git: true, config: providerCfg },
    ),
  10_000,
)

it.live(
  "active run + status interruption returns status only in Chinese without new TaskGraph",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const closedLoop = yield* Effect.gen(function* () {
          return yield* SessionClosedLoop.Service
        }).pipe(Effect.provide(SessionClosedLoop.defaultLayer))
        const chat = yield* sessions.create({ title: "Pinned" })
        const requestText = "Implement tiny cache key fix."
        const request = yield* user(chat.id, requestText, "orchestrator")
        const runID = "run_active_status_zh"
        yield* closedLoop.startRun({
          sessionID: chat.id,
          run_id: runID,
          source_message_id: request.id,
          intent_anchor_hash: intentHash(requestText),
        })

        yield* user(chat.id, "现在到哪了", "orchestrator")
        const result = yield* prompt.loop({ sessionID: chat.id })
        expect(result.info.role).toBe("assistant")
        const replyText = bodyText(result.parts)
        expect(replyText).toContain("我还在执行当前任务")

        const hits = yield* llm.hits
        expect(hits.some((hit) => JSON.stringify(hit.body).includes("Build an executable TaskGraph for this request."))).toBe(false)
      }),
      { git: true, config: providerCfg },
    ),
  10_000,
)

it.live(
  "active run + interruption cancel enters cancel path",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const closedLoop = yield* Effect.gen(function* () {
          return yield* SessionClosedLoop.Service
        }).pipe(Effect.provide(SessionClosedLoop.defaultLayer))
        const chat = yield* sessions.create({ title: "Pinned" })
        const requestText = "Implement tiny cache key fix."
        const request = yield* user(chat.id, requestText, "orchestrator")
        const runID = "run_active_cancel"
        yield* closedLoop.startRun({
          sessionID: chat.id,
          run_id: runID,
          source_message_id: request.id,
          intent_anchor_hash: intentHash(requestText),
        })

        yield* user(chat.id, "取消", "orchestrator")
        const result = yield* prompt.loop({ sessionID: chat.id })
        expect(result.info.role).toBe("assistant")
        expect(bodyText(result.parts)).toContain("已取消当前任务")

        const activeRun = yield* closedLoop.activeRun(chat.id)
        expect(activeRun?.run_id).toBe(runID)
        expect(activeRun?.status).toBe("cancelled")
      }),
      { git: true, config: providerCfg },
    ),
  10_000,
)

it.live(
  "active run + requirement change enters replan path",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const closedLoop = yield* Effect.gen(function* () {
          return yield* SessionClosedLoop.Service
        }).pipe(Effect.provide(SessionClosedLoop.defaultLayer))
        const chat = yield* sessions.create({ title: "Pinned" })
        const requestText = "Implement tiny cache key fix."
        const request = yield* user(chat.id, requestText, "orchestrator")
        const runID = "run_active_replan_before"
        yield* closedLoop.startRun({
          sessionID: chat.id,
          run_id: runID,
          source_message_id: request.id,
          intent_anchor_hash: intentHash(requestText),
        })
        yield* llm.text("replan acknowledged")

        const changed = yield* user(chat.id, "改需求：改成只输出 OK", "orchestrator")
        const result = yield* prompt.loop({ sessionID: chat.id })
        expect(result.info.role).toBe("assistant")

        const activeRun = yield* closedLoop.activeRun(chat.id)
        expect(activeRun).toBeDefined()
        if (!activeRun) return
        expect(["active", "completed"]).toContain(activeRun.status)
        expect(activeRun?.run_id).not.toBe(runID)
        expect(activeRun?.source_message_id).toBe(changed.id)
      }),
      { git: true, config: providerCfg },
    ),
  10_000,
)

// Queue semantics

it.live("concurrent loop callers get same result", () =>
  provideTmpdirInstance(
    (_dir) =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()
        yield* seed(chat.id, { finish: "stop" })

        const [a, b] = yield* Effect.all([prompt.loop({ sessionID: chat.id }), prompt.loop({ sessionID: chat.id })], {
          concurrency: "unbounded",
        })

        expect(a.info.id).toBe(b.info.id)
        expect(a.info.role).toBe("assistant")
        yield* run.assertNotBusy(chat.id)
      }),
    { git: true },
  ),
)

it.live(
  "concurrent loop callers all receive same error result",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })

        yield* llm.fail("boom")
        yield* user(chat.id, "hello")

        const [a, b] = yield* Effect.all([prompt.loop({ sessionID: chat.id }), prompt.loop({ sessionID: chat.id })], {
          concurrency: "unbounded",
        })
        expect(a.info.id).toBe(b.info.id)
        expect(a.info.role).toBe("assistant")
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

it.live(
  "prompt submitted during an active run is included in the next LLM input",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const gate = defer<void>()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })

        yield* llm.hold("first", gate.promise)
        yield* llm.text("second")

        const a = yield* prompt
          .prompt({
            sessionID: chat.id,
            agent: "orchestrator",
            model: ref,
            parts: [{ type: "text", text: "first" }],
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)

        const id = MessageID.ascending()
        const b = yield* prompt
          .prompt({
            sessionID: chat.id,
            messageID: id,
            agent: "orchestrator",
            model: ref,
            parts: [{ type: "text", text: "second" }],
          })
          .pipe(Effect.forkChild)

        yield* Effect.promise(async () => {
          const end = Date.now() + 5000
          while (Date.now() < end) {
            const msgs = await Effect.runPromise(sessions.messages({ sessionID: chat.id }))
            if (msgs.some((msg) => msg.info.role === "user" && msg.info.id === id)) return
            await new Promise((done) => setTimeout(done, 20))
          }
          throw new Error("timed out waiting for second prompt to save")
        })

        gate.resolve()

        const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
        expect(Exit.isSuccess(ea)).toBe(true)
        expect(Exit.isSuccess(eb)).toBe(true)
        expect(yield* llm.calls).toBe(2)

        const msgs = yield* sessions.messages({ sessionID: chat.id })
        const assistants = msgs.filter((msg) => msg.info.role === "assistant")
        expect(assistants).toHaveLength(2)
        const last = assistants.at(-1)
        if (!last || last.info.role !== "assistant") throw new Error("expected second assistant")
        expect(last.info.parentID).toBe(id)
        expect(last.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)

        const inputs = yield* llm.inputs
        expect(inputs).toHaveLength(2)
        expect(JSON.stringify(inputs.at(-1)?.messages)).toContain("second")
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

it.live(
  "assertNotBusy throws BusyError when loop running",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const run = yield* SessionRunState.Service
        const sessions = yield* Session.Service
        yield* llm.hang

        const chat = yield* sessions.create({})
        yield* user(chat.id, "hi")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)

        const exit = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
        }

        yield* prompt.cancel(chat.id)
        yield* Fiber.await(fiber)
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

it.live("assertNotBusy succeeds when idle", () =>
  provideTmpdirInstance(
    (_dir) =>
      Effect.gen(function* () {
        const run = yield* SessionRunState.Service
        const sessions = yield* Session.Service

        const chat = yield* sessions.create({})
        const exit = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
        expect(Exit.isSuccess(exit)).toBe(true)
      }),
    { git: true },
  ),
)

// Shell semantics

it.live(
  "shell rejects with BusyError when loop running",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.hang
        yield* user(chat.id, "hi")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)

        const exit = yield* prompt.shell({ sessionID: chat.id, agent: "orchestrator", command: "echo hi" }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
        }

        yield* prompt.cancel(chat.id)
        yield* Fiber.await(fiber)
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

unix("shell captures stdout and stderr in completed tool output", () =>
  provideTmpdirInstance(
    (_dir) =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "orchestrator",
          command: "printf out && printf err >&2",
        })

        expect(result.info.role).toBe("assistant")
        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.output).toContain("out")
        expect(tool.state.output).toContain("err")
        expect(tool.state.metadata.output).toContain("out")
        expect(tool.state.metadata.output).toContain("err")
        yield* run.assertNotBusy(chat.id)
      }),
    { git: true, config: cfg },
  ),
)

unix("shell completes a fast command on the preferred shell", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "orchestrator",
          command: "pwd",
        })

        expect(result.info.role).toBe("assistant")
        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.input.command).toBe("pwd")
        expect(tool.state.output).toContain(dir)
        expect(tool.state.metadata.output).toContain(dir)
        yield* run.assertNotBusy(chat.id)
      }),
    { git: true, config: cfg },
  ),
)

unix(
  "shell uses configured shell over env shell",
  () =>
    withSh(() =>
      provideTmpdirInstance(
        (_dir) =>
          Effect.gen(function* () {
            if (!Bun.which("bash")) return

            const { prompt, chat } = yield* boot()
            const result = yield* prompt.shell({
              sessionID: chat.id,
              agent: "orchestrator",
              command: "[[ 1 -eq 1 ]] && printf configured",
            })

            const tool = completedTool(result.parts)
            if (!tool) return
            expect(tool.state.output).toContain("configured")
          }),
        { git: true, config: { ...cfg, shell: "bash" } },
      ),
    ),
  30_000,
)

unix("shell commands can change directory after startup", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()
        const parent = path.dirname(dir)
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "orchestrator",
          command: "cd .. && pwd",
        })

        expect(result.info.role).toBe("assistant")
        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.output).toContain(parent)
        expect(tool.state.metadata.output).toContain(parent)
        yield* run.assertNotBusy(chat.id)
      }),
    { git: true, config: cfg },
  ),
)

unix("shell lists files from the project directory", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()
        yield* Effect.promise(() => Bun.write(path.join(dir, "README.md"), "# e2e\n"))

        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "orchestrator",
          command: "command ls",
        })

        expect(result.info.role).toBe("assistant")
        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.input.command).toBe("command ls")
        expect(tool.state.output).toContain("README.md")
        expect(tool.state.metadata.output).toContain("README.md")
        yield* run.assertNotBusy(chat.id)
      }),
    { git: true, config: cfg },
  ),
)

unix("shell captures stderr from a failing command", () =>
  provideTmpdirInstance(
    (_dir) =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "orchestrator",
          command: "command -v __nonexistent_cmd_e2e__ || echo 'not found' >&2; exit 1",
        })

        expect(result.info.role).toBe("assistant")
        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.output).toContain("not found")
        expect(tool.state.metadata.output).toContain("not found")
        yield* run.assertNotBusy(chat.id)
      }),
    { git: true, config: cfg },
  ),
)

unix(
  "shell updates running metadata before process exit",
  () =>
    withSh(() =>
      provideTmpdirInstance(
        (_dir) =>
          Effect.gen(function* () {
            const { prompt, chat } = yield* boot()

            const fiber = yield* prompt
              .shell({ sessionID: chat.id, agent: "orchestrator", command: "printf first && sleep 0.2 && printf second" })
              .pipe(Effect.forkChild)

            yield* Effect.promise(async () => {
              const start = Date.now()
              while (Date.now() - start < 5000) {
                const msgs = await MessageV2.filterCompacted(MessageV2.stream(chat.id))
                const taskMsg = msgs.find((item) => item.info.role === "assistant")
                const tool = taskMsg ? toolPart(taskMsg.parts) : undefined
                if (tool?.state.status === "running" && tool.state.metadata?.output.includes("first")) return
                await new Promise((done) => setTimeout(done, 20))
              }
              throw new Error("timed out waiting for running shell metadata")
            })

            const exit = yield* Fiber.await(fiber)
            expect(Exit.isSuccess(exit)).toBe(true)
          }),
        { git: true, config: cfg },
      ),
    ),
  30_000,
)

it.live(
  "loop waits while shell runs and starts after shell exits",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({
          title: "Pinned",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* llm.text("after-shell")

        const sh = yield* prompt
          .shell({ sessionID: chat.id, agent: "orchestrator", command: "sleep 0.2" })
          .pipe(Effect.forkChild)
        yield* Effect.sleep(50)

        const loop = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* Effect.sleep(50)

        expect(yield* llm.calls).toBe(0)

        yield* Fiber.await(sh)
        const exit = yield* Fiber.await(loop)

        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
          expect(exit.value.parts.some((part) => part.type === "text" && part.text === "after-shell")).toBe(true)
        }
        expect(yield* llm.calls).toBe(1)
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

it.live(
  "shell completion resumes queued loop callers",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({
          title: "Pinned",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* llm.text("done")

        const sh = yield* prompt
          .shell({ sessionID: chat.id, agent: "orchestrator", command: "sleep 0.2" })
          .pipe(Effect.forkChild)
        yield* Effect.sleep(50)

        const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* Effect.sleep(50)

        expect(yield* llm.calls).toBe(0)

        yield* Fiber.await(sh)
        const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])

        expect(Exit.isSuccess(ea)).toBe(true)
        expect(Exit.isSuccess(eb)).toBe(true)
        if (Exit.isSuccess(ea) && Exit.isSuccess(eb)) {
          expect(ea.value.info.id).toBe(eb.value.info.id)
          expect(ea.value.info.role).toBe("assistant")
        }
        expect(yield* llm.calls).toBe(1)
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

unix(
  "command ! expansion uses configured shell over env shell",
  () =>
    withSh(() =>
      provideTmpdirServer(
        ({ llm }) =>
          Effect.gen(function* () {
            if (!Bun.which("bash")) return

            const { prompt, chat } = yield* boot()
            yield* llm.text("done")

            const result = yield* prompt.command({
              sessionID: chat.id,
              command: "probe",
              arguments: "",
            })

            expect(result.info.role).toBe("assistant")
            const inputs = yield* llm.inputs
            expect(JSON.stringify(inputs.at(-1)?.messages)).toContain("configured")
          }),
        {
          git: true,
          config: (url) => ({
            ...providerCfg(url),
            shell: "bash",
            command: {
              probe: {
                template: "Probe: !`[[ 1 -eq 1 ]] && printf configured`",
              },
            },
          }),
        },
      ),
    ),
  30_000,
)

unix(
  "cancel interrupts shell and resolves cleanly",
  () =>
    withSh(() =>
      provideTmpdirInstance(
        (_dir) =>
          Effect.gen(function* () {
            const { prompt, run, chat } = yield* boot()

            const sh = yield* prompt
              .shell({ sessionID: chat.id, agent: "orchestrator", command: "sleep 30" })
              .pipe(Effect.forkChild)
            yield* Effect.sleep(50)

            yield* prompt.cancel(chat.id)

            const status = yield* SessionStatus.Service
            expect((yield* status.get(chat.id)).type).toBe("idle")
            const busy = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
            expect(Exit.isSuccess(busy)).toBe(true)

            const exit = yield* Fiber.await(sh)
            expect(Exit.isSuccess(exit)).toBe(true)
            if (Exit.isSuccess(exit)) {
              expect(exit.value.info.role).toBe("assistant")
              const tool = completedTool(exit.value.parts)
              if (tool) {
                expect(tool.state.output).toContain("User aborted the command")
              }
            }
          }),
        { git: true, config: cfg },
      ),
    ),
  30_000,
)

unix(
  "cancel persists aborted shell result when shell ignores TERM",
  () =>
    withSh(() =>
      provideTmpdirInstance(
        (_dir) =>
          Effect.gen(function* () {
            const { prompt, chat } = yield* boot()

            const sh = yield* prompt
              .shell({ sessionID: chat.id, agent: "orchestrator", command: "trap '' TERM; sleep 30" })
              .pipe(Effect.forkChild)
            yield* Effect.sleep(50)

            yield* prompt.cancel(chat.id)

            const exit = yield* Fiber.await(sh)
            expect(Exit.isSuccess(exit)).toBe(true)
            if (Exit.isSuccess(exit)) {
              expect(exit.value.info.role).toBe("assistant")
              const tool = completedTool(exit.value.parts)
              if (tool) {
                expect(tool.state.output).toContain("User aborted the command")
              }
            }
          }),
        { git: true, config: cfg },
      ),
    ),
  30_000,
)

unix(
  "cancel finalizes interrupted bash tool output through normal truncation",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const chat = yield* sessions.create({
            title: "Interrupted bash truncation",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })

          yield* prompt.prompt({
            sessionID: chat.id,
            agent: "orchestrator",
            noReply: true,
            parts: [{ type: "text", text: "run bash" }],
          })

          yield* llm.tool("bash", {
            command:
              'i=0; while [ "$i" -lt 4000 ]; do printf "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx %05d\\n" "$i"; i=$((i + 1)); done; sleep 30',
            description: "Print many lines",
            timeout: 30_000,
            workdir: path.resolve(dir),
          })

          const run = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
          yield* llm.wait(1)
          yield* Effect.sleep(150)
          yield* prompt.cancel(chat.id)

          const exit = yield* Fiber.await(run)
          expect(Exit.isSuccess(exit)).toBe(true)
          if (Exit.isFailure(exit)) return

          const tool = completedTool(exit.value.parts)
          if (!tool) return

          expect(tool.state.metadata.truncated).toBe(true)
          expect(typeof tool.state.metadata.outputPath).toBe("string")
          expect(tool.state.output).toMatch(/\.\.\.output truncated\.\.\./)
          expect(tool.state.output).toMatch(/Full output saved to:\s+\S+/)
          expect(tool.state.output).not.toContain("Tool execution aborted")
        }),
      { git: true, config: providerCfg },
    ),
  30_000,
)

unix(
  "cancel interrupts loop queued behind shell",
  () =>
    provideTmpdirInstance(
      (_dir) =>
        Effect.gen(function* () {
          const { prompt, chat } = yield* boot()

          const sh = yield* prompt
            .shell({ sessionID: chat.id, agent: "orchestrator", command: "sleep 30" })
            .pipe(Effect.forkChild)
          yield* Effect.sleep(50)

          const loop = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
          yield* Effect.sleep(50)

          yield* prompt.cancel(chat.id)

          const exit = yield* Fiber.await(loop)
          expect(Exit.isSuccess(exit)).toBe(true)
          if (Exit.isSuccess(exit)) {
            const tool = completedTool(exit.value.parts)
            expect(tool?.state.output).toContain("User aborted the command")
          }

          yield* Fiber.await(sh)
        }),
      { git: true, config: cfg },
    ),
  30_000,
)

unix(
  "shell rejects when another shell is already running",
  () =>
    withSh(() =>
      provideTmpdirInstance(
        (_dir) =>
          Effect.gen(function* () {
            const { prompt, chat } = yield* boot()

            const a = yield* prompt
              .shell({ sessionID: chat.id, agent: "orchestrator", command: "sleep 30" })
              .pipe(Effect.forkChild)
            yield* Effect.sleep(50)

            const exit = yield* prompt
              .shell({ sessionID: chat.id, agent: "orchestrator", command: "echo hi" })
              .pipe(Effect.exit)
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) {
              expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
            }

            yield* prompt.cancel(chat.id)
            yield* Fiber.await(a)
          }),
        { git: true, config: cfg },
      ),
    ),
  30_000,
)

// Abort signal propagation tests for inline tool execution

/** Override a tool's execute to hang until aborted. Returns ready/aborted defers and a finalizer. */
function hangUntilAborted(tool: { execute: (...args: any[]) => any }) {
  const ready = defer<void>()
  const aborted = defer<void>()
  const original = tool.execute
  tool.execute = (_args: any, ctx: any) => {
    ready.resolve()
    ctx.abort.addEventListener("abort", () => aborted.resolve(), { once: true })
    return Effect.callback<never>(() => {})
  }
  const restore = Effect.addFinalizer(() => Effect.sync(() => void (tool.execute = original)))
  return { ready, aborted, restore }
}

it.live(
  "interrupt propagates abort signal to read tool via file part (text/plain)",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const { read } = yield* registry.named()
          const { ready, aborted, restore } = hangUntilAborted(read)
          yield* restore

          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const chat = yield* sessions.create({ title: "Abort Test" })

          const testFile = path.join(dir, "test.txt")
          yield* Effect.promise(() => Bun.write(testFile, "hello world"))

          const fiber = yield* prompt
            .prompt({
              sessionID: chat.id,
              agent: "orchestrator",
              parts: [
                { type: "text", text: "read this" },
                { type: "file", url: `file://${testFile}`, filename: "test.txt", mime: "text/plain" },
              ],
            })
            .pipe(Effect.forkChild)

          yield* Effect.promise(() => ready.promise)
          yield* Fiber.interrupt(fiber)

          yield* Effect.promise(() =>
            Promise.race([
              aborted.promise,
              new Promise<void>((_, reject) =>
                setTimeout(() => reject(new Error("abort signal not propagated within 2s")), 2_000),
              ),
            ]),
          )
        }),
      { git: true, config: cfg },
    ),
  30_000,
)

it.live(
  "interrupt propagates abort signal to read tool via file part (directory)",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const { read } = yield* registry.named()
          const { ready, aborted, restore } = hangUntilAborted(read)
          yield* restore

          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const chat = yield* sessions.create({ title: "Abort Test" })

          const fiber = yield* prompt
            .prompt({
              sessionID: chat.id,
              agent: "orchestrator",
              parts: [
                { type: "text", text: "read this" },
                { type: "file", url: `file://${dir}`, filename: "dir", mime: "application/x-directory" },
              ],
            })
            .pipe(Effect.forkChild)

          yield* Effect.promise(() => ready.promise)
          yield* Fiber.interrupt(fiber)

          yield* Effect.promise(() =>
            Promise.race([
              aborted.promise,
              new Promise<void>((_, reject) =>
                setTimeout(() => reject(new Error("abort signal not propagated within 2s")), 2_000),
              ),
            ]),
          )
        }),
      { git: true, config: cfg },
    ),
  30_000,
)

// Missing file handling

it.live("does not fail the prompt when a file part is missing", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({})

        const missing = path.join(dir, "does-not-exist.ts")
        const msg = yield* prompt.prompt({
          sessionID: session.id,
          agent: "orchestrator",
          noReply: true,
          parts: [
            { type: "text", text: "please review @does-not-exist.ts" },
            {
              type: "file",
              mime: "text/plain",
              url: `file://${missing}`,
              filename: "does-not-exist.ts",
            },
          ],
        })

        if (msg.info.role !== "user") throw new Error("expected user message")
        const hasFailure = msg.parts.some(
          (part) => part.type === "text" && part.synthetic && part.text.includes("Read tool failed to read"),
        )
        expect(hasFailure).toBe(true)

        yield* sessions.remove(session.id)
      }),
    { git: true, config: cfg },
  ),
)

it.live("keeps stored part order stable when file resolution is async", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({})

        const missing = path.join(dir, "still-missing.ts")
        const msg = yield* prompt.prompt({
          sessionID: session.id,
          agent: "orchestrator",
          noReply: true,
          parts: [
            {
              type: "file",
              mime: "text/plain",
              url: `file://${missing}`,
              filename: "still-missing.ts",
            },
            { type: "text", text: "after-file" },
          ],
        })

        if (msg.info.role !== "user") throw new Error("expected user message")

        const stored = MessageV2.get({
          sessionID: session.id,
          messageID: msg.info.id,
        })
        const text = stored.parts.filter((part) => part.type === "text").map((part) => part.text)

        expect(text[0]?.startsWith("Called the Read tool with the following input:")).toBe(true)
        expect(text[1]?.includes("Read tool failed to read")).toBe(true)
        expect(text[2]).toBe("after-file")

        yield* sessions.remove(session.id)
      }),
    { git: true, config: cfg },
  ),
)

// Special characters in filenames

it.live("handles filenames with # character", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => Bun.write(path.join(dir, "file#name.txt"), "special content\n"))

        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({})
        const parts = yield* prompt.resolvePromptParts("Read @file#name.txt")
        const fileParts = parts.filter((part) => part.type === "file")

        expect(fileParts.length).toBe(1)
        expect(fileParts[0].filename).toBe("file#name.txt")
        expect(fileParts[0].url).toContain("%23")

        const decodedPath = fileURLToPath(fileParts[0].url)
        expect(decodedPath).toBe(path.join(dir, "file#name.txt"))

        const message = yield* prompt.prompt({
          sessionID: session.id,
          parts,
          noReply: true,
        })
        const stored = MessageV2.get({ sessionID: session.id, messageID: message.info.id })
        const textParts = stored.parts.filter((part) => part.type === "text")
        const hasContent = textParts.some((part) => part.text.includes("special content"))
        expect(hasContent).toBe(true)

        yield* sessions.remove(session.id)
      }),
    { git: true, config: cfg },
  ),
)

// Regression: empty assistant turn loop

it.live("does not loop empty assistant turns for a simple reply", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Prompt regression" })

      yield* llm.text("packages/codemate/src/session/processor.ts")

      const result = yield* prompt.prompt({
        sessionID: session.id,
        agent: "orchestrator",
        parts: [{ type: "text", text: "Where is SessionProcessor?" }],
      })

      expect(result.info.role).toBe("assistant")
      expect(result.parts.some((part) => part.type === "text" && part.text.includes("processor.ts"))).toBe(true)

      const msgs = yield* sessions.messages({ sessionID: session.id })
      expect(msgs.filter((msg) => msg.info.role === "assistant")).toHaveLength(1)
      expect(yield* llm.calls).toBe(1)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live(
  "records aborted errors when prompt is cancelled mid-stream",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "Prompt cancel regression" })

        yield* llm.hang

        const fiber = yield* prompt
          .prompt({
            sessionID: session.id,
            agent: "orchestrator",
            parts: [{ type: "text", text: "Cancel me" }],
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* prompt.cancel(session.id)

        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
          if (exit.value.info.role === "assistant") {
            expect(exit.value.info.error?.name).toBe("MessageAbortedError")
          }
        }

        const msgs = yield* sessions.messages({ sessionID: session.id })
        const last = msgs.findLast((msg) => msg.info.role === "assistant")
        expect(last?.info.role).toBe("assistant")
        if (last?.info.role === "assistant") {
          expect(last.info.error?.name).toBe("MessageAbortedError")
        }
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

// Agent variant

it.live("applies agent variant only when using agent model", () =>
  provideTmpdirInstance(
    (_dir) =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({})

        const other = yield* prompt.prompt({
          sessionID: session.id,
          agent: "orchestrator",
          model: { providerID: ProviderID.make("codemate"), modelID: ModelID.make("kimi-k2.5-free") },
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })
        if (other.info.role !== "user") throw new Error("expected user message")
        expect(other.info.model.variant).toBeUndefined()

        const match = yield* prompt.prompt({
          sessionID: session.id,
          agent: "orchestrator",
          noReply: true,
          parts: [{ type: "text", text: "hello again" }],
        })
        if (match.info.role !== "user") throw new Error("expected user message")
        expect(match.info.model).toEqual({
          providerID: ProviderID.make("test"),
          modelID: ModelID.make("test-model"),
          variant: "xhigh",
        })
        expect(match.info.model.variant).toBe("xhigh")

        const override = yield* prompt.prompt({
          sessionID: session.id,
          agent: "orchestrator",
          noReply: true,
          variant: "high",
          parts: [{ type: "text", text: "hello third" }],
        })
        if (override.info.role !== "user") throw new Error("expected user message")
        expect(override.info.model.variant).toBe("high")

        yield* sessions.remove(session.id)
      }),
    {
      git: true,
      config: {
        ...cfg,
        provider: {
          ...cfg.provider,
          test: {
            ...cfg.provider.test,
            models: {
              "test-model": {
                ...cfg.provider.test.models["test-model"],
                variants: { xhigh: {}, high: {} },
              },
            },
          },
        },
        agent: {
          orchestrator: {
            model: "test/test-model",
            variant: "xhigh",
          },
        },
      },
    },
  ),
)

// Agent / command resolution errors

it.live(
  "unknown agent throws typed error",
  () =>
    provideTmpdirInstance(
      (_dir) =>
        Effect.gen(function* () {
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const session = yield* sessions.create({})
          const exit = yield* prompt
            .prompt({
              sessionID: session.id,
              agent: "nonexistent-agent-xyz",
              noReply: true,
              parts: [{ type: "text", text: "hello" }],
            })
            .pipe(Effect.exit)

          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            const err = Cause.squash(exit.cause)
            expect(err).not.toBeInstanceOf(TypeError)
            expect(NamedError.Unknown.isInstance(err)).toBe(true)
            if (NamedError.Unknown.isInstance(err)) {
              expect(err.data.message).toContain('Agent not found: "nonexistent-agent-xyz"')
            }
          }
        }),
      { git: true },
    ),
  30_000,
)

it.live(
  "unknown agent error includes available agent names",
  () =>
    provideTmpdirInstance(
      (_dir) =>
        Effect.gen(function* () {
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const session = yield* sessions.create({})
          const exit = yield* prompt
            .prompt({
              sessionID: session.id,
              agent: "nonexistent-agent-xyz",
              noReply: true,
              parts: [{ type: "text", text: "hello" }],
            })
            .pipe(Effect.exit)

          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            const err = Cause.squash(exit.cause)
            expect(NamedError.Unknown.isInstance(err)).toBe(true)
            if (NamedError.Unknown.isInstance(err)) {
              expect(err.data.message).toContain("nonexistent-agent-xyz")
            }
          }
        }),
      { git: true },
    ),
  30_000,
)

it.live(
  "unknown command throws typed error with available names",
  () =>
    provideTmpdirInstance(
      (_dir) =>
        Effect.gen(function* () {
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const session = yield* sessions.create({})
          const exit = yield* prompt
            .command({
              sessionID: session.id,
              command: "nonexistent-command-xyz",
              arguments: "",
            })
            .pipe(Effect.exit)

          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            const err = Cause.squash(exit.cause)
            expect(err).not.toBeInstanceOf(TypeError)
            expect(NamedError.Unknown.isInstance(err)).toBe(true)
            if (NamedError.Unknown.isInstance(err)) {
              expect(err.data.message).toContain('Command not found: "nonexistent-command-xyz"')
              expect(err.data.message).toContain("init")
            }
          }
        }),
      { git: true },
    ),
  30_000,
)
