import path from "path"
import os from "os"
import * as EffectZod from "@codemate-ai/core/effect-zod"
import { SessionID, MessageID, PartID } from "./schema"
import { MessageV2 } from "./message-v2"
import * as Log from "@codemate-ai/core/util/log"
import { SessionRevert } from "./revert"
import * as Session from "./session"
import { Agent } from "../agent/agent"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "../provider/schema"
import { type Tool as AITool, tool, jsonSchema, type ToolExecutionOptions, asSchema } from "ai"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { SessionCompaction } from "./compaction"
import { Bus } from "../bus"
import { ProviderTransform } from "@/provider/transform"
import { SystemPrompt } from "./system"
import { Instruction } from "./instruction"
import { Plugin } from "../plugin"
import PROMPT_ORCHESTRATOR from "../session/prompt/orchestrator.txt"
import MAX_STEPS from "../session/prompt/max-steps.txt"
import { ToolRegistry } from "@/tool/registry"
import { MCP } from "../mcp"
import { LSP } from "@/lsp/lsp"
import { Flag } from "@codemate-ai/core/flag/flag"
import { ulid } from "ulid"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@codemate-ai/core/cross-spawn-spawner"
import * as Stream from "effect/Stream"
import { Command } from "../command"
import { pathToFileURL, fileURLToPath } from "url"
import { Config } from "@/config/config"
import { ConfigMarkdown } from "@/config/markdown"
import { SessionSummary } from "./summary"
import { NamedError } from "@codemate-ai/core/util/error"
import { SessionProcessor } from "./processor"
import { Tool } from "@/tool/tool"
import { Permission } from "@/permission"
import { SessionStatus } from "./status"
import { LLM } from "./llm"
import { Shell } from "@/shell/shell"
import { ShellID } from "@/tool/shell/id"
import { AppFileSystem } from "@codemate-ai/core/filesystem"
import { Truncate } from "@/tool/truncate"
import { decodeDataUrl } from "@/util/data-url"
import { Process } from "@/util/process"
import { Cause, Effect, Exit, Latch, Layer, Option, Scope, Context, Schema, Semaphore, Types } from "effect"
import { zod } from "@codemate-ai/core/effect-zod"
import { withStatics } from "@codemate-ai/core/schema"
import * as EffectLogger from "@codemate-ai/core/effect/logger"
import { InstanceState } from "@/effect/instance-state"
import { TaskTool, type TaskPromptOps } from "@/tool/task"
import { SessionRunState } from "./run-state"
import { EffectBridge } from "@/effect/bridge"
import { SyncEvent } from "@/sync"
import { SessionEvent } from "@/v2/session-event"
import { Modelv2 } from "@/v2/model"
import { AgentAttachment, FileAttachment, Source } from "@/v2/session-prompt"
import { Question } from "@/question"
import { Todo } from "./todo"
import * as SessionClosedLoop from "@/session/closed-loop"
import * as DateTime from "effect/DateTime"
import { eq } from "@/storage/db"
import * as Database from "@/storage/db"
import { SessionTable } from "./session.sql"

// @ts-ignore
globalThis.AI_SDK_LOG_WARNINGS = false

const decodeMessageInfo = Schema.decodeUnknownExit(MessageV2.Info)
const decodeMessagePart = Schema.decodeUnknownExit(MessageV2.Part)

const STRUCTURED_OUTPUT_DESCRIPTION = `Use this tool to return your final response in the requested structured format.

IMPORTANT:
- You MUST call this tool exactly once at the end of your response
- The input must be valid JSON matching the required schema
- Complete all necessary research and tool calls BEFORE calling this tool
- This tool provides your final answer - no further actions are taken after calling it`

const STRUCTURED_OUTPUT_SYSTEM_PROMPT = `IMPORTANT: The user has requested structured output. You MUST use the StructuredOutput tool to provide your final response. Do NOT respond with plain text - you MUST call the StructuredOutput tool with your answer formatted according to the schema.`

const log = Log.create({ service: "session.prompt" })
const elog = EffectLogger.create({ service: "session.prompt" })

const TASK_ROLE_AGENT: Record<MessageV2.TaskRole, string> = {
  planner: "planner",
  coder: "coder",
  tester: "tester",
  research: "research",
  reviewer: "reviewer",
  writer: "writer",
}

function roleAgent(role: MessageV2.TaskRole) {
  return TASK_ROLE_AGENT[role]
}

function roleForAgent(agent: string): MessageV2.TaskRole | undefined {
  if (agent === "planner") return "planner"
  if (agent === "coder") return "coder"
  if (agent === "tester") return "tester"
  if (agent === "research") return "research"
  if (agent === "reviewer") return "reviewer"
  if (agent === "writer") return "writer"
}

function isTaskRole(value: unknown): value is MessageV2.TaskRole {
  if (typeof value !== "string") return false
  return ["planner", "coder", "tester", "research", "reviewer", "writer"].includes(value)
}

type SchedulerTodoStatus = "pending" | "executing" | "completed" | "failed"

type SchedulerTodoItem = {
  content: string
  status: SchedulerTodoStatus
  order: number
  taskRole?: MessageV2.TaskRole
  taskID?: string
  layer?: number
  startedAt?: number
  completedAt?: number
  durationMs?: number
}

function schedulerTodoStatus(status: SchedulerTodoStatus) {
  if (status === "executing") return "in_progress"
  if (status === "failed") return "cancelled"
  return status
}

export interface Interface {
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  readonly prompt: (input: PromptInput) => Effect.Effect<MessageV2.WithParts>
  readonly loop: (input: LoopInput) => Effect.Effect<MessageV2.WithParts>
  readonly shell: (input: ShellInput) => Effect.Effect<MessageV2.WithParts>
  readonly command: (input: CommandInput) => Effect.Effect<MessageV2.WithParts>
  readonly resolvePromptParts: (template: string) => Effect.Effect<PromptInput["parts"]>
}

export class Service extends Context.Service<Service, Interface>()("@codemate/SessionPrompt") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const status = yield* SessionStatus.Service
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const provider = yield* Provider.Service
    const processor = yield* SessionProcessor.Service
    const compaction = yield* SessionCompaction.Service
    const plugin = yield* Plugin.Service
    const commands = yield* Command.Service
    const config = yield* Config.Service
    const permission = yield* Permission.Service
    const fsys = yield* AppFileSystem.Service
    const mcp = yield* MCP.Service
    const lsp = yield* LSP.Service
    const registry = yield* ToolRegistry.Service
    const truncate = yield* Truncate.Service
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const scope = yield* Scope.Scope
    const instruction = yield* Instruction.Service
    const state = yield* SessionRunState.Service
    const revert = yield* SessionRevert.Service
    const summary = yield* SessionSummary.Service
    const sys = yield* SystemPrompt.Service
    const llm = yield* LLM.Service
    const sync = yield* SyncEvent.Service
    const question = yield* Question.Service
    const todo = yield* Todo.Service
    const closedLoop = yield* SessionClosedLoop.Service
    const runner = Effect.fn("SessionPrompt.runner")(function* () {
      return yield* EffectBridge.make()
    })
    const ops = Effect.fn("SessionPrompt.ops")(function* () {
      return {
        cancel: (sessionID: SessionID) => cancel(sessionID),
        resolvePromptParts: (template: string) => resolvePromptParts(template),
        prompt: (input: PromptInput) => prompt(input),
      } satisfies TaskPromptOps
    })

    const cancel = Effect.fn("SessionPrompt.cancel")(function* (sessionID: SessionID) {
      yield* elog.info("cancel", { sessionID })
      yield* state.cancel(sessionID)
    })

    const resolvePromptParts = Effect.fn("SessionPrompt.resolvePromptParts")(function* (template: string) {
      const ctx = yield* InstanceState.context
      const parts: Types.DeepMutable<PromptInput["parts"]> = [{ type: "text", text: template }]
      const files = ConfigMarkdown.files(template)
      const seen = new Set<string>()
      yield* Effect.forEach(
        files,
        Effect.fnUntraced(function* (match) {
          const name = match[1]
          if (seen.has(name)) return
          seen.add(name)
          const filepath = name.startsWith("~/")
            ? path.join(os.homedir(), name.slice(2))
            : path.resolve(ctx.worktree, name)

          const info = yield* fsys.stat(filepath).pipe(Effect.option)
          if (Option.isNone(info)) {
            const found = yield* agents.get(name)
            if (found) parts.push({ type: "agent", name: found.name })
            return
          }
          const stat = info.value
          parts.push({
            type: "file",
            url: pathToFileURL(filepath).href,
            filename: name,
            mime: stat.type === "Directory" ? "application/x-directory" : "text/plain",
          })
        }),
        { concurrency: "unbounded", discard: true },
      )
      return parts
    })

    const title = Effect.fn("SessionPrompt.ensureTitle")(function* (input: {
      session: Session.Info
      history: MessageV2.WithParts[]
      providerID: ProviderID
      modelID: ModelID
    }) {
      if (input.session.parentID) return
      if (!Session.isDefaultTitle(input.session.title)) return

      const real = (m: MessageV2.WithParts) =>
        m.info.role === "user" && !m.parts.every((p) => "synthetic" in p && p.synthetic)
      const idx = input.history.findIndex(real)
      if (idx === -1) return
      if (input.history.filter(real).length !== 1) return

      const context = input.history.slice(0, idx + 1)
      const firstUser = context[idx]
      if (!firstUser || firstUser.info.role !== "user") return
      const firstInfo = firstUser.info

      const subtasks = firstUser.parts.filter((p): p is MessageV2.SubtaskPart => p.type === "subtask")
      const onlySubtasks = subtasks.length > 0 && firstUser.parts.every((p) => p.type === "subtask")

      const ag = yield* agents.get("title")
      if (!ag) return
      const mdl = ag.model
        ? yield* provider.getModel(ag.model.providerID, ag.model.modelID)
        : ((yield* provider.getSmallModel(input.providerID)) ??
          (yield* provider.getModel(input.providerID, input.modelID)))
      const msgs = onlySubtasks
        ? [{ role: "user" as const, content: subtasks.map((p) => p.prompt).join("\n") }]
        : yield* MessageV2.toModelMessagesEffect(context, mdl)
      const text = yield* llm
        .stream({
          agent: ag,
          user: firstInfo,
          system: [],
          small: true,
          tools: {},
          model: mdl,
          sessionID: input.session.id,
          retries: 2,
          messages: [{ role: "user", content: "Generate a title for this conversation:\n" }, ...msgs],
        })
        .pipe(
          Stream.filter((e): e is Extract<LLM.Event, { type: "text-delta" }> => e.type === "text-delta"),
          Stream.map((e) => e.text),
          Stream.mkString,
          Effect.orDie,
        )
      const cleaned = text
        .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0)
      if (!cleaned) return
      const t = cleaned.length > 100 ? cleaned.substring(0, 97) + "..." : cleaned
      yield* sessions
        .setTitle({ sessionID: input.session.id, title: t })
        .pipe(Effect.catchCause((cause) => elog.error("failed to generate title", { error: Cause.squash(cause) })))
    })

    const insertReminders = Effect.fn("SessionPrompt.insertReminders")(function* (input: {
      messages: MessageV2.WithParts[]
      agent: Agent.Info
      session: Session.Info
    }) {
      const userMessage = input.messages.findLast((msg) => msg.info.role === "user")
      if (!userMessage) return input.messages

      if (!Flag.codemate_EXPERIMENTAL_PLAN_MODE) {
        if (input.agent.name === "orchestrator") {
          userMessage.parts.push({
            id: PartID.ascending(),
            messageID: userMessage.info.id,
            sessionID: userMessage.info.sessionID,
            type: "text",
            text: PROMPT_ORCHESTRATOR,
            synthetic: true,
          })
        }
        return input.messages
      }

      const assistantMessage = input.messages.findLast((msg) => msg.info.role === "assistant")
      if (input.agent.name !== "orchestrator" && assistantMessage?.info.agent === "orchestrator") {
        const ctx = yield* InstanceState.context
        const plan = Session.plan(input.session, ctx)
        if (!(yield* fsys.existsSafe(plan))) return input.messages
        const part = yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: userMessage.info.id,
          sessionID: userMessage.info.sessionID,
          type: "text",
          text: `A plan file exists at ${plan}. Execute according to that plan and continue through TaskGraph routing.`,
          synthetic: true,
        })
        userMessage.parts.push(part)
        return input.messages
      }

      if (input.agent.name !== "orchestrator" || assistantMessage?.info.agent === "orchestrator") return input.messages

      const ctx = yield* InstanceState.context
      const plan = Session.plan(input.session, ctx)
      const exists = yield* fsys.existsSafe(plan)
      if (!exists) yield* fsys.ensureDir(path.dirname(plan)).pipe(Effect.catch(Effect.die))
      const part = yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: userMessage.info.id,
        sessionID: userMessage.info.sessionID,
        type: "text",
        text: `<system-reminder>
Orchestrator agent mode is active.

You MUST follow TaskGraph routing for non-trivial requests.
Allowed behavior:
- Use TaskGraph + task_role routing to dispatch specialist subagents (planner/coder/tester/research/reviewer/writer).
- Continue execution after planning by running the queued TaskGraph nodes.
- Once planner has produced a TaskGraph, do NOT call task() or todowrite() directly.
- The scheduler will handle all execution automatically.
- Your only job after planner is to monitor progress and handle user questions.

Forbidden for the orchestrator primary agent:
- Direct file mutation tool calls (edit/write/patch).
- Direct shell execution (bash).
- Bypassing TaskGraph for non-trivial work.

This does NOT block subagent execution. Once TaskGraph is produced, continue scheduling subagents until completion or a blocking user decision.

Plan file path (for optional reference only): ${plan}
</system-reminder>`,
        synthetic: true,
      })
      userMessage.parts.push(part)
      return input.messages
    })

    const resolveTools = Effect.fn("SessionPrompt.resolveTools")(function* (input: {
      agent: Agent.Info
      model: Provider.Model
      session: Session.Info
      tools?: Record<string, boolean>
      processor: Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">
      bypassAgentCheck: boolean
      messages: MessageV2.WithParts[]
    }) {
      using _ = log.time("resolveTools")
      const tools: Record<string, AITool> = {}
      const run = yield* runner()
      const promptOps = yield* ops()

      const context = (args: any, options: ToolExecutionOptions): Tool.Context => ({
        sessionID: input.session.id,
        abort: options.abortSignal!,
        messageID: input.processor.message.id,
        callID: options.toolCallId,
        extra: { model: input.model, bypassAgentCheck: input.bypassAgentCheck, promptOps },
        agent: input.agent.name,
        messages: input.messages,
        metadata: (val) =>
          input.processor.updateToolCall(options.toolCallId, (match) => {
            if (!["running", "pending"].includes(match.state.status)) return match
            return {
              ...match,
              state: {
                title: val.title,
                metadata: val.metadata,
                status: "running",
                input: args,
                time: { start: Date.now() },
              },
            }
          }),
        ask: (req) =>
          permission
            .ask({
              ...req,
              sessionID: input.session.id,
              tool: { messageID: input.processor.message.id, callID: options.toolCallId },
              ruleset: Permission.merge(input.agent.permission, input.session.permission ?? []),
            })
            .pipe(Effect.orDie),
      })

      for (const item of yield* registry.tools({
        modelID: ModelID.make(input.model.api.id),
        providerID: input.model.providerID,
        agent: input.agent,
      })) {
        const schema = ProviderTransform.schema(input.model, EffectZod.toJsonSchema(item.parameters))
        tools[item.id] = tool({
          description: item.description,
          inputSchema: jsonSchema(schema),
          execute(args, options) {
            return run.promise(
              Effect.gen(function* () {
                const ctx = context(args, options)
                yield* plugin.trigger(
                  "tool.execute.before",
                  { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID },
                  { args },
                )
                const result = yield* item.execute(args, ctx)
                const output = {
                  ...result,
                  attachments: result.attachments?.map((attachment) => ({
                    ...attachment,
                    id: PartID.ascending(),
                    sessionID: ctx.sessionID,
                    messageID: input.processor.message.id,
                  })),
                }
                yield* plugin.trigger(
                  "tool.execute.after",
                  { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID, args },
                  output,
                )
                if (options.abortSignal?.aborted) {
                  yield* input.processor.completeToolCall(options.toolCallId, output)
                }
                return output
              }),
            )
          },
        })
      }

      for (const [key, item] of Object.entries(yield* mcp.tools())) {
        const execute = item.execute
        if (!execute) continue

        const schema = yield* Effect.promise(() => Promise.resolve(asSchema(item.inputSchema).jsonSchema))
        const transformed = ProviderTransform.schema(input.model, schema)
        item.inputSchema = jsonSchema(transformed)
        item.execute = (args, opts) =>
          run.promise(
            Effect.gen(function* () {
              const ctx = context(args, opts)
              yield* plugin.trigger(
                "tool.execute.before",
                { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId },
                { args },
              )
              const result: Awaited<ReturnType<NonNullable<typeof execute>>> = yield* Effect.gen(function* () {
                yield* ctx.ask({ permission: key, metadata: {}, patterns: ["*"], always: ["*"] })
                return yield* Effect.promise(() => execute(args, opts))
              }).pipe(
                Effect.withSpan("Tool.execute", {
                  attributes: {
                    "tool.name": key,
                    "tool.call_id": opts.toolCallId,
                    "session.id": ctx.sessionID,
                    "message.id": input.processor.message.id,
                  },
                }),
              )
              yield* plugin.trigger(
                "tool.execute.after",
                { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
                result,
              )

              const textParts: string[] = []
              const attachments: Omit<MessageV2.FilePart, "id" | "sessionID" | "messageID">[] = []
              for (const contentItem of result.content) {
                if (contentItem.type === "text") textParts.push(contentItem.text)
                else if (contentItem.type === "image") {
                  attachments.push({
                    type: "file",
                    mime: contentItem.mimeType,
                    url: `data:${contentItem.mimeType};base64,${contentItem.data}`,
                  })
                } else if (contentItem.type === "resource") {
                  const { resource } = contentItem
                  if (resource.text) textParts.push(resource.text)
                  if (resource.blob) {
                    attachments.push({
                      type: "file",
                      mime: resource.mimeType ?? "application/octet-stream",
                      url: `data:${resource.mimeType ?? "application/octet-stream"};base64,${resource.blob}`,
                      filename: resource.uri,
                    })
                  }
                }
              }

              const truncated = yield* truncate.output(textParts.join("\n\n"), {}, input.agent)
              const metadata = {
                ...result.metadata,
                truncated: truncated.truncated,
                ...(truncated.truncated && { outputPath: truncated.outputPath }),
              }

              const output = {
                title: "",
                metadata,
                output: truncated.content,
                attachments: attachments.map((attachment) => ({
                  ...attachment,
                  id: PartID.ascending(),
                  sessionID: ctx.sessionID,
                  messageID: input.processor.message.id,
                })),
                content: result.content,
              }
              if (opts.abortSignal?.aborted) {
                yield* input.processor.completeToolCall(opts.toolCallId, output)
              }
              return output
            }),
          )
        tools[key] = item
      }

      return tools
    })

    const handleSubtask = Effect.fn("SessionPrompt.handleSubtask")(function* (input: {
      task: MessageV2.SubtaskPart
      model: Provider.Model
      lastUser: MessageV2.User
      sessionID: SessionID
      session: Session.Info
      msgs: MessageV2.WithParts[]
    }) {
      const { task, model, lastUser, sessionID, session, msgs } = input
      const ctx = yield* InstanceState.context
      const promptOps = yield* ops()
      const { task: taskTool } = yield* registry.named()
      const taskModel = task.model ? yield* getModel(task.model.providerID, task.model.modelID, sessionID) : model
      const assistantMessage: MessageV2.Assistant = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        parentID: lastUser.id,
        sessionID,
        mode: task.agent,
        agent: task.agent,
        variant: lastUser.model.variant,
        path: { cwd: ctx.directory, root: ctx.worktree },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: taskModel.id,
        providerID: taskModel.providerID,
        time: { created: Date.now() },
      })
      let part: MessageV2.ToolPart = yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistantMessage.id,
        sessionID: assistantMessage.sessionID,
        type: "tool",
        callID: ulid(),
        tool: TaskTool.id,
        state: {
          status: "running",
          input: {
            prompt: task.prompt,
            description: task.description,
            subagent_type: task.agent,
            command: task.command,
          },
          time: { start: Date.now() },
        },
      })
      const taskArgs = {
        prompt: task.prompt,
        description: task.description,
        subagent_type: task.agent,
        command: task.command,
      }
      yield* plugin.trigger(
        "tool.execute.before",
        { tool: TaskTool.id, sessionID, callID: part.id },
        { args: taskArgs },
      )

      const taskAgent = yield* agents.get(task.agent)
      if (!taskAgent) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${task.agent}".${hint}` })
        yield* bus.publish(Session.Event.Error, { sessionID, error: error.toObject() })
        throw error
      }

      let error: Error | undefined
      const taskAbort = new AbortController()
      const result = yield* taskTool
        .execute(taskArgs, {
          agent: task.agent,
          messageID: assistantMessage.id,
          sessionID,
          abort: taskAbort.signal,
          callID: part.callID,
          extra: { bypassAgentCheck: true, promptOps },
          messages: msgs,
          metadata: (val: { title?: string; metadata?: Record<string, any> }) =>
            Effect.gen(function* () {
              part = yield* sessions.updatePart({
                ...part,
                type: "tool",
                state: { ...part.state, ...val },
              } satisfies MessageV2.ToolPart)
            }),
          ask: (req: any) =>
            permission
              .ask({
                ...req,
                sessionID,
                ruleset: Permission.merge(taskAgent.permission, session.permission ?? []),
              })
              .pipe(Effect.orDie),
        })
        .pipe(
          Effect.catchCause((cause) => {
            const defect = Cause.squash(cause)
            error = defect instanceof Error ? defect : new Error(String(defect))
            log.error("subtask execution failed", { error, agent: task.agent, description: task.description })
            return Effect.void
          }),
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              taskAbort.abort()
              assistantMessage.finish = "tool-calls"
              assistantMessage.time.completed = Date.now()
              yield* sessions.updateMessage(assistantMessage)
              if (part.state.status === "running") {
                yield* sessions.updatePart({
                  ...part,
                  state: {
                    status: "error",
                    error: "Cancelled",
                    time: { start: part.state.time.start, end: Date.now() },
                    metadata: part.state.metadata,
                    input: part.state.input,
                  },
                } satisfies MessageV2.ToolPart)
              }
            }),
          ),
        )

      const attachments = result?.attachments?.map((attachment) => ({
        ...attachment,
        id: PartID.ascending(),
        sessionID,
        messageID: assistantMessage.id,
      }))

      yield* plugin.trigger(
        "tool.execute.after",
        { tool: TaskTool.id, sessionID, callID: part.id, args: taskArgs },
        result,
      )

      assistantMessage.finish = "tool-calls"
      assistantMessage.time.completed = Date.now()
      yield* sessions.updateMessage(assistantMessage)

      if (result && part.state.status === "running") {
        yield* sessions.updatePart({
          ...part,
          state: {
            status: "completed",
            input: part.state.input,
            title: result.title,
            metadata: result.metadata,
            output: result.output,
            attachments,
            time: { ...part.state.time, end: Date.now() },
          },
        } satisfies MessageV2.ToolPart)
      }

      if (!result) {
        yield* sessions.updatePart({
          ...part,
          state: {
            status: "error",
            error: error ? `Tool execution failed: ${error.message}` : "Tool execution failed",
            time: {
              start: part.state.status === "running" ? part.state.time.start : Date.now(),
              end: Date.now(),
            },
            metadata: part.state.status === "pending" ? undefined : part.state.metadata,
            input: part.state.input,
          },
        } satisfies MessageV2.ToolPart)
      }

      if (task.command) {
        const summaryUserMsg: MessageV2.User = {
          id: MessageID.ascending(),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: lastUser.agent,
          model: lastUser.model,
        }
        yield* sessions.updateMessage(summaryUserMsg)
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: summaryUserMsg.id,
          sessionID,
          type: "text",
          text: "Summarize the task tool output above and continue with your task.",
          synthetic: true,
        } satisfies MessageV2.TextPart)
      }
      if (!result) return
      return {
        output: result.output,
        metadata: (result.metadata ?? {}) as Record<string, unknown>,
      }
    })

    const shellImpl = Effect.fn("SessionPrompt.shellImpl")(function* (input: ShellInput, ready?: Latch.Latch) {
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const markReady = ready ? ready.open.pipe(Effect.asVoid) : Effect.void
          const { msg, part, cwd } = yield* Effect.gen(function* () {
            const ctx = yield* InstanceState.context
            const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
            if (session.revert) {
              yield* revert.cleanup(session)
            }
            const agent = yield* agents.get(input.agent)
            if (!agent) {
              const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
              const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
              const error = new NamedError.Unknown({ message: `Agent not found: "${input.agent}".${hint}` })
              yield* bus.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
              throw error
            }
            const model = input.model ?? agent.model ?? (yield* currentModel(input.sessionID))
            const userMsg: MessageV2.User = {
              id: input.messageID ?? MessageID.ascending(),
              sessionID: input.sessionID,
              time: { created: Date.now() },
              role: "user",
              agent: input.agent,
              model: { providerID: model.providerID, modelID: model.modelID },
            }
            yield* sessions.updateMessage(userMsg)
            const userPart: MessageV2.Part = {
              type: "text",
              id: PartID.ascending(),
              messageID: userMsg.id,
              sessionID: input.sessionID,
              text: "The following tool was executed by the user",
              synthetic: true,
            }
            yield* sessions.updatePart(userPart)

            const msg: MessageV2.Assistant = {
              id: MessageID.ascending(),
              sessionID: input.sessionID,
              parentID: userMsg.id,
              mode: input.agent,
              agent: input.agent,
              cost: 0,
              path: { cwd: ctx.directory, root: ctx.worktree },
              time: { created: Date.now() },
              role: "assistant",
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: model.modelID,
              providerID: model.providerID,
            }
            yield* sessions.updateMessage(msg)
            const callID = ulid()
            const started = Date.now()
            const part: MessageV2.ToolPart = {
              type: "tool",
              id: PartID.ascending(),
              messageID: msg.id,
              sessionID: input.sessionID,
              tool: ShellID.ToolID,
              callID: ulid(),
              state: {
                status: "running",
                time: { start: started },
                input: { command: input.command },
              },
            }
            yield* sessions.updatePart(part)
            if (Flag.codemate_EXPERIMENTAL_EVENT_SYSTEM) {
              yield* sync.run(SessionEvent.Shell.Started.Sync, {
                sessionID: input.sessionID,
                timestamp: DateTime.makeUnsafe(started),
                callID,
                command: input.command,
              })
            }
            return { msg, part, cwd: ctx.directory }
          }).pipe(Effect.ensuring(markReady))

          const cfg = yield* config.get()
          const sh = Shell.preferred(cfg.shell)
          const args = Shell.args(sh, input.command, cwd)
          let output = ""
          let aborted = false

          const finish = Effect.uninterruptible(
            Effect.gen(function* () {
              if (aborted) {
                output += "\n\n" + ["<metadata>", "User aborted the command", "</metadata>"].join("\n")
              }
              const completed = Date.now()
              if (Flag.codemate_EXPERIMENTAL_EVENT_SYSTEM) {
                yield* sync.run(SessionEvent.Shell.Ended.Sync, {
                  sessionID: input.sessionID,
                  timestamp: DateTime.makeUnsafe(completed),
                  callID: part.callID,
                  output,
                })
              }
              if (!msg.time.completed) {
                msg.time.completed = completed
                yield* sessions.updateMessage(msg)
              }
              if (part.state.status === "running") {
                part.state = {
                  status: "completed",
                  time: { ...part.state.time, end: completed },
                  input: part.state.input,
                  title: "",
                  metadata: { output, description: "" },
                  output,
                }
                yield* sessions.updatePart(part)
              }
            }),
          )

          const exit = yield* restore(
            Effect.gen(function* () {
              const shellEnv = yield* plugin.trigger(
                "shell.env",
                { cwd, sessionID: input.sessionID, callID: part.callID },
                { env: {} },
              )
              const cmd = ChildProcess.make(sh, args, {
                cwd,
                extendEnv: true,
                env: { ...shellEnv.env, TERM: "dumb" },
                stdin: "ignore",
                forceKillAfter: "3 seconds",
              })
              const handle = yield* spawner.spawn(cmd)
              yield* Stream.runForEach(Stream.decodeText(handle.all), (chunk) =>
                Effect.gen(function* () {
                  output += chunk
                  if (part.state.status === "running") {
                    part.state.metadata = { output, description: "" }
                    yield* sessions.updatePart(part)
                  }
                }),
              )
              yield* handle.exitCode
            }).pipe(Effect.scoped, Effect.orDie),
          ).pipe(Effect.exit)

          if (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause) && !Cause.hasDies(exit.cause)) {
            aborted = true
          }
          yield* finish

          if (Exit.isFailure(exit) && !aborted && !Cause.hasInterruptsOnly(exit.cause)) {
            return yield* Effect.failCause(exit.cause)
          }

          return { info: msg, parts: [part] }
        }),
      )
    })

    const getModel = Effect.fn("SessionPrompt.getModel")(function* (
      providerID: ProviderID,
      modelID: ModelID,
      sessionID: SessionID,
    ) {
      const exit = yield* provider.getModel(providerID, modelID).pipe(Effect.exit)
      if (Exit.isSuccess(exit)) return exit.value
      const err = Cause.squash(exit.cause)
      if (Provider.ModelNotFoundError.isInstance(err)) {
        const hint = err.data.suggestions?.length ? ` Did you mean: ${err.data.suggestions.join(", ")}?` : ""
        yield* bus.publish(Session.Event.Error, {
          sessionID,
          error: new NamedError.Unknown({
            message: `Model not found: ${err.data.providerID}/${err.data.modelID}.${hint}`,
          }).toObject(),
        })
      }
      return yield* Effect.failCause(exit.cause)
    })

    const currentModel = Effect.fnUntraced(function* (sessionID: SessionID) {
      const current = Database.use((db) =>
        db.select({ model: SessionTable.model }).from(SessionTable).where(eq(SessionTable.id, sessionID)).get(),
      )
      if (current?.model) {
        return {
          providerID: ProviderID.make(current.model.providerID),
          modelID: ModelID.make(current.model.id),
          ...(current.model.variant && current.model.variant !== "default" ? { variant: current.model.variant } : {}),
        }
      }
      const match = yield* sessions.findMessage(sessionID, (m) => m.info.role === "user" && !!m.info.model)
      if (Option.isSome(match) && match.value.info.role === "user") return match.value.info.model
      return yield* provider.defaultModel()
    })

    const createUserMessage = Effect.fn("SessionPrompt.createUserMessage")(function* (input: PromptInput) {
      const agentName = input.agent || (yield* agents.defaultAgent())
      const ag = yield* agents.get(agentName)
      if (!ag) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
        yield* bus.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }

      const current = Database.use((db) =>
        db
          .select({ agent: SessionTable.agent, model: SessionTable.model })
          .from(SessionTable)
          .where(eq(SessionTable.id, input.sessionID))
          .get(),
      )
      const model = input.model ?? ag.model ?? (yield* currentModel(input.sessionID))
      const same = ag.model && model.providerID === ag.model.providerID && model.modelID === ag.model.modelID
      const full =
        !input.variant && ag.variant && same
          ? yield* provider.getModel(model.providerID, model.modelID).pipe(Effect.catchDefect(() => Effect.void))
          : undefined
      const variant = input.variant ?? (ag.variant && full?.variants?.[ag.variant] ? ag.variant : undefined)

      const info: MessageV2.User = {
        id: input.messageID ?? MessageID.ascending(),
        role: "user",
        sessionID: input.sessionID,
        time: { created: Date.now() },
        tools: input.tools,
        agent: ag.name,
        model: {
          providerID: model.providerID,
          modelID: model.modelID,
          variant,
        },
        system: input.system,
        format: input.format,
      }

      if (current?.agent !== info.agent) {
        yield* sync.run(SessionEvent.AgentSwitched.Sync, {
          sessionID: input.sessionID,
          timestamp: DateTime.makeUnsafe(info.time.created),
          agent: info.agent,
        })
      }
      if (
        current?.model?.providerID !== info.model.providerID ||
        current.model.id !== info.model.modelID ||
        (current.model.variant === "default" ? undefined : current.model.variant) !== info.model.variant
      ) {
        yield* sync.run(SessionEvent.ModelSwitched.Sync, {
          sessionID: input.sessionID,
          timestamp: DateTime.makeUnsafe(info.time.created),
          model: {
            id: Modelv2.ID.make(info.model.modelID),
            providerID: Modelv2.ProviderID.make(info.model.providerID),
            variant: Modelv2.VariantID.make(info.model.variant ?? "default"),
          },
        })
      }

      yield* Effect.addFinalizer(() => instruction.clear(info.id))

      type Draft<T> = T extends MessageV2.Part ? Omit<T, "id"> & { id?: string } : never
      const assign = (part: Draft<MessageV2.Part>): MessageV2.Part => ({
        ...part,
        id: part.id ? PartID.make(part.id) : PartID.ascending(),
      })

      const resolvePart: (part: PromptInput["parts"][number]) => Effect.Effect<Draft<MessageV2.Part>[]> = Effect.fn(
        "SessionPrompt.resolveUserPart",
      )(function* (part) {
        if (part.type === "file") {
          if (part.source?.type === "resource") {
            const { clientName, uri } = part.source
            log.info("mcp resource", { clientName, uri, mime: part.mime })
            const pieces: Draft<MessageV2.Part>[] = [
              {
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Reading MCP resource: ${part.filename} (${uri})`,
              },
            ]
            const exit = yield* mcp.readResource(clientName, uri).pipe(Effect.exit)
            if (Exit.isSuccess(exit)) {
              const content = exit.value
              if (!content) throw new Error(`Resource not found: ${clientName}/${uri}`)
              const items = Array.isArray(content.contents) ? content.contents : [content.contents]
              for (const c of items) {
                if ("text" in c && c.text) {
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: c.text,
                  })
                } else if ("blob" in c && c.blob) {
                  const mime = "mimeType" in c ? c.mimeType : part.mime
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `[Binary content: ${mime}]`,
                  })
                }
              }
              pieces.push({ ...part, messageID: info.id, sessionID: input.sessionID })
            } else {
              const error = Cause.squash(exit.cause)
              log.error("failed to read MCP resource", { error, clientName, uri })
              const message = error instanceof Error ? error.message : String(error)
              pieces.push({
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Failed to read MCP resource ${part.filename}: ${message}`,
              })
            }
            return pieces
          }
          const url = new URL(part.url)
          switch (url.protocol) {
            case "data:":
              if (part.mime === "text/plain") {
                return [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify({ filePath: part.filename })}`,
                  },
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: decodeDataUrl(part.url),
                  },
                  { ...part, messageID: info.id, sessionID: input.sessionID },
                ]
              }
              break
            case "file:": {
              log.info("file", { mime: part.mime })
              const filepath = fileURLToPath(part.url)
              const mime = (yield* fsys.isDir(filepath)) ? "application/x-directory" : part.mime

              const { read } = yield* registry.named()
              const execRead = (args: Parameters<typeof read.execute>[0], extra?: Tool.Context["extra"]) => {
                const controller = new AbortController()
                return read
                  .execute(args, {
                    sessionID: input.sessionID,
                    abort: controller.signal,
                    agent: input.agent!,
                    messageID: info.id,
                    extra: { bypassCwdCheck: true, ...extra },
                    messages: [],
                    metadata: () => Effect.void,
                    ask: () => Effect.void,
                  })
                  .pipe(Effect.onInterrupt(() => Effect.sync(() => controller.abort())))
              }

              if (mime === "text/plain") {
                let offset: number | undefined
                let limit: number | undefined
                const range = { start: url.searchParams.get("start"), end: url.searchParams.get("end") }
                if (range.start != null) {
                  const filePathURI = part.url.split("?")[0]
                  let start = parseInt(range.start)
                  let end = range.end ? parseInt(range.end) : undefined
                  if (start === end) {
                    const symbols = yield* lsp.documentSymbol(filePathURI).pipe(Effect.catch(() => Effect.succeed([])))
                    for (const symbol of symbols) {
                      let r: LSP.Range | undefined
                      if ("range" in symbol) r = symbol.range
                      else if ("location" in symbol) r = symbol.location.range
                      if (r?.start?.line && r?.start?.line === start) {
                        start = r.start.line
                        end = r?.end?.line ?? start
                        break
                      }
                    }
                  }
                  offset = Math.max(start, 1)
                  if (end) limit = end - (offset - 1)
                }
                const args = { filePath: filepath, offset, limit }
                const pieces: Draft<MessageV2.Part>[] = [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                ]
                const exit = yield* provider.getModel(info.model.providerID, info.model.modelID).pipe(
                  Effect.flatMap((mdl) => execRead(args, { model: mdl })),
                  Effect.exit,
                )
                if (Exit.isSuccess(exit)) {
                  const result = exit.value
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: result.output,
                  })
                  if (result.attachments?.length) {
                    pieces.push(
                      ...result.attachments.map((a) => ({
                        ...a,
                        synthetic: true,
                        filename: a.filename ?? part.filename,
                        messageID: info.id,
                        sessionID: input.sessionID,
                      })),
                    )
                  } else {
                    pieces.push({ ...part, mime, messageID: info.id, sessionID: input.sessionID })
                  }
                } else {
                  const error = Cause.squash(exit.cause)
                  log.error("failed to read file", { error })
                  const message = error instanceof Error ? error.message : String(error)
                  yield* bus.publish(Session.Event.Error, {
                    sessionID: input.sessionID,
                    error: new NamedError.Unknown({ message }).toObject(),
                  })
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                  })
                }
                return pieces
              }

              if (mime === "application/x-directory") {
                const args = { filePath: filepath }
                const exit = yield* execRead(args).pipe(Effect.exit)
                if (Exit.isFailure(exit)) {
                  const error = Cause.squash(exit.cause)
                  log.error("failed to read directory", { error })
                  const message = error instanceof Error ? error.message : String(error)
                  yield* bus.publish(Session.Event.Error, {
                    sessionID: input.sessionID,
                    error: new NamedError.Unknown({ message }).toObject(),
                  })
                  return [
                    {
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                    },
                  ]
                }
                return [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: exit.value.output,
                  },
                  { ...part, mime, messageID: info.id, sessionID: input.sessionID },
                ]
              }

              return [
                {
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text: `Called the Read tool with the following input: {"filePath":"${filepath}"}`,
                },
                {
                  id: part.id,
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "file",
                  url:
                    `data:${mime};base64,` +
                    Buffer.from(yield* fsys.readFile(filepath).pipe(Effect.catch(Effect.die))).toString("base64"),
                  mime,
                  filename: part.filename!,
                  source: part.source,
                },
              ]
            }
          }
        }

        if (part.type === "agent") {
          const perm = Permission.evaluate("task", part.name, ag.permission)
          const hint = perm.action === "deny" ? " . Invoked by user; guaranteed to exist." : ""
          return [
            { ...part, messageID: info.id, sessionID: input.sessionID },
            {
              messageID: info.id,
              sessionID: input.sessionID,
              type: "text",
              synthetic: true,
              text:
                " Use the above message and context to generate a prompt and call the task tool with subagent: " +
                part.name +
                hint,
            },
          ]
        }

        return [{ ...part, messageID: info.id, sessionID: input.sessionID }]
      })

      const resolvedParts = yield* Effect.forEach(input.parts, resolvePart, { concurrency: "unbounded" }).pipe(
        Effect.map((x) => x.flat().map(assign)),
      )

      yield* plugin.trigger(
        "chat.message",
        {
          sessionID: input.sessionID,
          agent: input.agent,
          model: input.model,
          messageID: input.messageID,
          variant: input.variant,
        },
        { message: info, parts: resolvedParts },
      )

      const parts = resolvedParts

      const parsed = decodeMessageInfo(info, { errors: "all", propertyOrder: "original" })
      if (Exit.isFailure(parsed)) {
        log.error("invalid user message before save", {
          sessionID: input.sessionID,
          messageID: info.id,
          agent: info.agent,
          model: info.model,
          cause: Cause.pretty(parsed.cause),
        })
      }
      parts.forEach((part, index) => {
        const p = decodeMessagePart(part, { errors: "all", propertyOrder: "original" })
        if (Exit.isSuccess(p)) return
        log.error("invalid user part before save", {
          sessionID: input.sessionID,
          messageID: info.id,
          partID: part.id,
          partType: part.type,
          index,
          cause: Cause.pretty(p.cause),
          part,
        })
      })

      yield* sessions.updateMessage(info)
      for (const part of parts) yield* sessions.updatePart(part)
      const nextPrompt = parts.reduce(
        (result, part) => {
          if (part.type === "text") {
            if (part.synthetic) result.synthetic.push(part.text)
            else result.text.push(part.text)
          }
          if (part.type === "file") {
            result.files.push(
              new FileAttachment({
                uri: part.url,
                mime: part.mime,
                name: part.filename,
                source: part.source
                  ? new Source({
                      start: part.source.text.start,
                      end: part.source.text.end,
                      text: part.source.text.value,
                    })
                  : undefined,
              }),
            )
          }
          if (part.type === "agent") {
            result.agents.push(
              new AgentAttachment({
                name: part.name,
                source: part.source
                  ? new Source({
                      start: part.source.start,
                      end: part.source.end,
                      text: part.source.value,
                    })
                  : undefined,
              }),
            )
          }
          return result
        },
        {
          text: [] as string[],
          files: [] as FileAttachment[],
          agents: [] as AgentAttachment[],
          synthetic: [] as string[],
        },
      )
      // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
      if (Flag.codemate_EXPERIMENTAL_EVENT_SYSTEM) {
        yield* sync.run(SessionEvent.Prompted.Sync, {
          sessionID: input.sessionID,
          timestamp: DateTime.makeUnsafe(info.time.created),
          prompt: {
            text: nextPrompt.text.join("\n"),
            files: nextPrompt.files,
            agents: nextPrompt.agents,
          },
        })
      }
      for (const text of nextPrompt.synthetic) {
        // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
        if (Flag.codemate_EXPERIMENTAL_EVENT_SYSTEM) {
          yield* sync.run(SessionEvent.Synthetic.Sync, {
            sessionID: input.sessionID,
            timestamp: DateTime.makeUnsafe(info.time.created),
            text,
          })
        }
      }

      return { info, parts }
    }, Effect.scoped)

    const prompt: (input: PromptInput) => Effect.Effect<MessageV2.WithParts> = Effect.fn("SessionPrompt.prompt")(
      function* (input: PromptInput) {
        const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
        yield* revert.cleanup(session)
        const message = yield* createUserMessage(input)
        yield* sessions.touch(input.sessionID)

        const permissions: Permission.Ruleset = []
        for (const [t, enabled] of Object.entries(input.tools ?? {})) {
          permissions.push({ permission: t, action: enabled ? "allow" : "deny", pattern: "*" })
        }
        if (permissions.length > 0) {
          session.permission = permissions
          yield* sessions.setPermission({ sessionID: session.id, permission: permissions })
        }

        if (input.noReply === true) return message
        return yield* loop({ sessionID: input.sessionID })
      },
    )

    const lastAssistant = Effect.fnUntraced(function* (sessionID: SessionID) {
      const match = yield* sessions.findMessage(sessionID, (m) => m.info.role !== "user")
      if (Option.isSome(match)) return match.value
      const msgs = yield* sessions.messages({ sessionID, limit: 1 })
      if (msgs.length > 0) return msgs[0]
      throw new Error("Impossible")
    })

    const looksLikeRefreshRequest = (text: string) =>
      ["latest", "refresh", "重新", "最新", "today", "实时"].some((word) => text.toLowerCase().includes(word))

    const hasExplicitMemoryInstruction = (text: string) => {
      const lower = text.toLowerCase()
      return [
        "remember",
        "save this",
        "don't forget",
        "don’t forget",
        "记住",
        "帮我记住",
        "以后记得",
        "偏好",
        "preference",
        "习惯",
      ].some((word) => lower.includes(word.toLowerCase()))
    }

    const isNonTrivialRequest = (text: string) => {
      const normalized = text.trim()
      if (!normalized) return false
      if (normalized.startsWith("/") || normalized.startsWith("!")) return false
      if (normalized.length > 180) return true
      if ((normalized.match(/\n/g)?.length ?? 0) >= 2) return true
      if (/\n\s*(\d+[\.\)]|[-*])\s+/.test(normalized)) return true
      const lower = normalized.toLowerCase()
      const keywords = [
        "taskgraph",
        "subtask",
        "dependency",
        "implement",
        "refactor",
        "test",
        "fix",
        "build",
        "create",
        "write",
        "generate",
        "verify",
        "review",
        "research",
        "script",
        "todo",
      ]
      const hits = keywords.filter((word) => lower.includes(word))
      if (hits.length >= 2) return true
      return false
    }

    const shouldForceTaskGraph = (input: { agent: string; text: string }) => {
      if (input.agent !== "orchestrator") return false
      return isNonTrivialRequest(input.text)
    }

    const runDriftCheck = Effect.fn("SessionPrompt.runDriftCheck")(function* (input: {
      sessionID: SessionID
      user: MessageV2.User
      agent: Agent.Info
      model: Provider.Model
      anchor: SessionClosedLoop.SessionIntentAnchor
      completedSubtasks: number
      summaries: string[]
      diffs: { file?: string; additions: number; deletions: number }[]
    }) {
      const prompt = [
        "You are a strict intent-drift detector for coding tasks.",
        "Judge whether execution has drifted away from the original user intent.",
        "",
        "Return JSON only with this shape:",
        '{\"is_drift\":boolean,\"reason\":string,\"evidence\":string[],\"confidence\":number}',
        "",
        `Original intent anchor: ${input.anchor.text}`,
        `Completed subtasks count: ${input.completedSubtasks}`,
        "",
        "Completed subtasks summary:",
        ...(input.summaries.length > 0 ? input.summaries : ["- none"]),
        "",
        "Code diff summary:",
        ...(input.diffs.length > 0
          ? input.diffs.map(
              (diff) =>
                `- ${diff.file ?? "unknown"} (+${Math.max(0, diff.additions)}, -${Math.max(0, diff.deletions)})`,
            )
          : ["- no file changes"]),
      ].join("\n")

      const text = yield* llm
        .stream({
          sessionID: input.sessionID,
          user: input.user,
          agent: input.agent,
          model: input.model,
          tools: {},
          retries: 1,
          system: [],
          messages: [{ role: "user", content: prompt }],
        })
        .pipe(
          Stream.filter((event): event is Extract<LLM.Event, { type: "text-delta" }> => event.type === "text-delta"),
          Stream.map((event) => event.text),
          Stream.mkString,
        )

      const cleaned = text
        .replace(/```json/gi, "")
        .replace(/```/g, "")
        .trim()
      const parsed = yield* Effect.try({
        try: () => JSON.parse(cleaned),
        catch: () => null,
      })
      if (!parsed || typeof parsed !== "object") {
        return {
          is_drift: false,
          reason: "drift check parser fallback (invalid JSON)",
          evidence: [],
          confidence: 0,
        } satisfies SessionClosedLoop.DriftCheckResult
      }

      const toBool = (value: unknown) => value === true
      const toString = (value: unknown, fallback = "") => (typeof value === "string" ? value : fallback)
      const toEvidence = (value: unknown) =>
        Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 8) : []
      const toConfidence = (value: unknown) => {
        if (typeof value !== "number" || Number.isNaN(value)) return 0
        if (value < 0) return 0
        if (value > 1) return 1
        return value
      }

      return {
        is_drift: toBool((parsed as Record<string, unknown>).is_drift),
        reason: toString((parsed as Record<string, unknown>).reason, "no reason"),
        evidence: toEvidence((parsed as Record<string, unknown>).evidence),
        confidence: toConfidence((parsed as Record<string, unknown>).confidence),
      } satisfies SessionClosedLoop.DriftCheckResult
    })

    const askDriftDecision = Effect.fn("SessionPrompt.askDriftDecision")(function* (input: {
      sessionID: SessionID
      callID?: string
      messageID?: MessageID
      drift: SessionClosedLoop.DriftCheckResult
    }) {
      const answers = yield* question.ask({
        sessionID: input.sessionID,
        tool:
          input.callID && input.messageID
            ? {
                callID: input.callID,
                messageID: input.messageID,
              }
            : undefined,
        questions: [
          {
            question:
              "Intent drift detected. Continue current execution, adjust target, or stop this run for manual direction?",
            header: "Intent Drift",
            custom: false,
            options: [
              { label: "Continue", description: "Keep current execution path" },
              { label: "Adjust", description: "Pause and wait for new goal from user" },
              { label: "Stop", description: "Stop current run now" },
            ],
          },
        ],
      })
      return answers[0]?.[0] ?? "Adjust"
    })

    const parseJsonObject = (text: string) => {
      const cleaned = text
        .replace(/```json/gi, "")
        .replace(/```/g, "")
        .replace(/<task_result>/gi, "")
        .replace(/<\/task_result>/gi, "")
        .trim()
      const start = cleaned.indexOf("{")
      const end = cleaned.lastIndexOf("}")
      if (start < 0 || end < 0 || end <= start) return
      try {
        return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>
      } catch {
        return
      }
    }

    const parseTaskGraph = (text: string): SessionClosedLoop.TaskGraph | undefined => {
      const parsed = parseJsonObject(text)
      if (!parsed) return
      const graph = (parsed.task_graph ?? parsed) as Record<string, unknown>
      const nodes = Array.isArray(graph.nodes) ? graph.nodes : []
      if (nodes.length === 0) return
      const normalized = nodes.flatMap((node) => {
        if (!node || typeof node !== "object") return []
        const item = node as Record<string, unknown>
        const role = item.task_role
        if (!isTaskRole(role)) return []
        const id = typeof item.id === "string" && item.id.trim() ? item.id.trim() : undefined
        if (!id) return []
        const blockedByRaw = Array.isArray(item.blockedBy)
          ? item.blockedBy
          : Array.isArray(item.blocked_by)
            ? item.blocked_by
            : []
        const blockedBy = blockedByRaw.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        const tagsRaw = Array.isArray(item.tags) ? item.tags : []
        const tags = tagsRaw.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        const description =
          typeof item.description === "string" && item.description.trim() ? item.description.trim() : `task ${id}`
        const agent = typeof item.agent === "string" && item.agent.trim() ? item.agent.trim() : roleAgent(role)
        const needsResearch =
          item.needsResearch === true || item.needs_research === true ? true : item.needsResearch === false ? false : undefined
        return [
          {
            id,
            task_role: role,
            agent,
            description,
            blockedBy,
            needsResearch,
            tags,
          } satisfies SessionClosedLoop.TaskNode,
        ]
      })
      if (normalized.length === 0) return
      return { nodes: normalized }
    }

    const parseReviewerOutput = (text: string): { passed: boolean; notes?: string; task_graph?: SessionClosedLoop.TaskGraph } => {
      const parsed = parseJsonObject(text)
      if (!parsed) return { passed: true }
      const passed = parsed.passed === true
      const notes = typeof parsed.notes === "string" ? parsed.notes : undefined
      if (passed) return { passed, notes }
      const graph = parseTaskGraph(JSON.stringify(parsed.task_graph ?? {}))
      return { passed, notes, ...(graph ? { task_graph: graph } : {}) }
    }

    const normalizeTaskGraph = (graph: SessionClosedLoop.TaskGraph): SessionClosedLoop.TaskGraph => {
      const nodes = graph.nodes.map((node) => ({
        ...node,
        blockedBy: [...new Set(node.blockedBy.filter((item) => item.trim().length > 0))],
        tags: [...new Set(node.tags.filter((item) => item.trim().length > 0))],
      }))
      const seenIDs = new Set(nodes.map((node) => node.id))
      const existingTesterNodes = nodes.filter((node) => node.task_role === "tester")
      const injectedTesterNodes = nodes
        .filter((node) => node.task_role === "coder")
        .flatMap((coderNode) => {
          const description = `Write tests for: ${coderNode.description}`
          const hasPair = existingTesterNodes.some((testerNode) => {
            if (testerNode.id === `test_${coderNode.id}`) return true
            if (testerNode.description.trim() === description) return true
            if (testerNode.blockedBy.includes(coderNode.id)) return true
            return testerNode.tags.includes(`tester_for:${coderNode.id}`)
          })
          if (hasPair) return []
          const baseID = `test_${coderNode.id}`
          let nextID = baseID
          let suffix = 1
          while (seenIDs.has(nextID)) {
            nextID = `${baseID}_${suffix}`
            suffix += 1
          }
          seenIDs.add(nextID)
          return [
            {
              id: nextID,
              task_role: "tester",
              agent: "tester",
              description,
              blockedBy: [],
              needsResearch: false,
              tags: [...new Set([...coderNode.tags, "test", "tester", `tester_for:${coderNode.id}`])],
            } satisfies SessionClosedLoop.TaskNode,
          ]
        })
      const withTester = [...nodes, ...injectedTesterNodes].map((node) =>
        node.task_role === "tester" ? { ...node, blockedBy: [], needsResearch: false } : node,
      )
      const executionNodeIDs = withTester
        .filter((node) => node.task_role === "coder" || node.task_role === "tester")
        .map((node) => node.id)
      return {
        nodes: withTester.map((node) =>
          node.task_role === "reviewer"
            ? {
                ...node,
                blockedBy: [...new Set([...node.blockedBy, ...executionNodeIDs])],
              }
            : node,
        ),
      }
    }

    const emitPlannerViolation = Effect.fn("SessionPrompt.emitPlannerViolation")(function* (input: {
      sessionID: SessionID
      parent: MessageV2.User
      task: MessageV2.SubtaskPart
      tools: string[]
      retry_count: number
      action: "auto_retry" | "ask_user" | "stopped"
    }) {
      const message: MessageV2.User = {
        id: MessageID.ascending(),
        sessionID: input.sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: input.parent.agent,
        model: input.parent.model,
      }
      yield* sessions.updateMessage(message)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: message.id,
        sessionID: input.sessionID,
        type: "text",
        synthetic: true,
        text: JSON.stringify(
          {
            type: "planner_tool_violation",
            task_id: input.task.task_id ?? input.task.id,
            tools: [...new Set(input.tools)],
            retry_count: input.retry_count,
            action: input.action,
            message: "Planner must output TaskGraph JSON only and must not execute tools.",
          },
          null,
          2,
        ),
      } satisfies MessageV2.TextPart)
    })

    const preparePlannerRetryTask = Effect.fn("SessionPrompt.preparePlannerRetryTask")(function* (input: {
      task: MessageV2.SubtaskPart
      tools: string[]
      retry_count: number
    }) {
      const tools = [...new Set(input.tools)]
      const prompt = [
        input.task.prompt,
        "",
        "<planner_violation>",
        `You just called ${tools.join(", ")}. This is not allowed.`,
        `Current retry count: ${input.retry_count}`,
        "Your only valid output is TaskGraph JSON. Any tool call is an error.",
        "Return JSON only. Do not call any tool.",
        "</planner_violation>",
      ].join("\n")
      yield* sessions.updatePart({
        ...input.task,
        type: "subtask",
        tags: [...new Set([...(input.task.tags ?? []), "planner-retry", "taskgraph"])],
        prompt,
      } satisfies MessageV2.SubtaskPart)
    })

    const enqueueTaskGraph = Effect.fn("SessionPrompt.enqueueTaskGraph")(function* (input: {
      sessionID: SessionID
      parent: MessageV2.User
      graph: SessionClosedLoop.TaskGraph
      model: { providerID: ProviderID; modelID: ModelID; variant?: string }
      agent: string
      prefix?: string
      plannerGuardActive?: boolean
      onNodeEnqueued?: (task: MessageV2.SubtaskPart) => Effect.Effect<void>
    }) {
      const normalizedGraph = normalizeTaskGraph(input.graph)
      const idMap = new Map<string, string>()
      for (const node of normalizedGraph.nodes) {
        const nextID = input.prefix ? `${input.prefix}__${node.id}` : node.id
        idMap.set(node.id, nextID)
      }
      const filteredPlanner = normalizedGraph.nodes.filter((node) => node.task_role === "planner")
      if (filteredPlanner.length > 0) {
        log.warn("dropping planner nodes from task graph", {
          sessionID: input.sessionID,
          plannerGuardActive: input.plannerGuardActive === true,
          ids: filteredPlanner.map((node) => node.id),
          prefix: input.prefix,
        })
      }
      const filteredWriter = normalizedGraph.nodes.filter((node) => node.task_role === "writer")
      if (filteredWriter.length > 0) {
        log.warn("dropping writer nodes from task graph", {
          sessionID: input.sessionID,
          ids: filteredWriter.map((node) => node.id),
          prefix: input.prefix,
        })
      }
      const droppedNodeIDs = new Set(
        normalizedGraph.nodes
          .filter((node) => node.task_role === "planner" || node.task_role === "writer")
          .map((node) => node.id),
      )
      const subtaskNodes = normalizedGraph.nodes.filter((node) => node.task_role !== "planner" && node.task_role !== "writer")
      if (subtaskNodes.length === 0) return
      const message: MessageV2.User = {
        id: MessageID.ascending(),
        sessionID: input.sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: input.parent.agent,
        model: input.parent.model,
      }
      yield* sessions.updateMessage(message)
      for (const node of subtaskNodes) {
        const taskRole = node.task_role
        const mappedBlockedBy =
          taskRole === "tester"
            ? []
            : node.blockedBy.flatMap((value) => (droppedNodeIDs.has(value) ? [] : [idMap.get(value) ?? value]))
        const subtask: MessageV2.SubtaskPart = {
          id: PartID.ascending(),
          messageID: message.id,
          sessionID: input.sessionID,
          type: "subtask",
          task_role: taskRole,
          task_id: idMap.get(node.id) ?? node.id,
          blocked_by: mappedBlockedBy,
          needs_research: node.needsResearch,
          tags: node.tags,
          description: node.description,
          agent: node.agent,
          model: { providerID: input.model.providerID, modelID: input.model.modelID },
          prompt: [
            `<task role="${taskRole}" id="${node.id}">`,
            node.description,
            node.tags.length > 0 ? `tags: ${node.tags.join(", ")}` : "",
            "</task>",
          ]
            .filter((line) => line.length > 0)
            .join("\n"),
        }
        yield* sessions.updatePart(subtask)
        if (input.onNodeEnqueued) yield* input.onNodeEnqueued(subtask)
      }
    })

    const runLoopUnsafe = Effect.fn("SessionPrompt.run")(function* (sessionID: SessionID) {
        const ctx = yield* InstanceState.context
        const slog = elog.with({ sessionID })
        let structured: unknown
        let step = 0
        let sessionAnchor: SessionClosedLoop.SessionIntentAnchor | undefined
        let plannerSeeded = false
        let reviewerRounds = 0
        let plannerViolationRetries = 0
        let writerRan = false
        let skipChangelogAndProjectLesson = false
        let skipGlobalResearchLesson = false
        const rememberedUserMessageIDs = new Set<string>()
        const researchDrafts: Array<{
          topic: string
          lesson: string
          detail: string
          fix: string
          tags: string[]
        }> = []
        const session = yield* sessions.get(sessionID).pipe(Effect.orDie)
        const schedulerTodos = new Map<string, SchedulerTodoItem>()
        const schedulerTodoSyncLock = Semaphore.makeUnsafe(1)
        let schedulerTodoOrder = 0

        const taskTodoKey = (task: MessageV2.SubtaskPart) => {
          if (typeof task.task_id === "string" && task.task_id.trim().length > 0) return task.task_id.trim()
          if (typeof task.id === "string" && task.id.trim().length > 0) return task.id.trim()
          return closedLoop.taskKey(task)
        }
        const syncSchedulerTodos = Effect.fn("SessionPrompt.syncSchedulerTodos")(function* () {
          yield* schedulerTodoSyncLock.withPermits(1)(
            Effect.gen(function* () {
              const todos = [...schedulerTodos.values()]
                .toSorted((a, b) => a.order - b.order)
                .map((item) => ({
                  content: item.content,
                  status: schedulerTodoStatus(item.status),
                  priority: "medium",
                  task_role: item.taskRole,
                  task_id: item.taskID,
                  topology_layer: item.layer,
                  started_at: item.startedAt,
                  completed_at: item.completedAt,
                  duration_ms: item.durationMs,
                }))
              yield* todo.update({ sessionID, todos })
            }),
          )
        })
        const upsertSchedulerTodo = Effect.fn("SessionPrompt.upsertSchedulerTodo")(function* (input: {
          key: string
          content: string
          status: SchedulerTodoStatus
          taskRole?: MessageV2.TaskRole
          taskID?: string
          layer?: number
        }) {
          const existing = schedulerTodos.get(input.key)
          if (existing) {
            const next = {
              ...existing,
              content: input.content,
              status: input.status,
              taskRole: input.taskRole ?? existing.taskRole,
              taskID: input.taskID ?? existing.taskID,
              layer: input.layer ?? existing.layer,
            } satisfies SchedulerTodoItem
            if (
              existing.content === next.content &&
              existing.status === next.status &&
              existing.taskRole === next.taskRole &&
              existing.taskID === next.taskID &&
              existing.layer === next.layer
            )
              return
            schedulerTodos.set(input.key, next)
            yield* syncSchedulerTodos()
            return
          }
          schedulerTodos.set(input.key, {
            content: input.content,
            status: input.status,
            order: schedulerTodoOrder++,
            taskRole: input.taskRole,
            taskID: input.taskID,
            layer: input.layer,
          })
          yield* syncSchedulerTodos()
        })
        const setSchedulerTodoStatus = Effect.fn("SessionPrompt.setSchedulerTodoStatus")(function* (input: {
          task: MessageV2.SubtaskPart
          status: SchedulerTodoStatus
        }) {
          const key = taskTodoKey(input.task)
          const existing = schedulerTodos.get(key)
          if (!existing) {
            yield* upsertSchedulerTodo({
              key,
              content: input.task.description,
              status: input.status,
              taskRole: input.task.task_role,
              taskID: input.task.task_id ?? closedLoop.taskKey(input.task),
            })
            return
          }
          if (existing.status === input.status) return
          const now = Date.now()
          schedulerTodos.set(key, {
            ...existing,
            status: input.status,
            startedAt:
              input.status === "executing" ? (existing.startedAt ?? now) : existing.startedAt,
            completedAt:
              input.status === "completed" || input.status === "failed" ? now : existing.completedAt,
            durationMs:
              input.status === "completed" || input.status === "failed"
                ? existing.startedAt
                  ? Math.max(0, now - existing.startedAt)
                  : existing.durationMs
                : existing.durationMs,
            taskRole: existing.taskRole ?? input.task.task_role,
            taskID: existing.taskID ?? input.task.task_id ?? closedLoop.taskKey(input.task),
          })
          yield* syncSchedulerTodos()
        })

        while (true) {
          yield* status.set(sessionID, { type: "busy" })
          yield* slog.info("loop", { step })

          let msgs = yield* MessageV2.filterCompactedEffect(sessionID)

          let lastUser: MessageV2.User | undefined
          let lastAssistant: MessageV2.Assistant | undefined
          let lastFinished: MessageV2.Assistant | undefined
          let tasks: (MessageV2.CompactionPart | MessageV2.SubtaskPart)[] = []
          for (let i = msgs.length - 1; i >= 0; i--) {
            const msg = msgs[i]
            if (!lastUser && msg.info.role === "user") lastUser = msg.info
            if (!lastAssistant && msg.info.role === "assistant") lastAssistant = msg.info
            if (!lastFinished && msg.info.role === "assistant" && msg.info.finish) lastFinished = msg.info
            if (lastUser && lastFinished) break
            const task = msg.parts.filter((part) => part.type === "compaction" || part.type === "subtask")
            if (task && !lastFinished) tasks.push(...task)
          }

          if (!lastUser) throw new Error("No user message found in stream. This should never happen.")

          const lastAssistantMsg = msgs.findLast(
            (msg) => msg.info.role === "assistant" && msg.info.id === lastAssistant?.id,
          )
          // Some providers return "stop" even when the assistant message contains tool calls.
          // Keep the loop running so tool results can be sent back to the model.
          // Skip provider-executed tool parts — those were fully handled within the
          // provider's stream (e.g. DWS Agent Platform) and don't need a re-loop.
          const hasToolCalls =
            lastAssistantMsg?.parts.some((part) => part.type === "tool" && !part.metadata?.providerExecuted) ?? false

          if (
            lastAssistant?.finish &&
            !["tool-calls"].includes(lastAssistant.finish) &&
            !hasToolCalls &&
            lastUser.id < lastAssistant.id
          ) {
            yield* slog.info("exiting loop")
            break
          }

          step++
          if (step === 1)
            yield* title({
              session,
              modelID: lastUser.model.modelID,
              providerID: lastUser.model.providerID,
              history: msgs,
            }).pipe(Effect.ignore, Effect.forkIn(scope))

          const model = yield* getModel(lastUser.model.providerID, lastUser.model.modelID, sessionID)
          const anchor = yield* closedLoop.resolveIntentAnchor({ sessionID, messages: msgs })
          sessionAnchor = anchor ?? sessionAnchor
          const subtaskParts = tasks.filter((part): part is MessageV2.SubtaskPart => part.type === "subtask")
          if (subtaskParts.length === 0 && !plannerSeeded) {
            const plannerAgent = yield* agents.get("planner")
            const lastUserMessage = msgs.find((message) => message.info.id === lastUser.id)
            const userText =
              lastUserMessage?.parts
                .filter((part): part is MessageV2.TextPart => part.type === "text" && !part.synthetic && !part.ignored)
                .map((part) => part.text)
                .join("\n")
                .trim() ?? ""
            if (plannerAgent && shouldForceTaskGraph({ agent: lastUser.agent, text: userText })) {
              const plannerMessage: MessageV2.User = {
                id: MessageID.ascending(),
                sessionID,
                role: "user",
                time: { created: Date.now() },
                agent: lastUser.agent,
                model: lastUser.model,
              }
              yield* sessions.updateMessage(plannerMessage)
              yield* sessions.updatePart({
                id: PartID.ascending(),
                messageID: plannerMessage.id,
                sessionID,
                type: "subtask",
                task_role: "planner",
                task_id: `planner:${plannerMessage.id}`,
                blocked_by: [],
                tags: ["taskgraph", "orchestrator"],
                description: "Build TaskGraph",
                agent: plannerAgent.name,
                model: { providerID: model.providerID, modelID: model.id },
                prompt: [
                  "Build an executable TaskGraph for this request.",
                  "This is mandatory for non-trivial requests.",
                  `Intent anchor: ${(anchor?.text ?? userText).trim()}`,
                  "Return JSON only with {nodes:[...]} and include task_role on every node.",
                  "Use execution roles only: coder/tester/research/reviewer/writer.",
                  "",
                  "User request:",
                  userText,
                ].join("\n"),
              } satisfies MessageV2.SubtaskPart)
              plannerSeeded = true
              continue
            }
          }
          if (subtaskParts.length > 0) {
            const completed = yield* closedLoop.listCompletedSubtasks(sessionID)
            const droppedWriterSubtasks = subtaskParts.filter((task) => task.task_role === "writer")
            if (droppedWriterSubtasks.length > 0) {
              log.warn("dropping writer subtasks from execution queue", {
                sessionID,
                ids: droppedWriterSubtasks.map((task) => task.task_id ?? task.id),
              })
            }
            const pending = subtaskParts.filter(
              (task) => task.task_role !== "writer" && !completed.includes(closedLoop.taskKey(task)),
            )
            for (const task of subtaskParts) {
              if (task.task_role === "writer") continue
              yield* upsertSchedulerTodo({
                key: taskTodoKey(task),
                content: task.description,
                status: completed.includes(closedLoop.taskKey(task)) ? "completed" : "pending",
                taskRole: task.task_role,
                taskID: task.task_id ?? closedLoop.taskKey(task),
              })
            }
            if (pending.length > 0) {
              const layers = closedLoop.taskLayers({ pending, completed })
              for (const [layerIndex, layerTasks] of layers.layers.entries()) {
                for (const layerTask of layerTasks) {
                  const key = taskTodoKey(layerTask)
                  const existing = schedulerTodos.get(key)
                  yield* upsertSchedulerTodo({
                    key,
                    content: layerTask.description,
                    status: existing?.status ?? "pending",
                    taskRole: layerTask.task_role,
                    taskID: layerTask.task_id ?? closedLoop.taskKey(layerTask),
                    layer: layerIndex,
                  })
                }
              }
              if (layers.layers.length === 0 && layers.unresolved.length > 0) {
                const cycle = layers.unresolved.map((task) => task.task_id ?? task.id).filter(Boolean)
                const error = new NamedError.Unknown({
                  message: `Task dependency deadlock detected. unresolved=${cycle.join(", ") || "unknown"}`,
                })
                yield* bus.publish(Session.Event.Error, { sessionID, error: error.toObject() })
                throw error
              }

              const layer = layers.layers[0] ?? []
              const layerResults = yield* Effect.forEach(
                layer,
                Effect.fnUntraced(function* (task) {
                  const legacy =
                    task.agent === "general" ? "coder" : task.agent === "explore" ? "planner" : task.agent === "scout" ? "research" : undefined
                  if (legacy) {
                    throw new NamedError.Unknown({
                      message: `Subtask agent "${task.agent}" is deprecated. Use "${legacy}" (migration: general->coder, explore->planner, scout->research).`,
                    })
                  }
                  const taskRole = task.task_role
                  const inferred = roleForAgent(task.agent)
                  if (inferred && inferred !== taskRole) {
                    throw new NamedError.Unknown({
                      message: `Task role/agent mismatch: task_role=${taskRole}, agent=${task.agent}`,
                    })
                  }
                  const routedAgent = inferred ? task.agent : roleAgent(taskRole)
                  let nextTask: MessageV2.SubtaskPart = { ...task, agent: routedAgent }
                  if (taskRole === "coder" && task.needs_research) {
                    const cached = yield* closedLoop.findResearchLesson({
                      topic: `${task.description}\n${task.prompt}`,
                      tags: task.tags ?? [],
                      refresh: looksLikeRefreshRequest(task.prompt),
                    })
                    if (cached?.lesson?.trim()) {
                      nextTask = {
                        ...nextTask,
                        prompt: `${task.prompt}\n\n<research_context reused=\"true\">\n${cached.lesson}\n</research_context>`,
                      }
                    } else {
                      const researchAgent = yield* agents.get(roleAgent("research"))
                      if (researchAgent) {
                        const researchTask: MessageV2.SubtaskPart = {
                          ...task,
                          id: PartID.ascending(),
                          task_role: "research",
                          task_id: `${task.task_id ?? task.id ?? PartID.ascending()}:research`,
                          description: `Research: ${task.description}`.slice(0, 120),
                          agent: researchAgent.name,
                          blocked_by: [],
                          needs_research: false,
                          prompt: [
                            "Research the following implementation task and provide concise actionable findings:",
                            task.prompt,
                          ].join("\n\n"),
                        }
                        yield* setSchedulerTodoStatus({ task: researchTask, status: "executing" })
                        const researchResult = yield* handleSubtask({
                          task: researchTask,
                          model,
                          lastUser,
                          sessionID,
                          session,
                          msgs,
                        })
                        yield* setSchedulerTodoStatus({
                          task: researchTask,
                          status: researchResult ? "completed" : "failed",
                        })
                        const researchText = researchResult?.output?.trim() ?? ""
                        if (researchText) {
                          nextTask = {
                            ...nextTask,
                            prompt: `${task.prompt}\n\n<research_context>\n${researchText}\n</research_context>`,
                          }
                        }
                        const draft = researchResult?.metadata?.researchDraft
                        if (draft && typeof draft === "object") {
                          const item = draft as {
                            topic?: string
                            lesson?: string
                            detail?: string
                            fix?: string
                            tags?: string[]
                          }
                          if (item.topic && item.lesson && item.detail && item.fix) {
                            researchDrafts.push({
                              topic: item.topic,
                              lesson: item.lesson,
                              detail: item.detail,
                              fix: item.fix,
                              tags: Array.isArray(item.tags)
                                ? item.tags.filter((tag): tag is string => typeof tag === "string")
                                : ["research"],
                            })
                          }
                        }
                      }
                    }
                  }

                  yield* setSchedulerTodoStatus({ task, status: "executing" })
                  const result = yield* handleSubtask({ task: nextTask, model, lastUser, sessionID, session, msgs })
                  yield* setSchedulerTodoStatus({
                    task,
                    status: result ? "completed" : "failed",
                  })
                  return { task: nextTask, result, completedKey: closedLoop.taskKey(task) }
                }),
                { concurrency: "unbounded" },
              )

              let stopAfterPlannerViolation = false
              const skipCompletion = new Set<string>()
              for (const item of layerResults) {
                if (!item) continue
                if (!item.result?.output) continue
                if (item.task.task_role === "planner") {
                  const plannerSessionID =
                    typeof item.result.metadata?.sessionId === "string"
                      ? SessionID.make(item.result.metadata.sessionId)
                      : undefined
                  if (plannerSessionID) {
                    const plannerMessages = yield* MessageV2.filterCompactedEffect(plannerSessionID).pipe(
                      Effect.catch(() => Effect.succeed([])),
                    )
                    const usedTools = plannerMessages.flatMap((message) =>
                      message.parts.flatMap((part) => {
                        if (part.type !== "tool") return []
                        if (part.state.status !== "completed") return []
                        return [part.tool]
                      }),
                    )
                    if (usedTools.length > 0) {
                      const uniqueTools = [...new Set(usedTools)]
                      plannerViolationRetries += 1
                      skipCompletion.add(item.completedKey)
                      if (plannerViolationRetries <= 1) {
                        yield* emitPlannerViolation({
                          sessionID,
                          parent: lastUser,
                          task: item.task,
                          tools: uniqueTools,
                          retry_count: plannerViolationRetries,
                          action: "auto_retry",
                        })
                        yield* preparePlannerRetryTask({
                          task: item.task,
                          tools: uniqueTools,
                          retry_count: plannerViolationRetries,
                        })
                      }
                      if (plannerViolationRetries > 1) {
                        yield* emitPlannerViolation({
                          sessionID,
                          parent: lastUser,
                          task: item.task,
                          tools: uniqueTools,
                          retry_count: plannerViolationRetries,
                          action: "ask_user",
                        })
                        const answers = yield* question
                          .ask({
                            sessionID,
                            questions: [
                              {
                                question: `Planner called forbidden tools (${uniqueTools.join(", ")}). Retry planner once more or stop?`,
                                header: "Planner Violation",
                                custom: false,
                                options: [
                                  { label: "Retry", description: "Retry planner with strict no-tool warning" },
                                  { label: "Stop", description: "Stop and wait for manual direction" },
                                ],
                              },
                            ],
                          })
                          .pipe(Effect.catch(() => Effect.succeed([[]])))
                        if (answers[0]?.[0] === "Retry") {
                          yield* preparePlannerRetryTask({
                            task: item.task,
                            tools: uniqueTools,
                            retry_count: plannerViolationRetries,
                          })
                        }
                        if (answers[0]?.[0] !== "Retry") {
                          yield* emitPlannerViolation({
                            sessionID,
                            parent: lastUser,
                            task: item.task,
                            tools: uniqueTools,
                            retry_count: plannerViolationRetries,
                            action: "stopped",
                          })
                          stopAfterPlannerViolation = true
                        }
                      }
                      continue
                    }
                    plannerViolationRetries = 0
                  }
                  const graph = parseTaskGraph(item.result.output)
                  if (graph) {
                    yield* enqueueTaskGraph({
                      sessionID,
                      parent: lastUser,
                      graph,
                      model: lastUser.model,
                      agent: lastUser.agent,
                      plannerGuardActive: plannerSeeded,
                      onNodeEnqueued: (task) =>
                        upsertSchedulerTodo({
                          key: taskTodoKey(task),
                          content: task.description,
                          status: "pending",
                          taskRole: task.task_role,
                          taskID: task.task_id ?? closedLoop.taskKey(task),
                        }),
                    })
                  }
                }
                if (item.task.task_role !== "reviewer") continue
                const review = parseReviewerOutput(item.result.output)
                if (review.passed) {
                  reviewerRounds = 0
                  continue
                }
                if (!review.task_graph) continue
                reviewerRounds += 1
                if (reviewerRounds > 5) {
                  const answers = yield* question
                    .ask({
                      sessionID,
                      questions: [
                        {
                          question:
                            "Reviewer generated fix TaskGraphs for more than 5 rounds. Continue with another fix round or stop for manual direction?",
                          header: "Reviewer Loop",
                          custom: false,
                          options: [
                            { label: "Continue", description: "Proceed with another fix graph round" },
                            { label: "Stop", description: "Stop and wait for manual direction" },
                          ],
                        },
                      ],
                    })
                    .pipe(Effect.catch(() => Effect.succeed([[]])))
                  if (answers[0]?.[0] !== "Continue") break
                  reviewerRounds = 1
                }
                yield* enqueueTaskGraph({
                  sessionID,
                  parent: lastUser,
                  graph: review.task_graph,
                  model: lastUser.model,
                  agent: lastUser.agent,
                  prefix: `round_${reviewerRounds}`,
                  plannerGuardActive: plannerSeeded,
                  onNodeEnqueued: (task) =>
                    upsertSchedulerTodo({
                      key: taskTodoKey(task),
                      content: task.description,
                      status: "pending",
                      taskRole: task.task_role,
                      taskID: task.task_id ?? closedLoop.taskKey(task),
                    }),
                })
              }
              for (const item of layerResults) {
                if (!item) continue
                if (skipCompletion.has(item.completedKey)) continue
                yield* closedLoop.markSubtaskCompleted({ sessionID, taskKey: item.completedKey })
              }
              if (stopAfterPlannerViolation) break

              const completedAfter = yield* closedLoop.listCompletedSubtasks(sessionID)
              const checkpoint = yield* closedLoop.driftCheckpoint({
                sessionID,
                completedSubtasks: completedAfter.length,
              })

              if (checkpoint && anchor) {
                const latestMsgs = yield* MessageV2.filterCompactedEffect(sessionID)
                const summaries = latestMsgs
                  .flatMap((message) =>
                    message.parts.flatMap((part) => {
                      if (part.type !== "tool" || part.tool !== TaskTool.id) return []
                      if (part.state.status !== "completed") return []
                      const desc = part.state.input.description
                      if (typeof desc === "string" && desc.trim()) return [desc.trim()]
                      return []
                    }),
                  )
                  .slice(-checkpoint)
                const diffs = yield* summary.diff({ sessionID })
                const driftAgent = (yield* agents.get(lastUser.agent)) ?? (yield* agents.get("orchestrator"))
                if (!driftAgent) {
                  yield* closedLoop.markDriftChecked({ sessionID, completedSubtasks: checkpoint })
                  continue
                }
                const drift = yield* runDriftCheck({
                  sessionID,
                  user: lastUser,
                  agent: driftAgent,
                  model,
                  anchor,
                  completedSubtasks: completedAfter.length,
                  summaries,
                  diffs,
                })
                yield* closedLoop.markDriftChecked({ sessionID, completedSubtasks: checkpoint })

                if (drift.is_drift) {
                  const driftMsg: MessageV2.Assistant = {
                    id: MessageID.ascending(),
                    parentID: lastUser.id,
                    role: "assistant",
                    mode: lastUser.agent,
                    agent: lastUser.agent,
                    variant: lastUser.model.variant,
                    path: { cwd: ctx.directory, root: ctx.worktree },
                    cost: 0,
                    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                    modelID: model.id,
                    providerID: model.providerID,
                    time: { created: Date.now(), completed: Date.now() },
                    finish: "stop",
                    sessionID,
                  }
                  yield* sessions.updateMessage(driftMsg)
                  yield* sessions.updatePart({
                    id: PartID.ascending(),
                    messageID: driftMsg.id,
                    sessionID,
                    type: "text",
                    text: [
                      "Intent drift detected; scheduler paused.",
                      `reason: ${drift.reason}`,
                      `confidence: ${drift.confidence.toFixed(2)}`,
                      ...(drift.evidence.length > 0 ? ["evidence:", ...drift.evidence.map((item) => `- ${item}`)] : []),
                    ].join("\n"),
                  })

                  const decision = yield* askDriftDecision({
                    sessionID,
                    drift,
                  }).pipe(Effect.catch(() => Effect.succeed("Adjust")))

                  if (decision === "Continue") {
                    const note: MessageV2.User = {
                      id: MessageID.ascending(),
                      sessionID,
                      role: "user",
                      time: { created: Date.now() },
                      agent: lastUser.agent,
                      model: lastUser.model,
                    }
                    yield* sessions.updateMessage(note)
                    yield* sessions.updatePart({
                      id: PartID.ascending(),
                      messageID: note.id,
                      sessionID,
                      type: "text",
                      synthetic: true,
                      text: "User decided to continue after drift warning. Re-align execution with the intent anchor.",
                    } satisfies MessageV2.TextPart)
                  } else {
                    if (decision === "Adjust") {
                      yield* closedLoop.requestIntentAnchorRefresh(sessionID)
                    }
                    break
                  }
                }
              }
              continue
            }
          }

          const compactionTask = tasks.find((part): part is MessageV2.CompactionPart => part.type === "compaction")
          if (compactionTask) {
            const result = yield* compaction.process({
              messages: msgs,
              parentID: lastUser.id,
              sessionID,
              auto: compactionTask.auto,
              overflow: compactionTask.overflow,
            })
            if (result === "stop") break
            continue
          }

          if (
            lastFinished &&
            lastFinished.summary !== true &&
            (yield* compaction.isOverflow({ tokens: lastFinished.tokens, model }))
          ) {
            yield* compaction.create({ sessionID, agent: lastUser.agent, model: lastUser.model, auto: true })
            continue
          }

          const agent = yield* agents.get(lastUser.agent)
          if (!agent) {
            const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
            const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
            const error = new NamedError.Unknown({ message: `Agent not found: "${lastUser.agent}".${hint}` })
            yield* bus.publish(Session.Event.Error, { sessionID, error: error.toObject() })
            throw error
          }
          const maxSteps = agent.steps ?? Infinity
          const isLastStep = step >= maxSteps
          msgs = yield* insertReminders({ messages: msgs, agent, session })

          const msg: MessageV2.Assistant = {
            id: MessageID.ascending(),
            parentID: lastUser.id,
            role: "assistant",
            mode: agent.name,
            agent: agent.name,
            variant: lastUser.model.variant,
            path: { cwd: ctx.directory, root: ctx.worktree },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: model.id,
            providerID: model.providerID,
            time: { created: Date.now() },
            sessionID,
          }
          yield* sessions.updateMessage(msg)
          const handle = yield* processor.create({
            assistantMessage: msg,
            sessionID,
            model,
          })

          const outcome: "break" | "continue" = yield* Effect.gen(function* () {
            const lastUserMsg = msgs.findLast((m) => m.info.role === "user")
            const bypassAgentCheck = lastUserMsg?.parts.some((p) => p.type === "agent") ?? false

            const tools = yield* resolveTools({
              agent,
              session,
              model,
              tools: lastUser.tools,
              processor: handle,
              bypassAgentCheck,
              messages: msgs,
            })

            if (lastUser.format?.type === "json_schema") {
              tools["StructuredOutput"] = createStructuredOutputTool({
                schema: lastUser.format.schema,
                onSuccess(output) {
                  structured = output
                },
              })
            }

            if (step === 1)
              yield* summary.summarize({ sessionID, messageID: lastUser.id }).pipe(Effect.ignore, Effect.forkIn(scope))

            if (step > 1 && lastFinished) {
              for (const m of msgs) {
                if (m.info.role !== "user" || m.info.id <= lastFinished.id) continue
                for (const p of m.parts) {
                  if (p.type !== "text" || p.ignored || p.synthetic) continue
                  if (!p.text.trim()) continue
                  p.text = [
                    "<system-reminder>",
                    "The user sent the following message:",
                    p.text,
                    "",
                    "Please address this message and continue with your tasks.",
                    "</system-reminder>",
                  ].join("\n")
                }
              }
            }

            yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })

            const latestUserMessage = msgs.findLast((message) => message.info.role === "user")
            const userText = latestUserMessage?.parts
              .filter((part): part is MessageV2.TextPart => part.type === "text" && !part.synthetic && !part.ignored)
              .map((part) => part.text)
              .join("\n")
              .trim()
            if (
              latestUserMessage &&
              userText &&
              hasExplicitMemoryInstruction(userText) &&
              !rememberedUserMessageIDs.has(latestUserMessage.info.id)
            ) {
              yield* closedLoop
                .supermemoryAdd({
                  content: userText,
                  scope: "user",
                  tags: ["keyword"],
                })
                .pipe(Effect.ignore)
              rememberedUserMessageIDs.add(latestUserMessage.info.id)
            }

            const memory =
              step === 1 && userText
                ? yield* closedLoop
                    .supermemorySearch({
                      query: userText,
                      topK: 5,
                    })
                    .pipe(Effect.orElseSucceed(() => []))
                : []
            const reusableLessonsRaw =
              step === 1 && userText
                ? yield* closedLoop
                    .searchReusableLessons({
                      sessionID,
                      query: userText,
                      topK: 5,
                    })
                    .pipe(Effect.orElseSucceed(() => []))
                : []
            const reusableLessons =
              agent.name === "writer"
                ? reusableLessonsRaw.filter((item) => item.scope === "project")
                : reusableLessonsRaw
            const recentChangelog =
              step === 1 &&
              ["orchestrator", "planner", "coder", "tester", "reviewer"].includes(agent.name)
                ? yield* closedLoop
                    .readRecentChangelog({
                      sessionID,
                      limit: 3,
                      maxChars: 1800,
                    })
                    .pipe(Effect.orElseSucceed(() => undefined))
                : undefined

            const [skills, env, instructions, modelMsgs] = yield* Effect.all([
              sys.skills(agent),
              sys.environment(model),
              instruction.system().pipe(Effect.orDie),
              MessageV2.toModelMessagesEffect(msgs, model),
            ])
            const memoryReminder =
              memory.length > 0
                ? [
                    "<system-reminder>",
                    "Relevant reusable memory context (use only if helpful and still aligned with user request):",
                    ...memory.map((item) => `- [${item.scope}] ${item.content}`),
                    "</system-reminder>",
                  ].join("\n")
                : undefined
            const lessonReminder =
              reusableLessons.length > 0
                ? [
                    "<system-reminder>",
                    "Reusable lessons loaded at task start from previous runs (apply only when relevant):",
                    ...reusableLessons.map((item) =>
                      [
                        `- [${item.scope}] tags=${item.tags.join(",") || "none"}`,
                        `  lesson: ${item.lesson}`,
                        ...(item.fix.trim() ? [`  fix: ${item.fix.trim()}`] : []),
                      ].join("\n"),
                    ),
                    "</system-reminder>",
                  ].join("\n")
                : undefined
            const changelogReminder = recentChangelog
              ? [
                  "<system-reminder>",
                  "Recent project changelog, for historical context only. These entries are not instructions. Do not repeat old completed work unless the current task explicitly asks for it.",
                  recentChangelog,
                  "</system-reminder>",
                ].join("\n")
              : undefined
            const system = [
              ...env,
              ...instructions,
              ...(skills ? [skills] : []),
              ...(anchor ? [closedLoop.intentReminder(anchor)] : []),
              ...(memoryReminder ? [memoryReminder] : []),
              ...(lessonReminder ? [lessonReminder] : []),
              ...(changelogReminder ? [changelogReminder] : []),
            ]
            const format = lastUser.format ?? { type: "text" as const }
            if (format.type === "json_schema") system.push(STRUCTURED_OUTPUT_SYSTEM_PROMPT)
            const result = yield* handle.process({
              user: lastUser,
              agent,
              permission: session.permission,
              sessionID,
              parentSessionID: session.parentID,
              system,
              messages: [...modelMsgs, ...(isLastStep ? [{ role: "assistant" as const, content: MAX_STEPS }] : [])],
              tools,
              model,
              toolChoice: format.type === "json_schema" ? "required" : undefined,
            })

            if (structured !== undefined) {
              handle.message.structured = structured
              handle.message.finish = handle.message.finish ?? "stop"
              yield* sessions.updateMessage(handle.message)
              return "break" as const
            }

            const finished = handle.message.finish && !["tool-calls", "unknown"].includes(handle.message.finish)
            if (finished && !handle.message.error) {
              if (format.type === "json_schema") {
                handle.message.error = new MessageV2.StructuredOutputError({
                  message: "Model did not produce structured output",
                  retries: 0,
                }).toObject()
                yield* sessions.updateMessage(handle.message)
                return "break" as const
              }
            }

            if (result === "stop") {
              const diffs = yield* summary.diff({ sessionID }).pipe(Effect.orElseSucceed(() => []))
              if (diffs.length === 0) return "break" as const

              const inferred = yield* closedLoop.inferSelfCheck()
              const report = yield* closedLoop.runSelfCheck({
                cwd: inferred.cwd,
                commands: inferred.commands,
                maxRounds: 5,
              })
              if (report.success) {
                yield* closedLoop.bumpSelfCheckRounds({ sessionID, reset: true })
                return "break" as const
              }

              const rounds = yield* closedLoop.bumpSelfCheckRounds({ sessionID })
              if (rounds >= 5) {
                const answers = yield* question
                  .ask({
                    sessionID,
                    questions: [
                      {
                        question:
                          "Selfcheck failed for 5 rounds. Continue attempting automatic fixes or stop and wait for manual direction?",
                        header: "Selfcheck",
                        custom: false,
                        options: [
                          { label: "Continue", description: "Continue automatic repair loop" },
                          { label: "Stop", description: "Stop now and wait for user decision" },
                        ],
                      },
                    ],
                  })
                  .pipe(Effect.catch(() => Effect.succeed([[]])))
                if (answers[0]?.[0] === "Continue") {
                  yield* closedLoop.bumpSelfCheckRounds({ sessionID, reset: true })
                  const note: MessageV2.User = {
                    id: MessageID.ascending(),
                    sessionID,
                    role: "user",
                    time: { created: Date.now() },
                    agent: lastUser.agent,
                    model: lastUser.model,
                  }
                  yield* sessions.updateMessage(note)
                  yield* sessions.updatePart({
                    id: PartID.ascending(),
                    messageID: note.id,
                    sessionID,
                    type: "text",
                    synthetic: true,
                    text: [
                      "Continue automatic fix attempts.",
                      "Selfcheck report:",
                      JSON.stringify(report, null, 2),
                    ].join("\n\n"),
                  } satisfies MessageV2.TextPart)
                  return "continue" as const
                }
                skipChangelogAndProjectLesson = true
                return "break" as const
              }

              const retry: MessageV2.User = {
                id: MessageID.ascending(),
                sessionID,
                role: "user",
                time: { created: Date.now() },
                agent: lastUser.agent,
                model: lastUser.model,
              }
              yield* sessions.updateMessage(retry)
              yield* sessions.updatePart({
                id: PartID.ascending(),
                messageID: retry.id,
                sessionID,
                type: "text",
                synthetic: true,
                text: [
                  `Selfcheck failed (round ${rounds}/5).`,
                  "Fix the issues and rerun checks.",
                  "Report:",
                  JSON.stringify(report, null, 2),
                ].join("\n\n"),
              } satisfies MessageV2.TextPart)
              return "continue" as const
            }
            if (result === "compact") {
              yield* compaction.create({
                sessionID,
                agent: lastUser.agent,
                model: lastUser.model,
                auto: true,
                overflow: !handle.message.finish,
              })
            }
            return "continue" as const
          }).pipe(Effect.ensuring(instruction.clear(handle.message.id)))
          if (outcome === "break") break
          continue
        }

        const completedSubtasks = yield* closedLoop.listCompletedSubtasks(sessionID)
        const diffs = yield* summary.diff({ sessionID }).pipe(Effect.orElseSucceed(() => []))
        if (
          completedSubtasks.length > 0 &&
          !writerRan &&
          skipChangelogAndProjectLesson &&
          (skipGlobalResearchLesson || researchDrafts.length === 0)
        ) {
          yield* slog.info("skipping writer persistence after selfcheck stop", {
            completedSubtasks: completedSubtasks.length,
            skipChangelogAndProjectLesson,
            skipGlobalResearchLesson,
            researchDraftCount: researchDrafts.length,
          })
        }
        if (
          completedSubtasks.length > 0 &&
          !writerRan &&
          (!skipChangelogAndProjectLesson || (!skipGlobalResearchLesson && researchDrafts.length > 0))
        ) {
          const latestMsgs = yield* MessageV2.filterCompactedEffect(sessionID)
          const finalUserMsg = latestMsgs.findLast((message) => message.info.role === "user")
          if (!finalUserMsg || finalUserMsg.info.role !== "user") {
            yield* compaction.prune({ sessionID }).pipe(Effect.ignore, Effect.forkIn(scope))
            return yield* lastAssistant(sessionID)
          }
          const finalModel = yield* getModel(finalUserMsg.info.model.providerID, finalUserMsg.info.model.modelID, sessionID)
          const completedSummaries = completedSubtasks
            .flatMap((taskID) => {
              const todoByTaskID = [...schedulerTodos.values()].find((item) => item.taskID === taskID)
              if (todoByTaskID && todoByTaskID.content.trim().length > 0) return [todoByTaskID.content.trim()]
              const todoByKey = schedulerTodos.get(taskID)
              if (todoByKey && todoByKey.content.trim().length > 0) return [todoByKey.content.trim()]
              return []
            })
            .filter((value, index, array) => array.indexOf(value) === index)
          const lines =
            diffs.length > 0
              ? diffs
                  .slice(0, 30)
                  .map((diff) => `- ${diff.file ?? "unknown"} (+${Math.max(0, diff.additions)}, -${Math.max(0, diff.deletions)})`)
              : completedSummaries.length > 0
                ? completedSummaries.slice(0, 30).map((summary) => `- ${summary}`)
                : ["- none"]
          const writerTask: MessageV2.SubtaskPart = {
            id: PartID.ascending(),
            messageID: MessageID.ascending(),
            sessionID,
            type: "subtask",
            task_role: "writer",
            task_id: `writer:final:${sessionID}`,
            blocked_by: [],
            needs_research: false,
            tags: ["writer", "persistence"],
            description: skipChangelogAndProjectLesson ? "Persist global research lessons only" : "Persist changelog and lessons",
            agent: roleAgent("writer"),
            model: { providerID: finalModel.providerID, modelID: finalModel.id },
            prompt: [
              skipChangelogAndProjectLesson
                ? "Persistence mode: research-only. Do NOT call changelog_append. Do NOT write project-scoped lessons."
                : "Persistence mode: full. Persist session outputs using changelog_append, lesson_classify, and lesson_write.",
              !skipGlobalResearchLesson && researchDrafts.length > 0
                ? "Write global research lessons from research drafts when quality gate is satisfied."
                : "No global research lesson writes: none are available for this run.",
              "For normal session lessons, you must follow lesson_classify output scope exactly.",
              "Do NOT override lesson_classify scope based on intuition.",
              "Global lesson writes are allowed only when lesson_classify returns global OR a lesson comes from research drafts and passes the global research quality gate.",
              "Rule: If completed subtasks > 0 and mode allows changelog/project lessons, do NOT no-op even when git diff is empty.",
              `Intent anchor: ${sessionAnchor?.text ?? "n/a"}`,
              `Completed subtasks: ${completedSubtasks.length}`,
              "",
              diffs.length > 0
                ? "Changed files (git diff):"
                : completedSummaries.length > 0
                  ? "Changed files fallback (completed subtasks summary):"
                  : "Changed files:",
              ...lines,
              "",
              "Research drafts:",
              researchDrafts.length > 0 ? JSON.stringify(researchDrafts, null, 2) : "[]",
            ].join("\n"),
            command: "writer_persist",
          }
          yield* upsertSchedulerTodo({
            key: taskTodoKey(writerTask),
            content: writerTask.description,
            status: "pending",
            taskRole: writerTask.task_role,
            taskID: writerTask.task_id ?? closedLoop.taskKey(writerTask),
            layer: Math.max(-1, ...[...schedulerTodos.values()].map((item) => item.layer ?? -1)) + 1,
          })
          yield* setSchedulerTodoStatus({ task: writerTask, status: "executing" })
          const writerResult = yield* handleSubtask({
            task: writerTask,
            model: finalModel,
            lastUser: finalUserMsg.info,
            sessionID,
            session,
            msgs: latestMsgs,
          })
          yield* setSchedulerTodoStatus({
            task: writerTask,
            status: writerResult ? "completed" : "failed",
          })
          writerRan = true
        }

        yield* compaction.prune({ sessionID }).pipe(Effect.ignore, Effect.forkIn(scope))
        return yield* lastAssistant(sessionID)
      },
    )

    const runLoop: (sessionID: SessionID) => Effect.Effect<MessageV2.WithParts> = (sessionID) =>
      runLoopUnsafe(sessionID).pipe(Effect.orDie)

    const loop: (input: LoopInput) => Effect.Effect<MessageV2.WithParts> = Effect.fn("SessionPrompt.loop")(function* (
      input: LoopInput,
    ) {
      return yield* state.ensureRunning(input.sessionID, lastAssistant(input.sessionID), runLoop(input.sessionID))
    })

    const shell: (input: ShellInput) => Effect.Effect<MessageV2.WithParts> = Effect.fn("SessionPrompt.shell")(
      function* (input: ShellInput) {
        const ready = yield* Latch.make()
        return yield* state.startShell(input.sessionID, lastAssistant(input.sessionID), shellImpl(input, ready), ready)
      },
    )

    const command = Effect.fn("SessionPrompt.command")(function* (input: CommandInput) {
      yield* elog.info("command", { sessionID: input.sessionID, command: input.command, agent: input.agent })
      const cmd = yield* commands.get(input.command)
      if (!cmd) {
        const available = (yield* commands.list()).map((c) => c.name)
        const hint = available.length ? ` Available commands: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Command not found: "${input.command}".${hint}` })
        yield* bus.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }
      const agentName = cmd.agent ?? input.agent ?? (yield* agents.defaultAgent())

      const raw = input.arguments.match(argsRegex) ?? []
      const args = raw.map((arg) => arg.replace(quoteTrimRegex, ""))
      const templateCommand = yield* Effect.promise(async () => cmd.template)

      const placeholders = templateCommand.match(placeholderRegex) ?? []
      let last = 0
      for (const item of placeholders) {
        const value = Number(item.slice(1))
        if (value > last) last = value
      }

      const withArgs = templateCommand.replaceAll(placeholderRegex, (_, index) => {
        const position = Number(index)
        const argIndex = position - 1
        if (argIndex >= args.length) return ""
        if (position === last) return args.slice(argIndex).join(" ")
        return args[argIndex]
      })
      const usesArgumentsPlaceholder = templateCommand.includes("$ARGUMENTS")
      let template = withArgs.replaceAll("$ARGUMENTS", input.arguments)

      if (placeholders.length === 0 && !usesArgumentsPlaceholder && input.arguments.trim()) {
        template = template + "\n\n" + input.arguments
      }

      const shellMatches = ConfigMarkdown.shell(template)
      if (shellMatches.length > 0) {
        const cfg = yield* config.get()
        const sh = Shell.preferred(cfg.shell)
        const results = yield* Effect.promise(() =>
          Promise.all(
            shellMatches.map(async ([, cmd]) => (await Process.text([cmd], { shell: sh, nothrow: true })).text),
          ),
        )
        let index = 0
        template = template.replace(bashRegex, () => results[index++])
      }
      template = template.trim()

      const taskModel = yield* Effect.gen(function* () {
        if (cmd.model) return Provider.parseModel(cmd.model)
        if (cmd.agent) {
          const cmdAgent = yield* agents.get(cmd.agent)
          if (cmdAgent?.model) return cmdAgent.model
        }
        if (input.model) return Provider.parseModel(input.model)
        return yield* currentModel(input.sessionID)
      })

      yield* getModel(taskModel.providerID, taskModel.modelID, input.sessionID)

      const agent = yield* agents.get(agentName)
      if (!agent) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
        yield* bus.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }

      const templateParts = yield* resolvePromptParts(template)
      const isSubtask = (agent.mode === "subagent" && cmd.subtask !== false) || cmd.subtask === true
      const taskRole = roleForAgent(agent.name) ?? "coder"
      const parts = isSubtask
        ? [
            {
              type: "subtask" as const,
              task_role: taskRole,
              agent: agent.name,
              description: cmd.description ?? "",
              command: input.command,
              model: { providerID: taskModel.providerID, modelID: taskModel.modelID },
              prompt: templateParts.find((y) => y.type === "text")?.text ?? "",
            },
          ]
        : [...templateParts, ...(input.parts ?? [])]

      const userAgent = isSubtask ? (input.agent ?? (yield* agents.defaultAgent())) : agentName
      const userModel = isSubtask
        ? input.model
          ? Provider.parseModel(input.model)
          : yield* currentModel(input.sessionID)
        : taskModel

      yield* plugin.trigger(
        "command.execute.before",
        { command: input.command, sessionID: input.sessionID, arguments: input.arguments },
        { parts },
      )

      const result = yield* prompt({
        sessionID: input.sessionID,
        messageID: input.messageID,
        model: userModel,
        agent: userAgent,
        parts,
        variant: input.variant,
      })
      yield* bus.publish(Command.Event.Executed, {
        name: input.command,
        sessionID: input.sessionID,
        arguments: input.arguments,
        messageID: result.info.id,
      })
      return result
    })

    return Service.of({
      cancel,
      prompt,
      loop,
      shell,
      command,
      resolvePromptParts,
    })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mergeAll(
          SessionRunState.defaultLayer,
          SessionStatus.defaultLayer,
          SessionCompaction.defaultLayer,
          SessionProcessor.defaultLayer,
          Command.defaultLayer,
          Permission.defaultLayer,
          Question.defaultLayer,
          Todo.defaultLayer,
          SessionClosedLoop.defaultLayer,
          MCP.defaultLayer,
          LSP.defaultLayer,
          ToolRegistry.defaultLayer,
          Truncate.defaultLayer,
          Provider.defaultLayer,
          Config.defaultLayer,
          Instruction.defaultLayer,
          AppFileSystem.defaultLayer,
          Plugin.defaultLayer,
          Session.defaultLayer,
          SessionRevert.defaultLayer,
          SessionSummary.defaultLayer,
        ),
        Layer.mergeAll(
          Agent.defaultLayer,
          SystemPrompt.defaultLayer,
          LLM.defaultLayer,
          Bus.layer,
          CrossSpawnSpawner.defaultLayer,
          SyncEvent.defaultLayer,
        ),
      ),
    ),
  ),
)
const ModelRef = Schema.Struct({
  providerID: ProviderID,
  modelID: ModelID,
})

export const PromptInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
  model: Schema.optional(ModelRef),
  agent: Schema.optional(Schema.String),
  noReply: Schema.optional(Schema.Boolean),
  tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)).annotate({
    description:
      "@deprecated tools and permissions have been merged, you can set permissions on the session itself now",
  }),
  format: Schema.optional(MessageV2.Format),
  system: Schema.optional(Schema.String),
  variant: Schema.optional(Schema.String),
  parts: Schema.Array(
    Schema.Union([
      MessageV2.TextPartInput,
      MessageV2.FilePartInput,
      MessageV2.AgentPartInput,
      MessageV2.SubtaskPartInput,
    ]).annotate({ discriminator: "type" }),
  ),
}).pipe(withStatics((s) => ({ zod: zod(s) })))
export type PromptInput = Schema.Schema.Type<typeof PromptInput>

export class LoopInput extends Schema.Class<LoopInput>("SessionPrompt.LoopInput")({
  sessionID: SessionID,
}) {
  static readonly zod = zod(this)
}

export const ShellInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
  agent: Schema.String,
  model: Schema.optional(ModelRef),
  command: Schema.String,
}).pipe(withStatics((s) => ({ zod: zod(s) })))
export type ShellInput = Schema.Schema.Type<typeof ShellInput>

export const CommandInput = Schema.Struct({
  messageID: Schema.optional(MessageID),
  sessionID: SessionID,
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  arguments: Schema.String,
  command: Schema.String,
  variant: Schema.optional(Schema.String),
  // Inlined (no identifier annotation) to keep the original SDK output — the
  // PromptInput call site below references FilePartInput by ref via the
  // Schema export in message-v2.ts.
  parts: Schema.optional(
    Schema.Array(
      Schema.Union([
        Schema.Struct({
          id: Schema.optional(PartID),
          type: Schema.Literal("file"),
          mime: Schema.String,
          filename: Schema.optional(Schema.String),
          url: Schema.String,
          source: Schema.optional(MessageV2.FilePartSource),
        }),
      ]).annotate({ discriminator: "type" }),
    ),
  ),
}).pipe(withStatics((s) => ({ zod: zod(s) })))
export type CommandInput = Schema.Schema.Type<typeof CommandInput>

/** @internal Exported for testing */
export function createStructuredOutputTool(input: {
  schema: Record<string, any>
  onSuccess: (output: unknown) => void
}): AITool {
  // Remove $schema property if present (not needed for tool input)
  const { $schema: _, ...toolSchema } = input.schema

  return tool({
    description: STRUCTURED_OUTPUT_DESCRIPTION,
    inputSchema: jsonSchema(toolSchema as JSONSchema7),
    async execute(args) {
      // AI SDK validates args against inputSchema before calling execute()
      input.onSuccess(args)
      return {
        output: "Structured output captured successfully.",
        title: "Structured Output",
        metadata: { valid: true },
      }
    },
    toModelOutput({ output }) {
      return {
        type: "text",
        value: output.output,
      }
    },
  })
}
const bashRegex = /!`([^`]+)`/g
// Match [Image N] as single token, quoted strings, or non-space sequences
const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
const placeholderRegex = /\$(\d+)/g
const quoteTrimRegex = /^["']|["']$/g

export * as SessionPrompt from "./prompt"
