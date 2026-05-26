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
import * as LanguageRule from "./language-rule"
import * as SessionClosedLoop from "@/session/closed-loop"
import * as LessonSchema from "@/session/lesson-schema"
import {
  createPathContext,
  ensureAbsolutePathList,
  extractRequiredPaths,
  pathContextFromTrajectory,
  renderPathContextBlock,
  resolveActualOutputPathsFromText,
  resolveFallbackPaths,
  toAbsolutePath,
  toHomeLabel,
  isPathInsideRoot,
  absoluteSearchRootsFromOutputs,
  type PathContext,
} from "@/session/path-context"
import {
  createTrajectoryRecord,
  extractTrajectoryEvidenceFromSubtask,
  filterTrajectoryByRun,
  formatTrajectoryEvidenceForWriter,
  sanitizeArtifactPathsForCurrentRun,
} from "@/session/trajectory"
import { deriveLessonProposalsFromTrajectory, formatLessonProposalsForWriter } from "@/session/lesson-proposal"
import { deriveReplanProposalFromFailure, formatReplanProposalForPrompt } from "@/session/replan"
import {
  applyTaskGraphPatch,
  collectRepairSubtree,
  deriveTaskGraphPatchFromReplanProposal,
  type TaskGraph as ReplanTaskGraph,
  type TaskGraphNode as ReplanTaskGraphNode,
  validateTaskGraphPatch,
} from "@/session/taskgraph-patch"
import {
  type PatternRecord,
  buildPatternRecordsFromLessons,
  formatPatternsForPrompt,
  searchRelevantPatternsFromMemoryIndex,
  searchRelevantPatterns,
} from "@/session/pattern-retrieval"
import { createAgentMemoryIndex } from "@/session/agent-memory-config"
import { syncProjectMemorySources } from "@/session/agent-memory-sync"
import {
  asProviderRouteAgent,
  providerRouteDecisionMetadata,
  resolveProviderRoute,
  type ProviderRouteDecision,
} from "@/provider/provider-routing"
import { getDefaultProviderHealthStore } from "@/provider/provider-health"
import { resolveProviderTelemetryStore } from "@/provider/provider-telemetry"
import { MemoryRuntime } from "@/memory/runtime"
import * as DateTime from "effect/DateTime"
import { eq } from "@/storage/db"
import * as Database from "@/storage/db"
import { SessionTable } from "./session.sql"
import {
  applySandboxOutputs,
  cleanupWorktree,
  createRunWorktree,
  mapTargetPathToSandbox,
  type ApplyResult,
  type WorktreeContext,
} from "@/session/worktree-apply"

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

type AdaptiveReplanConfig = {
  enabled: boolean
  minConfidence: number
  maxPatchNodes: number
  requireTesterAfterRepair: boolean
}

const DEFAULT_ADAPTIVE_REPLAN_CONFIG: AdaptiveReplanConfig = {
  enabled: false,
  minConfidence: 0.7,
  maxPatchNodes: 12,
  requireTesterAfterRepair: true,
}

function resolveAdaptiveReplanConfig(input: unknown): AdaptiveReplanConfig {
  if (!input || typeof input !== "object") return { ...DEFAULT_ADAPTIVE_REPLAN_CONFIG }
  const source = input as Record<string, unknown>
  const minConfidenceRaw = typeof source.minConfidence === "number" && Number.isFinite(source.minConfidence)
    ? source.minConfidence
    : DEFAULT_ADAPTIVE_REPLAN_CONFIG.minConfidence
  const maxPatchNodesRaw =
    typeof source.maxPatchNodes === "number" && Number.isFinite(source.maxPatchNodes)
      ? Math.max(1, Math.floor(source.maxPatchNodes))
      : DEFAULT_ADAPTIVE_REPLAN_CONFIG.maxPatchNodes
  return {
    enabled: source.enabled === true,
    minConfidence: Math.max(0, Math.min(1, minConfidenceRaw)),
    maxPatchNodes: maxPatchNodesRaw,
    requireTesterAfterRepair:
      typeof source.requireTesterAfterRepair === "boolean"
        ? source.requireTesterAfterRepair
        : DEFAULT_ADAPTIVE_REPLAN_CONFIG.requireTesterAfterRepair,
  }
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

function legacyRoleForAgent(agent: string): MessageV2.TaskRole | undefined {
  if (agent === "general") return "coder"
  if (agent === "explore") return "planner"
  if (agent === "scout") return "research"
}

function isTaskRole(value: unknown): value is MessageV2.TaskRole {
  if (typeof value !== "string") return false
  return ["planner", "coder", "tester", "research", "reviewer", "writer"].includes(value)
}

const userTextFromParts = (parts: MessageV2.Part[]) =>
  parts
    .flatMap((part) => {
      if (part.type !== "text") return []
      if (part.synthetic || part.ignored) return []
      const trimmed = part.text.trim()
      if (!trimmed) return []
      return [trimmed]
    })
    .join("\n")

function getLatestUserMessage(messages: MessageV2.WithParts[]) {
  return messages
    .slice()
    .reverse()
    .find((message): message is MessageV2.WithParts & { info: MessageV2.User } => message.info.role === "user")
}

function getCurrentUserRequest(messages: MessageV2.WithParts[], lastUserID: MessageID) {
  const exact = messages.find(
    (message): message is MessageV2.WithParts & { info: MessageV2.User } =>
      message.info.role === "user" && message.info.id === lastUserID,
  )
  const exactText = exact ? userTextFromParts(exact.parts).trim() : ""
  if (exact && exactText) return { message: exact, text: exactText }
  const latestNonEmpty = messages
    .slice()
    .reverse()
    .find(
      (message): message is MessageV2.WithParts & { info: MessageV2.User } =>
        message.info.role === "user" && userTextFromParts(message.parts).trim().length > 0,
    )
  if (latestNonEmpty) return { message: latestNonEmpty, text: userTextFromParts(latestNonEmpty.parts).trim() }
  if (exact) return { message: exact, text: exactText }
}

function intentAnchorHash(input: string) {
  const text = input.replace(/\s+/g, " ").trim()
  if (!text) return "ia:empty"
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `ia:${(hash >>> 0).toString(16)}`
}

const languageRuleFromStoredMessage = (message: MessageV2.WithParts) => {
  if (message.info.role !== "user") return
  const explicit = LanguageRule.extractLanguageRule(message.info.system)
  if (explicit) return explicit
  const text = userTextFromParts(message.parts)
  if (!text) return
  return LanguageRule.detectLanguageRuleFromText(text)
}

const activeLanguageRuleFromMessages = (messages: MessageV2.WithParts[]) => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message) continue
    const rule = languageRuleFromStoredMessage(message)
    if (rule) return rule
  }
}

const INTERNAL_FAILURE_MARKERS = [
  "[wrong_path]",
  "[stale_artifact]",
  "[tool_unavailable]",
  "[tool_schema_error]",
  "[tool_call_invalid]",
  "[file_write_verification_failed]",
  "wrong_path",
  "stale_artifact",
  "tool_unavailable",
  "tool_schema_error",
  "tool_call_invalid",
  "file_write_verification_failed",
  "unknown tool",
  "invalid tool",
  "schemaerror",
  "missing key at",
  "runtime guard",
  "guard",
  "policy",
  "src/tool/task.ts",
]

function sanitizeInternalFailureForKnowledge(input: string | undefined) {
  const text = (input ?? "").trim()
  if (!text) return ""
  const lower = text.toLowerCase()
  const containsMarker = INTERNAL_FAILURE_MARKERS.some((marker) => lower.includes(marker))
  const stackLike = /\bat\s+\S+:\d+:\d+\b/.test(text)
  if (lower.includes("tool_unavailable")) {
    return "shell tool temporarily unavailable during execution"
  }
  if (lower.includes("tool_schema_error")) {
    return "file write/edit tool schema validation failed during execution"
  }
  if (lower.includes("tool_call_invalid") || lower.includes("unknown tool") || lower.includes("invalid tool")) {
    return "invalid tool call was generated during execution"
  }
  if (lower.includes("file_write_verification_failed")) {
    return "file write/edit readback verification failed during execution"
  }
  if (lower.includes("wrong_path") || lower.includes("stale_artifact")) {
    return "subtask failed to produce artifacts at the required location"
  }
  if (containsMarker || stackLike) {
    return "internal execution check stopped this attempt"
  }
  return text
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

type TaskExecutionIntent = {
  requiresImplementation: boolean
  allowsTesterOnly: boolean
  researchOnly: boolean
  preferParallelCoders: boolean
  smallSingleChange: boolean
}

const SCHEDULER_CODER_MAX_CONCURRENCY = 5
const SCHEDULER_TESTER_MAX_CONCURRENCY = 2
const SCHEDULER_REVIEWER_MAX_CONCURRENCY = 1
const REVIEWER_BATCH_MAX_CODER_OUTPUTS = 3
const PLANNER_GRAPH_MAX_RETRIES = 2
const RESEARCH_BLOCKING_PATTERNS = [
  /\bidentify\b/,
  /\bfind\b/,
  /\blocate\b/,
  /\bdiscover\b/,
  /\bdetermine\b/,
  /\binvestigate\b/,
  /\bcheck\b/,
  /\bwhich file\b/,
  /定位/,
  /识别/,
  /查找/,
  /找到/,
  /确定/,
  /调研/,
  /调查/,
  /核对/,
  /确认/,
  /排查/,
]
const CODER_RESEARCH_DEPENDENCY_PATTERNS = [
  /\bfix the identified\b/,
  /\bfix identified\b/,
  /\bidentified\b/,
  /\bfound\b/,
  /\blocated\b/,
  /\bdiscovered\b/,
  /\bdetermined\b/,
  /\bbased on findings\b/,
  /\bbased on research\b/,
  /\buse findings\b/,
  /\buse the findings\b/,
  /\buse research result\b/,
  /\buse the research result\b/,
  /\bafter locating\b/,
  /\bafter finding\b/,
  /\bafter confirming\b/,
  /\bafter identify\b/,
  /\bafter identifying\b/,
  /\bafter determine\b/,
  /\bafter determining\b/,
  /\bafter investigate\b/,
  /基于研究/,
  /基于结论/,
  /根据研究/,
  /根据发现/,
  /修复已识别/,
  /修复发现的问题/,
  /定位后修复/,
  /确认后修复/,
]
const OPERATION_STEP_PATTERNS = [
  /\bprepare\b/,
  /\bcreate (?:directory|dir)\b/,
  /\bmkdir\b/,
  /\bgenerate key\b/,
  /\bgenerate file\b/,
  /\bcreate file\b/,
  /\bmerge\b/,
  /\bcombine\b/,
  /\bchmod\b/,
  /\bset permission\b/,
  /\bwrite metadata\b/,
  /\bwrite verification file\b/,
  /\bread\b/,
  /\bcopy\b/,
  /\bmove\b/,
  /\brename\b/,
  /\bformat\b/,
  /\brun command\b/,
  /创建目录/,
  /生成密钥/,
  /生成文件/,
  /创建文件/,
  /合并/,
  /设置权限/,
  /写入元数据/,
  /写入验证文件/,
  /读取/,
  /复制/,
  /移动/,
  /重命名/,
  /格式化/,
  /运行命令/,
]
const WORK_PACKAGE_SIGNAL_PATTERNS = [
  /\bimplement\b/,
  /\bfeature\b/,
  /\bmodule\b/,
  /\bartifact\b/,
  /\bfamily\b/,
  /\badapter\b/,
  /\bwrapper\b/,
  /\bintegration\b/,
  /\bschema\b/,
  /\bconfig\b/,
  /\bmiddleware\b/,
  /\blibrary\b/,
  /\bapi\b/,
  /\bbackend\b/,
  /\bfrontend\b/,
  /\bparser\b/,
  /\bcommand\b/,
  /\bscript\b/,
  /\bmigration\b/,
  /\bdocs?\b/,
  /\breadme\b/,
  /实现/,
  /模块/,
  /适配/,
  /封装/,
  /集成/,
  /配置/,
  /脚本/,
  /迁移/,
]
const VERIFICATION_AS_CODER_PATTERNS = [
  /\bverify all requirements\b/,
  /\bverify requirements\b/,
  /\bverify all outputs\b/,
  /\bvalidate all outputs\b/,
  /\bfinal verification\b/,
  /\bfinal acceptance\b/,
  /\brequirement verification\b/,
  /\bacceptance review\b/,
  /\bacceptance\b/,
  /验证所有需求/,
  /验证所有输出/,
  /最终验证/,
  /最终验收/,
  /验收/,
]
const ARTIFACT_FAMILY_PATTERNS = [
  { key: "verification_script", patterns: [/\bverification script\b/, /\bcheck[_-]?cert\b/, /\bprobe script\b/, /\bverify script\b/] },
  { key: "certificate", patterns: [/\b(cert|certificate|key|pem|tls|ssl|openssl)\b/] },
  { key: "config_schema", patterns: [/\b(config|schema|env|settings|defaults?|option|manifest)\b/] },
  { key: "cli", patterns: [/\b(cli|command|parser|args?|flags?|help|subcommand)\b/] },
  { key: "database_migration", patterns: [/\b(migration|sql|seed|database|db)\b/] },
  { key: "backend_api", patterns: [/\b(backend|server|api|endpoint|handler|controller)\b/] },
  { key: "frontend_ui", patterns: [/\b(frontend|ui|react|view|component|page)\b/] },
  { key: "core_library", patterns: [/\b(core|library|engine|domain)\b/] },
  { key: "adapter_wrapper", patterns: [/\b(adapter|wrapper|bridge|shim|facade)\b/] },
  { key: "docs", patterns: [/\b(docs?|readme|example|guide|tutorial)\b/] },
] as const
const ROLE_BOUNDARY_IMPL_SIGNAL_PATTERNS = [
  /\bimplement\b/,
  /\badd\b/,
  /\bbuild\b/,
  /\bcreate\b/,
  /\bupdate\b/,
  /\bwrite\b/,
  /\bfix\b/,
  /\brefactor\b/,
  /\bintegrate\b/,
  /\bwire\b/,
  /实现/,
  /新增/,
  /修复/,
  /更新/,
]
const STEP_VERB_PATTERNS = [
  /\bprepare\b/,
  /\bcreate\b/,
  /\bgenerate\b/,
  /\bmerge\b/,
  /\bcombine\b/,
  /\bwrite\b/,
  /\bupdate\b/,
  /\badd\b/,
  /\bimplement\b/,
  /\bwire\b/,
  /\bchmod\b/,
  /\bset permission\b/,
  /\bread\b/,
  /\bcopy\b/,
  /\bmove\b/,
  /\brename\b/,
  /\bformat\b/,
  /\brun\b/,
  /准备/,
  /创建/,
  /生成/,
  /合并/,
  /写入/,
  /更新/,
  /新增/,
  /实现/,
  /设置权限/,
  /读取/,
  /复制/,
  /移动/,
  /重命名/,
  /格式化/,
  /运行/,
]
const WORK_PACKAGE_BOUNDARY_GROUPS = [
  { key: "core", patterns: [/\b(core|library|engine|domain)\b/] },
  { key: "adapter", patterns: [/\b(adapter|wrapper|bridge|shim|facade)\b/] },
  { key: "schema", patterns: [/\b(schema|contract|types?)\b/] },
  { key: "integration", patterns: [/\b(integration|integrate|wiring|wire|client|service)\b/] },
  { key: "backend", patterns: [/\b(backend|api|endpoint|controller|handler|server)\b/] },
  { key: "frontend", patterns: [/\b(frontend|ui|view|component|page)\b/] },
] as const

type TaskGraphCandidate = {
  nodes: Record<string, unknown>[]
}

type ParsedTaskGraph =
  | {
      ok: true
      graph: TaskGraphCandidate
      repaired: boolean
    }
  | {
      ok: false
      reason: string
      repaired: boolean
    }

type NormalizedTaskGraph =
  | {
      ok: true
      graph: SessionClosedLoop.TaskGraph
      warnings: string[]
    }
  | {
      ok: false
      reason: string
      warnings: string[]
    }

type EnqueueTaskGraphResult =
  | {
      accepted: true
      enqueued: number
      warnings: string[]
    }
  | {
      accepted: false
      reason: string
      warnings: string[]
    }

function schedulerTodoStatus(status: SchedulerTodoStatus) {
  if (status === "executing") return "in_progress"
  if (status === "failed") return "cancelled"
  return status
}

function squashCauseSafe(cause: Cause.Cause<unknown>, label: string) {
  try {
    const squashed = Cause.squash(cause)
    if (squashed instanceof Error) return squashed
    return new Error(`${label}: ${String(squashed)}`)
  } catch (error) {
    const firstDie = Cause.findDie(cause)
    const firstFail = Cause.findFail(cause)
    const dieDetail = firstDie._tag === "Success" ? ` first_defect=${JSON.stringify(firstDie)}` : ""
    const failDetail = firstFail._tag === "Success" ? ` first_fail=${JSON.stringify(firstFail)}` : ""
    return new Error(
      `${label}: unable to squash cause (${error instanceof Error ? error.message : String(error)}).${dieDetail}${failDetail}`,
    )
  }
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
      yield* closedLoop.cancelRun({ sessionID }).pipe(Effect.orElseSucceed(() => undefined))
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
        .pipe(Effect.catchCause((cause) => elog.error("failed to generate title", { error: squashCauseSafe(cause, "title generation failed") })))
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

    type SubtaskFailureCategory =
      | "tool_unavailable"
      | "wrong_path"
      | "stale_artifact"
      | "tool_schema_error"
      | "tool_call_invalid"
      | "file_write_verification_failed"
      | "unknown"
    type StructuredFailureSignal = {
      category: Exclude<SubtaskFailureCategory, "unknown">
      required_paths: string[]
      fallback_paths: string[]
      allowed_fallback_paths: string[]
      actual_output_paths: string[]
      forbidden_paths_seen: string[]
      repair_instruction: string
      tool_name?: string
      error_category?: string
      missing_field?: string
      file_path?: string
      expected_fragment?: string
      readback_fragment?: string
      reason?: string
    }
    type SubtaskFailureInfo = {
      category: SubtaskFailureCategory
      reason: string
      structured?: StructuredFailureSignal
      displayMessage: string
    }
    type ReviewerDecision = {
      passed: boolean
      notes?: string
      task_graph?: TaskGraphCandidate
      failure_signal?: string
      user_message?: string
    }
    type TesterDecision = {
      passed: boolean
      category?: "stale_test_evidence" | "tester_failed" | "unknown"
      failure_signal?: string
      user_message?: string
      forbidden_paths_seen?: string[]
    }
    const subtaskFailureInfo = new Map<string, SubtaskFailureInfo>()
    const reviewerDecisionInfo = new Map<string, ReviewerDecision>()
    const testerDecisionInfo = new Map<string, TesterDecision>()
    const RECOVERABLE_FAILURE_MESSAGES = {
      wrongPath: "检测到产物路径不符合要求，正在自动修正。",
      toolFormat: "检测到工具调用格式不符合要求，正在调整后重试。",
      fileWriteVerification: "检测到文件写入结果不符合预期，正在重新处理。",
      missingOutputEvidence: "当前步骤还没有产生可验证结果，正在重新执行。",
      reviewFailed: "审查发现结果仍有不一致之处，正在返回实现阶段修复。",
      searchScopeForbidden: "检测到搜索范围过大，正在改用当前任务产物路径验证。",
      default: "检测到当前步骤结果不符合要求，正在自动调整并重试。",
    } as const
    const TERMINAL_FAILURE_PREFIX = "任务无法继续，需要处理："
    const normalizeFailureReason = (reason: string) => reason.replace(/^Error:\s*/i, "").trim()
    const isToolUnavailableReason = (reason: string) => {
      const lower = normalizeFailureReason(reason).toLowerCase()
      return (
        lower.includes("tool_unavailable") ||
        lower.includes("tree-sitter") ||
        lower.includes("bash preflight") ||
        lower.includes("shell tool")
      )
    }
    const inferRecoverableMessageFromReason = (reason: string) => {
      const lower = normalizeFailureReason(reason).toLowerCase()
      if (!lower) return
      if (
        lower.includes("[wrong_path]") ||
        lower.includes("[stale_artifact]") ||
        lower.includes("wrong_path") ||
        lower.includes("stale_artifact")
      ) {
        return RECOVERABLE_FAILURE_MESSAGES.wrongPath
      }
      if (
        lower.includes("[tool_call_invalid]") ||
        lower.includes("[tool_schema_error]") ||
        lower.includes("tool_call_invalid") ||
        lower.includes("tool_schema_error") ||
        lower.includes("schemaerror") ||
        lower.includes("missing key at") ||
        lower.includes("unknown tool") ||
        lower.includes("invalid tool")
      ) {
        return RECOVERABLE_FAILURE_MESSAGES.toolFormat
      }
      if (lower.includes("[file_write_verification_failed]") || lower.includes("file_write_verification_failed")) {
        return RECOVERABLE_FAILURE_MESSAGES.fileWriteVerification
      }
      if (lower.includes("missing_actual_output_evidence") || lower.includes("no_tool_evidence")) {
        return RECOVERABLE_FAILURE_MESSAGES.missingOutputEvidence
      }
      if (lower.includes("review_failed") || lower.includes("review_mismatch")) {
        return RECOVERABLE_FAILURE_MESSAGES.reviewFailed
      }
      if (lower.includes("search_scope_forbidden")) {
        return RECOVERABLE_FAILURE_MESSAGES.searchScopeForbidden
      }
      return
    }
    const sanitizeFailureReasonForTerminalDisplay = (reason: string) => {
      const normalized = normalizeFailureReason(reason)
      if (!normalized) return ""
      const collapsed = normalized.replace(/\s+/g, " ")
      const looksInternal =
        collapsed.toLowerCase().includes("guard") ||
        collapsed.toLowerCase().includes("replan") ||
        collapsed.toLowerCase().includes("taskgraphpatch") ||
        collapsed.toLowerCase().includes("stack") ||
        collapsed.toLowerCase().includes("prompt.ts") ||
        collapsed.toLowerCase().includes("json category") ||
        collapsed.toLowerCase().includes("src/tool/task.ts") ||
        /\bat\s+\S+:\d+:\d+\b/.test(collapsed)
      if (looksInternal) return ""
      const hiddenFragments = [
        /\[[a-z0-9_:-]+\]/gi,
        /src\/[^\s]+/gi,
        /stack\s*trace/gi,
        /prompt\.ts/gi,
        /taskgraphpatch/gi,
        /json\s*category/gi,
      ]
      const sanitized = hiddenFragments
        .reduce((text, pattern) => text.replace(pattern, " "), collapsed)
        .replace(/\s+/g, " ")
        .replace(/[。.!?]+$/u, "")
        .trim()
      return sanitized
    }
    const toUserFacingFailureMessage = (input: {
      category: SubtaskFailureCategory
      reason: string
    }) => {
      if (input.category === "tool_unavailable") {
        return `${TERMINAL_FAILURE_PREFIX}当前 shell 工具暂不可用，请检查环境后重试。`
      }
      if (input.category === "tool_schema_error") {
        return RECOVERABLE_FAILURE_MESSAGES.toolFormat
      }
      if (input.category === "tool_call_invalid") {
        return RECOVERABLE_FAILURE_MESSAGES.toolFormat
      }
      if (input.category === "file_write_verification_failed") {
        return RECOVERABLE_FAILURE_MESSAGES.fileWriteVerification
      }
      if (input.category === "wrong_path" || input.category === "stale_artifact") {
        return RECOVERABLE_FAILURE_MESSAGES.wrongPath
      }
      if (isToolUnavailableReason(input.reason)) {
        return `${TERMINAL_FAILURE_PREFIX}当前 shell 工具暂不可用，请检查环境后重试。`
      }
      const recoverable = inferRecoverableMessageFromReason(input.reason)
      if (recoverable) return recoverable
      const terminalReason = sanitizeFailureReasonForTerminalDisplay(input.reason)
      if (terminalReason) return `${TERMINAL_FAILURE_PREFIX}${terminalReason}。`
      return RECOVERABLE_FAILURE_MESSAGES.default
    }
    const detectToolSchemaFailureFromReason = (reason: string): StructuredFailureSignal | undefined => {
      const normalized = reason.trim()
      if (!normalized) return
      const lower = normalized.toLowerCase()
      const missingKeyMatch = normalized.match(/Missing key at \[\s*["']?([A-Za-z0-9_.-]+)["']?\s*\]/i)
      const missingField = missingKeyMatch?.[1] ?? (lower.includes("filepath") ? "filePath" : undefined)
      if (!missingField) return
      const schemaLike =
        lower.includes("schemaerror") || lower.includes("invalid arguments") || lower.includes("missing key at")
      if (!schemaLike) return
      const toolName =
        /\bwrite\b/i.test(normalized) ? "write" : /\bedit\b/i.test(normalized) ? "edit" : "write"
      return {
        category: "tool_schema_error",
        required_paths: [],
        fallback_paths: [],
        allowed_fallback_paths: [],
        actual_output_paths: [],
        forbidden_paths_seen: [],
        tool_name: toolName,
        error_category: "tool_schema_error",
        missing_field: missingField,
        repair_instruction:
          "use correct write tool schema or fallback to shell redirection only if allowed (and only within allowed paths)",
        reason: normalized,
      }
    }
    const detectToolCallInvalidFailureFromReason = (reason: string): StructuredFailureSignal | undefined => {
      const normalized = reason.trim()
      if (!normalized) return
      const unknownTool = normalized.match(/\bunknown tool\b[:\s]+(.+)$/i)?.[1]?.trim()
      const toolName = unknownTool || (/\binvalid tool\b/i.test(normalized) ? "unknown" : "")
      if (!toolName) return
      const shellLike = /\s/.test(toolName) || /[|&;<>`$()]/.test(toolName)
      return {
        category: "tool_call_invalid",
        required_paths: [],
        fallback_paths: [],
        allowed_fallback_paths: [],
        actual_output_paths: [],
        forbidden_paths_seen: [],
        tool_name: toolName,
        error_category: "unknown_tool",
        repair_instruction: shellLike ? "use bash tool for shell commands" : "use only registered tools",
        reason: normalized,
      }
    }
    const detectFileWriteVerificationFailureFromReason = (reason: string): StructuredFailureSignal | undefined => {
      const normalized = reason.trim()
      if (!normalized) return
      if (!normalized.toLowerCase().includes("file_write_verification_failed")) return
      return {
        category: "file_write_verification_failed",
        required_paths: [],
        fallback_paths: [],
        allowed_fallback_paths: [],
        actual_output_paths: [],
        forbidden_paths_seen: [],
        repair_instruction: "retry write/edit and verify file content with readback",
        reason: normalized,
      }
    }
    const sanitizeInternalFailureForDisplay = (error: unknown) => {
      const rawReason = error instanceof Error ? error.message : String(error ?? "subtask execution failed")
      if (rawReason.startsWith("[tool_unavailable]")) {
        return {
          displayMessage: toUserFacingFailureMessage({ category: "tool_unavailable", reason: rawReason }),
          internalCategory: "tool_unavailable" as const,
          internalReason: rawReason,
        }
      }
      if (rawReason.startsWith("[wrong_path]")) {
        const structured = parseStructuredFailureSignal("wrong_path", rawReason)
        const internalReason = structured?.reason ?? rawReason
        return {
          displayMessage: toUserFacingFailureMessage({ category: "wrong_path", reason: internalReason }),
          internalCategory: "wrong_path" as const,
          internalSignal: structured,
          internalReason,
        }
      }
      if (rawReason.startsWith("[stale_artifact]")) {
        const structured = parseStructuredFailureSignal("stale_artifact", rawReason)
        const internalReason = structured?.reason ?? rawReason
        return {
          displayMessage: toUserFacingFailureMessage({ category: "stale_artifact", reason: internalReason }),
          internalCategory: "stale_artifact" as const,
          internalSignal: structured,
          internalReason,
        }
      }
      if (rawReason.startsWith("[tool_schema_error]")) {
        const structured = parseStructuredFailureSignal("tool_schema_error", rawReason)
        const internalReason = structured?.reason ?? rawReason
        return {
          displayMessage: toUserFacingFailureMessage({ category: "tool_schema_error", reason: internalReason }),
          internalCategory: "tool_schema_error" as const,
          internalSignal: structured,
          internalReason,
        }
      }
      if (rawReason.startsWith("[tool_call_invalid]")) {
        const structured = parseStructuredFailureSignal("tool_call_invalid", rawReason)
        const internalReason = structured?.reason ?? rawReason
        return {
          displayMessage: toUserFacingFailureMessage({ category: "tool_call_invalid", reason: internalReason }),
          internalCategory: "tool_call_invalid" as const,
          internalSignal: structured,
          internalReason,
        }
      }
      if (rawReason.startsWith("[file_write_verification_failed]")) {
        const structured = parseStructuredFailureSignal("file_write_verification_failed", rawReason)
        const internalReason = structured?.reason ?? rawReason
        return {
          displayMessage: toUserFacingFailureMessage({
            category: "file_write_verification_failed",
            reason: internalReason,
          }),
          internalCategory: "file_write_verification_failed" as const,
          internalSignal: structured,
          internalReason,
        }
      }
      const inferredStructured = detectToolSchemaFailureFromReason(rawReason)
      if (inferredStructured) {
        const internalReason = inferredStructured.reason ?? rawReason
        return {
          displayMessage: toUserFacingFailureMessage({ category: "tool_schema_error", reason: internalReason }),
          internalCategory: "tool_schema_error" as const,
          internalSignal: inferredStructured,
          internalReason,
        }
      }
      const inferredInvalidTool = detectToolCallInvalidFailureFromReason(rawReason)
      if (inferredInvalidTool) {
        const internalReason = inferredInvalidTool.reason ?? rawReason
        return {
          displayMessage: toUserFacingFailureMessage({ category: "tool_call_invalid", reason: internalReason }),
          internalCategory: "tool_call_invalid" as const,
          internalSignal: inferredInvalidTool,
          internalReason,
        }
      }
      const inferredWriteVerification = detectFileWriteVerificationFailureFromReason(rawReason)
      if (inferredWriteVerification) {
        const internalReason = inferredWriteVerification.reason ?? rawReason
        return {
          displayMessage: toUserFacingFailureMessage({
            category: "file_write_verification_failed",
            reason: internalReason,
          }),
          internalCategory: "file_write_verification_failed" as const,
          internalSignal: inferredWriteVerification,
          internalReason,
        }
      }
      return {
        displayMessage: toUserFacingFailureMessage({ category: "unknown", reason: rawReason }),
        internalCategory: "unknown" as const,
        internalReason: rawReason,
      }
    }
    const parseStructuredFailureSignal = (
      category: Exclude<SubtaskFailureCategory, "unknown">,
      reason: string,
    ): StructuredFailureSignal | undefined => {
      const prefix = `[${category}]`
      if (!reason.startsWith(prefix)) return
      const payloadText = reason.slice(prefix.length).trim()
      if (!payloadText.startsWith("{")) return
      try {
        const parsed = JSON.parse(payloadText) as Record<string, unknown>
        const required_paths = Array.isArray(parsed.required_paths)
          ? parsed.required_paths.filter((item): item is string => typeof item === "string")
          : []
        const fallback_paths = Array.isArray(parsed.fallback_paths)
          ? parsed.fallback_paths.filter((item): item is string => typeof item === "string")
          : []
        const allowed_fallback_paths = Array.isArray(parsed.allowed_fallback_paths)
          ? parsed.allowed_fallback_paths.filter((item): item is string => typeof item === "string")
          : []
        const actual_output_paths = Array.isArray(parsed.actual_output_paths)
          ? parsed.actual_output_paths.filter((item): item is string => typeof item === "string")
          : []
        const forbidden_paths_seen = Array.isArray(parsed.forbidden_paths_seen)
          ? parsed.forbidden_paths_seen.filter((item): item is string => typeof item === "string")
          : []
        const repair_instruction =
          typeof parsed.repair_instruction === "string" && parsed.repair_instruction.trim().length > 0
            ? parsed.repair_instruction
            : category === "tool_schema_error"
              ? "use correct write tool schema or fallback to shell redirection only if allowed (and only within allowed paths)"
              : category === "tool_call_invalid"
                ? "use only registered tools"
                : category === "file_write_verification_failed"
                  ? "retry write/edit and verify file content with readback"
                  : "Retry implementation using only required_paths or runtime-provided absolute fallback_paths; do not reuse stale workspace artifacts."
        const payloadReason =
          typeof parsed.reason === "string" && parsed.reason.trim().length > 0 ? parsed.reason.trim() : undefined
        const tool_name = typeof parsed.tool_name === "string" && parsed.tool_name.trim().length > 0 ? parsed.tool_name.trim() : undefined
        const error_category =
          typeof parsed.error_category === "string" && parsed.error_category.trim().length > 0
            ? parsed.error_category.trim()
            : undefined
        const missing_field =
          typeof parsed.missing_field === "string" && parsed.missing_field.trim().length > 0
            ? parsed.missing_field.trim()
            : undefined
        const file_path =
          typeof parsed.file_path === "string" && parsed.file_path.trim().length > 0 ? parsed.file_path.trim() : undefined
        const expected_fragment =
          typeof parsed.expected_fragment === "string" && parsed.expected_fragment.trim().length > 0
            ? parsed.expected_fragment.trim()
            : undefined
        const readback_fragment =
          typeof parsed.readback_fragment === "string" && parsed.readback_fragment.trim().length > 0
            ? parsed.readback_fragment.trim()
            : undefined
        return {
          category,
          required_paths,
          fallback_paths: fallback_paths.length > 0 ? fallback_paths : allowed_fallback_paths,
          allowed_fallback_paths,
          actual_output_paths,
          forbidden_paths_seen,
          repair_instruction,
          tool_name,
          error_category,
          missing_field,
          file_path,
          expected_fragment,
          readback_fragment,
          reason: payloadReason,
        }
      } catch {
        return
      }
    }
    const classifySubtaskFailure = (error: unknown): SubtaskFailureInfo => {
      const sanitized = sanitizeInternalFailureForDisplay(error)
      if (sanitized.internalCategory === "tool_unavailable") {
        return {
          category: "tool_unavailable",
          reason: sanitized.internalReason,
          displayMessage: sanitized.displayMessage,
        }
      }
      if (sanitized.internalCategory === "wrong_path") {
        return {
          category: "wrong_path",
          reason: sanitized.internalReason,
          structured: sanitized.internalSignal,
          displayMessage: sanitized.displayMessage,
        }
      }
      if (sanitized.internalCategory === "stale_artifact") {
        return {
          category: "stale_artifact",
          reason: sanitized.internalReason,
          structured: sanitized.internalSignal,
          displayMessage: sanitized.displayMessage,
        }
      }
      if (sanitized.internalCategory === "tool_schema_error") {
        return {
          category: "tool_schema_error",
          reason: sanitized.internalReason,
          structured: sanitized.internalSignal,
          displayMessage: sanitized.displayMessage,
        }
      }
      if (sanitized.internalCategory === "tool_call_invalid") {
        return {
          category: "tool_call_invalid",
          reason: sanitized.internalReason,
          structured: sanitized.internalSignal,
          displayMessage: sanitized.displayMessage,
        }
      }
      if (sanitized.internalCategory === "file_write_verification_failed") {
        return {
          category: "file_write_verification_failed",
          reason: sanitized.internalReason,
          structured: sanitized.internalSignal,
          displayMessage: sanitized.displayMessage,
        }
      }
      return {
        category: "unknown",
        reason: sanitized.internalReason,
        displayMessage: sanitized.displayMessage,
      }
    }

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
            error = squashCauseSafe(cause, "subtask execution failed")
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
        subtaskFailureInfo.delete(closedLoop.taskKey(task))
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
        const failure = classifySubtaskFailure(error)
        subtaskFailureInfo.set(closedLoop.taskKey(task), failure)
        yield* sessions.updatePart({
          ...part,
          state: {
            status: "error",
            error: failure.displayMessage,
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
      const err = squashCauseSafe(exit.cause, "prompt stream failed")
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
      const inputText = input.parts
        .flatMap((part) => {
          if (part.type !== "text") return []
          if (part.synthetic || part.ignored) return []
          const trimmed = part.text.trim()
          if (!trimmed) return []
          return [trimmed]
        })
        .join("\n")
      const explicitLanguageRule = LanguageRule.extractLanguageRule(input.system)
      const detectedLanguageRule = explicitLanguageRule ? undefined : LanguageRule.detectLanguageRuleFromText(inputText)
      const previousLanguageRule =
        explicitLanguageRule || detectedLanguageRule
          ? undefined
          : yield* sessions.findMessage(
              input.sessionID,
              (msg) => msg.info.role === "user" && !!languageRuleFromStoredMessage(msg),
            ).pipe(
              Effect.map((found) => {
                if (Option.isNone(found)) return
                return languageRuleFromStoredMessage(found.value)
              }),
            )
      const system = LanguageRule.mergeSystemWithLanguageRule({
        languageRule: explicitLanguageRule ?? detectedLanguageRule ?? previousLanguageRule,
        system: LanguageRule.stripLanguageRule(input.system),
      })

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
        system,
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
              const error = squashCauseSafe(exit.cause, "scheduler dispatch failed")
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
                  const error = squashCauseSafe(exit.cause, "reviewer task failed")
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
                  const error = squashCauseSafe(exit.cause, "reviewer task failed")
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

    type ActiveRunInterruptionAction = "none" | "status" | "pause" | "cancel" | "replan"

    const classifyActiveRunInterruption = (text: string): ActiveRunInterruptionAction => {
      const normalized = text.trim().toLowerCase()
      if (!normalized) return "none"
      const includesAny = (keywords: string[]) => keywords.some((keyword) => normalized.includes(keyword))
      if (
        includesAny([
          "status",
          "progress",
          "进度",
          "状态",
          "现在到哪了",
          "进行到哪",
          "how far",
          "where are we",
          "what's the status",
        ])
      ) {
        return "status"
      }
      if (includesAny(["pause", "hold", "stop for now", "暂停", "先停", "先等等"])) return "pause"
      if (includesAny(["cancel", "abort", "terminate", "取消", "停止执行", "终止"])) return "cancel"
      if (includesAny(["replan", "change requirement", "new requirement", "改需求", "改成", "换个方案"])) return "replan"
      return "none"
    }

    const interruptionReplyText = (input: {
      action: Exclude<ActiveRunInterruptionAction, "none">
      languageCode: string
    }) => {
      const chinese = input.languageCode.startsWith("zh")
      if (input.action === "status") {
        return chinese
          ? "已收到状态查询。我会在不打断当前执行链路的前提下继续推进，并在可汇报节点返回当前进度。"
          : "Status request received. I will continue the active execution flow and report progress at the next safe checkpoint."
      }
      if (input.action === "pause") {
        return chinese
          ? "已收到暂停请求。当前运行将暂停，不再继续执行新的子任务。"
          : "Pause request received. The active run is paused and no new subtasks will be executed."
      }
      return chinese
        ? "已收到取消请求。当前运行已终止；如需继续，请给出新的明确目标。"
        : "Cancel request received. The active run has been stopped. Provide a new explicit goal to continue."
    }

    const classifyTaskExecutionIntent = (text: string): TaskExecutionIntent => {
      const normalized = text.trim()
      if (!normalized)
        return {
          requiresImplementation: false,
          allowsTesterOnly: false,
          researchOnly: false,
          preferParallelCoders: false,
          smallSingleChange: false,
        }
      const lower = normalized.toLowerCase()
      const includesAny = (keywords: string[]) => keywords.some((keyword) => lower.includes(keyword))
      const testOnlyKeywords = [
        "run tests only",
        "tests only",
        "test only",
        "only add tests",
        "only write tests",
        "only verify",
        "verify only",
        "only check",
        "check only",
        "just test",
        "just verify",
        "只写测试",
        "仅测试",
        "只测试",
        "只验证",
        "仅验证",
        "只检查",
        "仅检查",
        "只跑测试",
      ]
      const noCodeChangeKeywords = [
        "do not change code",
        "don't change code",
        "dont change code",
        "without changing code",
        "no code changes",
        "read-only",
        "read only",
        "不要改代码",
        "不改代码",
        "不修改代码",
        "不要修改代码",
      ]
      const researchOnlyKeywords = [
        "research only",
        "investigate only",
        "analysis only",
        "read-only analysis",
        "只调研",
        "仅调研",
        "只研究",
        "仅研究",
      ]
      const implementationRegex = [
        /\bimplement\b/,
        /\bimplementation\b/,
        /\bfix\b/,
        /\brefactor\b/,
        /\bmodify\b/,
        /\bpatch\b/,
        /\bwrite code\b/,
        /\bgenerate code\b/,
        /\badd feature\b/,
        /\bbuild\b/,
        /\bcreate (?:a |an )?(?:function|module|component|endpoint|api|script)\b/,
      ]
      const implementationKeywords = [
        "实现",
        "修复",
        "修改",
        "改代码",
        "写代码",
        "生成功能",
        "重构",
        "编码",
      ]

      const hasTestOnly = includesAny(testOnlyKeywords)
      const hasNoCodeChange = includesAny(noCodeChangeKeywords)
      const hasResearchOnly = includesAny(researchOnlyKeywords)
      const strictImplementation =
        implementationRegex.some((pattern) => pattern.test(lower)) || includesAny(implementationKeywords)
      const broadImplementationKeywords = [
        "create",
        "generate",
        "write",
        "edit",
        "update",
        "build",
        "新增",
        "生成",
        "创建",
        "编写",
      ]
      const broadImplementation = includesAny(broadImplementationKeywords)
      const explicitTesterOnly = hasTestOnly || hasNoCodeChange
      const allowsTesterOnly = explicitTesterOnly && !strictImplementation && !hasResearchOnly
      const researchOnly = hasResearchOnly && !strictImplementation && !explicitTesterOnly
      const hasImplementation = strictImplementation || (!explicitTesterOnly && broadImplementation)
      const smallChangeKeywords = [
        "typo",
        "small change",
        "tiny change",
        "minor fix",
        "single file",
        "one file",
        "one line",
        "single line",
        "single message",
        "fix typo",
        "quick fix",
        "小改动",
        "微小改动",
        "单点",
        "单文件",
        "一行",
        "一个文件",
        "修正错别字",
        "拼写错误",
      ]
      const singleScopeLikely =
        includesAny(smallChangeKeywords) || /\bfix\s+(?:a\s+)?typo\b/.test(lower) || /\b(single|one)\s+(file|line)\b/.test(lower)
      const requiresImplementation = hasImplementation && !allowsTesterOnly && !researchOnly
      return {
        requiresImplementation,
        allowsTesterOnly,
        researchOnly,
        preferParallelCoders: requiresImplementation && !singleScopeLikely,
        smallSingleChange: singleScopeLikely,
      }
    }

    const runDriftCheck = Effect.fn("SessionPrompt.runDriftCheck")(function* (input: {
      sessionID: SessionID
      user: MessageV2.User
      agent: Agent.Info
      model: Provider.Model
      anchor: SessionClosedLoop.SessionIntentAnchor
      explicit_request: string
      task_graph: { task_id: string; task_role: MessageV2.TaskRole; description: string }[]
      completedSubtasks: number
      summaries: string[]
      diffs: { file?: string; additions: number; deletions: number }[]
    }) {
      const prompt = [
        "You are a strict intent-drift detector for coding tasks.",
        "Judge whether execution has drifted away from the original user intent.",
        "Only orchestrator/selfcheck may declare drift.",
        "Do not compare against a narrow coder subtask title only.",
        "Compare against original intent anchor + explicit user request + normalized TaskGraph + completed summaries.",
        "Do NOT treat verification artifacts as drift when they are explicit in request or TaskGraph (for example verification.txt, check_cert.py).",
        "",
        "Return JSON only with this shape:",
        '{\"is_drift\":boolean,\"reason\":string,\"evidence\":string[],\"confidence\":number}',
        "",
        `Original intent anchor: ${input.anchor.text}`,
        `Explicit user request: ${input.explicit_request}`,
        `TaskGraph roles: ${[...new Set(input.task_graph.map((task) => task.task_role))].join(", ") || "none"}`,
        `Completed subtasks count: ${input.completedSubtasks}`,
        "",
        "TaskGraph nodes (role :: description):",
        ...(input.task_graph.length > 0
          ? input.task_graph.map((task) => `- ${task.task_role} :: ${task.description}`)
          : ["- none"]),
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
      const parsedResult = {
        is_drift: toBool((parsed as Record<string, unknown>).is_drift),
        reason: toString((parsed as Record<string, unknown>).reason, "no reason"),
        evidence: toEvidence((parsed as Record<string, unknown>).evidence),
        confidence: toConfidence((parsed as Record<string, unknown>).confidence),
      } satisfies SessionClosedLoop.DriftCheckResult
      const verificationPattern = /\b(verification|verify|check_cert\.py|verification\.txt|fingerprint|subject|permissions)\b/i
      const verificationInSummary = input.summaries.some((summary) => verificationPattern.test(summary))
      const verificationAllowedByIntent =
        verificationPattern.test(input.anchor.text) ||
        verificationPattern.test(input.explicit_request) ||
        input.task_graph.some((task) => verificationPattern.test(`${task.description} ${task.task_role}`))
      if (parsedResult.is_drift && verificationInSummary && verificationAllowedByIntent) {
        return {
          is_drift: false,
          reason: "verification artifacts align with original request and TaskGraph",
          evidence: [
            "verification artifacts present in completed summaries",
            "verification explicitly allowed by anchor/request/task graph",
          ],
          confidence: 0,
        } satisfies SessionClosedLoop.DriftCheckResult
      }
      return parsedResult
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

    const cleanJsonEnvelope = (text: string) =>
      text
        .replace(/```json/gi, "")
        .replace(/```/g, "")
        .replace(/<task_result>/gi, "")
        .replace(/<\/task_result>/gi, "")
        .trim()

    const extractJsonObjectText = (text: string) => {
      const cleaned = cleanJsonEnvelope(text)
      const start = cleaned.indexOf("{")
      const end = cleaned.lastIndexOf("}")
      if (start < 0 || end < 0 || end <= start) return
      return cleaned.slice(start, end + 1)
    }

    const parseJsonRecord = (text: string) => {
      const json = extractJsonObjectText(text)
      if (!json) return
      try {
        const parsed = JSON.parse(json)
        if (!parsed || typeof parsed !== "object") return
        return parsed as Record<string, unknown>
      } catch {
        return
      }
    }

    const repairTaskGraphJson = (json: string) => {
      const quoted = '"(?:\\\\.|[^"\\\\])*"'
      const arrayFieldPattern = new RegExp(
        `"(blockedBy|blocked_by|tags)"\\s*:\\s*(${quoted}(?:\\s*,\\s*${quoted})+)(?=\\s*(?:,\\s*"[A-Za-z_][A-Za-z0-9_]*"\\s*:|[}\\]]))`,
        "g",
      )
      const wrapped = json.replace(
        arrayFieldPattern,
        (_match, key: string, values: string) => `"${key}":[${values}]`,
      )
      const withoutTrailingComma = wrapped.replace(/,\s*([}\]])/g, "$1")
      if (withoutTrailingComma === json) return
      return withoutTrailingComma
    }

    const parseTaskGraph = (text: string): ParsedTaskGraph => {
      const json = extractJsonObjectText(text)
      if (!json) {
        return {
          ok: false,
          reason: "TaskGraph JSON invalid: missing JSON object",
          repaired: false,
        }
      }
      const parse = (input: string) => {
        try {
          const parsed = JSON.parse(input)
          if (!parsed || typeof parsed !== "object") return
          return parsed as Record<string, unknown>
        } catch {
          return
        }
      }
      const parsed = parse(json)
      if (parsed) {
        const graph = (parsed.task_graph ?? parsed) as Record<string, unknown>
        const nodes = Array.isArray(graph.nodes)
          ? graph.nodes.filter((node): node is Record<string, unknown> => !!node && typeof node === "object")
          : []
        if (nodes.length === 0) {
          return {
            ok: false,
            reason: "TaskGraph JSON invalid: nodes must be a non-empty array",
            repaired: false,
          }
        }
        return {
          ok: true,
          graph: { nodes },
          repaired: false,
        }
      }
      const repairedJson = repairTaskGraphJson(json)
      if (!repairedJson) {
        return {
          ok: false,
          reason: "TaskGraph JSON invalid: JSON.parse failed and deterministic repair did not match",
          repaired: false,
        }
      }
      const repaired = parse(repairedJson)
      if (!repaired) {
        return {
          ok: false,
          reason: "TaskGraph JSON invalid: deterministic repair failed",
          repaired: true,
        }
      }
      const repairedGraph = (repaired.task_graph ?? repaired) as Record<string, unknown>
      const repairedNodes = Array.isArray(repairedGraph.nodes)
        ? repairedGraph.nodes.filter((node): node is Record<string, unknown> => !!node && typeof node === "object")
        : []
      if (repairedNodes.length === 0) {
        return {
          ok: false,
          reason: "TaskGraph JSON invalid after repair: nodes must be a non-empty array",
          repaired: true,
        }
      }
      return {
        ok: true,
        graph: { nodes: repairedNodes },
        repaired: true,
      }
    }

    const parseReviewerOutput = (text: string): { passed: boolean; notes?: string; task_graph?: TaskGraphCandidate } => {
      const parsed = parseJsonRecord(text)
      if (!parsed) return { passed: true }
      const passed = parsed.passed === true
      const notes = typeof parsed.notes === "string" ? parsed.notes : undefined
      if (passed) return { passed, notes }
      const graph = parseTaskGraph(JSON.stringify(parsed.task_graph ?? {}))
      if (!graph.ok) return { passed, notes }
      return { passed, notes, task_graph: graph.graph }
    }

    const CERT_ARTIFACT_REQUIRED_PATHS = [
      "/app/ssl/server.key",
      "/app/ssl/server.crt",
      "/app/ssl/server.pem",
      "/app/ssl/verification.txt",
    ] as const
    const SCRIPT_REQUIRED_PATHS = ["/app/check_cert.py"] as const
    const DEFAULT_REQUIRED_EXECUTION_PATHS = [...CERT_ARTIFACT_REQUIRED_PATHS, ...SCRIPT_REQUIRED_PATHS] as const
    const TLS_FORBIDDEN_EVIDENCE_PATHS = [
      "ssl/",
      "packages/codemate/ssl/",
      "test/certs/",
      "ssl/keys/server.key",
      "ssl/certs/server.crt",
      "ssl/check_cert.py",
      "verification.txt",
    ] as const
    const normalizePathToken = (value: string) => toAbsolutePath(value, { cwd: process.cwd() }).replace(/\/$/, "")
    const isPrimaryTlsPath = (pathname: string) => /^\/app\/(?:ssl(?:\/|$)|check_cert\.py$)/.test(pathname)
    const isFallbackTlsPath = (pathname: string) => {
      const homeApp = toAbsolutePath("~/app", { cwd: process.cwd() })
      if (!homeApp) return false
      return pathname === `${homeApp}/check_cert.py` || pathname.startsWith(`${homeApp}/ssl/`)
    }
    const isForbiddenTlsEvidencePath = (path: string) => {
      const lower = path.toLowerCase()
      if (lower.startsWith("packages/codemate/ssl/")) return true
      if (lower.startsWith("test/certs/")) return true
      if (lower === "ssl/check_cert.py") return true
      if (lower === "ssl/keys/server.key") return true
      if (lower === "ssl/certs/server.crt") return true
      if (lower.startsWith("ssl/")) return true
      if (lower === "verification.txt") return true
      return false
    }
    const inferTlsRequiredPathsForTask = (task: {
      id?: string
      task_id?: string
      description?: string
      prompt?: string
      tags?: string[]
    }) => {
      const taskID = `${task.task_id ?? task.id ?? ""}`.toLowerCase()
      const tags = Array.isArray(task.tags) ? task.tags.map((tag) => tag.toLowerCase()) : []
      const text = `${task.description ?? ""}\n${task.prompt ?? ""}\n${tags.join(" ")}\n${taskID}`.toLowerCase()
      const certArtifactHint =
        /\b(cert(?:ificate)?\s+artifact|artifact\s+family|server\.key|server\.crt|server\.pem|verification\.txt|tls cert|ssl cert|impl_cert)\b/.test(
          text,
        ) ||
        taskID.includes("impl_cert")
      const scriptHint =
        /\b(check[_-]?cert\.py|verification script|cert verification script|create script|impl_script|check_script)\b/.test(text) ||
        taskID.includes("impl_script")
      if (certArtifactHint && scriptHint) {
        return [...DEFAULT_REQUIRED_EXECUTION_PATHS]
      }
      if (certArtifactHint) {
        return [...CERT_ARTIFACT_REQUIRED_PATHS]
      }
      if (scriptHint) {
        return [...SCRIPT_REQUIRED_PATHS]
      }
      return [] as string[]
    }
    const resolveCoderRequiredPathsForTask = (task: MessageV2.SubtaskPart) => {
      const explicit = extractRequiredPaths(`${task.description}\n${task.prompt}`)
      if (explicit.length > 0) return explicit
      return inferTlsRequiredPathsForTask(task)
    }
    const computeCurrentRunTlsAllowedPaths = (
      trajectory: ReturnType<typeof filterTrajectoryByRun>,
      actualOutputOverride?: string[],
    ) => {
      const runRequiredPaths = [
        ...new Set(
          trajectory
            .filter((record) => record.agent === "coder")
            .flatMap((record) => record.expected_outputs)
            .map((item) => item.trim())
            .filter((item) => item.length > 0),
        ),
      ]
      const requiredPaths = runRequiredPaths.length > 0 ? runRequiredPaths : [...DEFAULT_REQUIRED_EXECUTION_PATHS]
      const fallbackPaths = resolveFallbackPaths(requiredPaths, { cwd: process.cwd() })
      const allowedAbsolute = ensureAbsolutePathList([...requiredPaths, ...fallbackPaths], { cwd: process.cwd() })
      const allowedPathSet = new Set(allowedAbsolute.map((item) => normalizePathToken(item)))
      const actualOutputPaths = (actualOutputOverride && actualOutputOverride.length > 0
        ? actualOutputOverride
        : trajectory
            .filter((record) => record.agent === "coder" && (record.outcome === "success" || record.outcome === "recovered"))
            .flatMap((record) => record.artifact_paths)
      )
        .map((item) => normalizePathToken(item))
        .filter((item) => item.length > 0 && (allowedPathSet.size === 0 || allowedPathSet.has(item)))
      const hasFallbackEvidence = actualOutputPaths.some((path) => isFallbackTlsPath(path))
      const hasPrimaryEvidence = actualOutputPaths.some((path) => isPrimaryTlsPath(path))
      const allowedPaths = [
        ...(hasPrimaryEvidence ? ensureAbsolutePathList(requiredPaths, { cwd: process.cwd() }) : []),
        ...(hasFallbackEvidence ? fallbackPaths : []),
      ]
      if (allowedPaths.length === 0) {
        return {
          requiredPaths,
          fallbackPaths,
          actualOutputPaths,
          allowedPaths: [...requiredPaths, ...fallbackPaths],
          mode: "unknown" as const,
        }
      }
      if (hasFallbackEvidence && !hasPrimaryEvidence) {
        return {
          requiredPaths,
          fallbackPaths,
          actualOutputPaths,
          allowedPaths: [...fallbackPaths],
          mode: "fallback" as const,
        }
      }
      if (hasPrimaryEvidence && !hasFallbackEvidence) {
        return {
          requiredPaths,
          fallbackPaths,
          actualOutputPaths,
          allowedPaths: [...requiredPaths],
          mode: "primary" as const,
        }
      }
      return {
        requiredPaths,
        fallbackPaths,
        actualOutputPaths,
        allowedPaths,
        mode: "mixed" as const,
      }
    }

    const REVIEWER_TLS_KEYWORDS = [
      "tls",
      "ssl",
      "certificate",
      "openssl",
      "rsa",
      "pem",
      "server.key",
      "server.crt",
      "server.pem",
      "check_cert.py",
      "verification.txt",
      "common name",
      "cn=",
      "fingerprint",
      "expiry",
    ]
    const REVIEWER_IRRELEVANT_DOC_KEYWORDS = [
      "readme",
      "architecture document",
      "architecture docs",
      "doc link",
      "markdown",
      "typo",
      "文档",
      "链接",
      "拼写",
    ]
    const isTlsLikeContext = (input: {
      taskDescription: string
      intentAnchor?: string
      trajectory: ReturnType<typeof filterTrajectoryByRun>
    }) => {
      const contextText = [
        input.taskDescription,
        input.intentAnchor ?? "",
        ...input.trajectory.flatMap((record) => [
          record.action_summary,
          ...record.actual_outputs,
          ...record.artifact_paths,
          ...record.verification_results,
        ]),
      ]
        .join("\n")
        .toLowerCase()
      return REVIEWER_TLS_KEYWORDS.some((keyword) => contextText.includes(keyword))
    }
    const evaluateTesterEvidenceBinding = (input: {
      testerText: string
      taskDescription: string
      intentAnchor?: string
      trajectory: ReturnType<typeof filterTrajectoryByRun>
      actualOutputOverride?: string[]
    }) => {
      const tlsLike = isTlsLikeContext(input)
      if (!tlsLike)
        return {
          valid: true as const,
          stale: false as const,
          required_paths: [] as string[],
          fallback_paths: [] as string[],
          actual_output_paths: [] as string[],
        }
      const tlsAllowed = computeCurrentRunTlsAllowedPaths(input.trajectory, input.actualOutputOverride)
      const mentions = resolveActualOutputPathsFromText(input.testerText, { cwd: process.cwd() })
      const forbidden = [...new Set(mentions.filter((path) => isForbiddenTlsEvidencePath(path)))]
      const allowedSet = new Set(tlsAllowed.allowedPaths.map((path) => normalizePathToken(path)))
      const actualSet = new Set(tlsAllowed.actualOutputPaths.map((path) => normalizePathToken(path)))
      const referencedAllowedPath = mentions.some((path) => allowedSet.has(path))
      const referencedActualPath = mentions.some((path) => actualSet.has(path))
      const missingActualOutputEvidence = tlsAllowed.actualOutputPaths.length === 0
      const missingActualOutputReference = tlsAllowed.actualOutputPaths.length > 0 && !referencedActualPath
      const staleOnly = mentions.length > 0 && mentions.every((path) => isForbiddenTlsEvidencePath(path))
      const missingCurrentRunPathReference = tlsAllowed.mode !== "unknown" && !referencedAllowedPath
      const searchRoots = absoluteSearchRootsFromOutputs(tlsAllowed.actualOutputPaths)
      const outOfScopePaths = mentions.filter((candidate) => {
        if (searchRoots.length === 0) return false
        if (actualSet.has(candidate)) return false
        return !searchRoots.some((root) => isPathInsideRoot(candidate, root))
      })
      if (
        missingActualOutputEvidence ||
        forbidden.length > 0 ||
        staleOnly ||
        missingActualOutputReference ||
        missingCurrentRunPathReference ||
        outOfScopePaths.length > 0
      ) {
        const mismatchReasons: string[] = []
        if (missingActualOutputEvidence) mismatchReasons.push("missing_actual_output_evidence")
        if (forbidden.length > 0) mismatchReasons.push("forbidden_path_used")
        if (staleOnly) mismatchReasons.push("stale_paths_only")
        if (missingActualOutputReference) mismatchReasons.push("missing_actual_output_reference")
        if (missingCurrentRunPathReference) mismatchReasons.push("missing_current_run_path_reference")
        if (outOfScopePaths.length > 0) mismatchReasons.push("search_scope_forbidden")
        const userMessage = outOfScopePaths.length > 0
          ? RECOVERABLE_FAILURE_MESSAGES.searchScopeForbidden
          : missingActualOutputEvidence
            ? RECOVERABLE_FAILURE_MESSAGES.missingOutputEvidence
            : RECOVERABLE_FAILURE_MESSAGES.default
        return {
          valid: false as const,
          stale: true as const,
          required_paths: tlsAllowed.requiredPaths,
          fallback_paths: tlsAllowed.fallbackPaths,
          actual_output_paths: tlsAllowed.actualOutputPaths,
          forbidden_paths_seen: forbidden,
          failureSignal: JSON.stringify({
            category: "stale_test_evidence",
            reason: "tester used stale or non-current-run evidence paths",
            mismatch_reasons: mismatchReasons,
            required_paths: tlsAllowed.requiredPaths,
            fallback_paths: tlsAllowed.fallbackPaths,
            actual_output_paths: tlsAllowed.actualOutputPaths,
            forbidden_paths_seen: [...forbidden, ...outOfScopePaths].slice(0, 12),
          }),
          userMessage,
        }
      }
      return {
        valid: true as const,
        stale: false as const,
        required_paths: tlsAllowed.requiredPaths,
        fallback_paths: tlsAllowed.fallbackPaths,
        actual_output_paths: tlsAllowed.actualOutputPaths,
      }
    }
    const evaluateReviewerEvidenceBinding = (input: {
      reviewText: string
      reviewPassed?: boolean
      taskDescription: string
      intentAnchor?: string
      trajectory: ReturnType<typeof filterTrajectoryByRun>
      actualOutputOverride?: string[]
    }) => {
      const reviewText = input.reviewText.toLowerCase()
      const tlsLike = isTlsLikeContext(input)
      if (!tlsLike) return { valid: true as const }
      const isPrimarySslPath = (pathname: string) => /^\/app\/ssl(?:\/|$)/.test(pathname)
      const homeApp = toAbsolutePath("~/app", { cwd: process.cwd() })
      const isFallbackSslPath = (pathname: string) =>
        homeApp ? pathname === `${homeApp}/check_cert.py` || pathname.startsWith(`${homeApp}/ssl/`) : false
      const tlsAllowed = computeCurrentRunTlsAllowedPaths(input.trajectory, input.actualOutputOverride)

      const actualArtifactPaths = [
        ...new Set(
          input.trajectory.flatMap((record) => record.artifact_paths).filter((path) => isPrimarySslPath(path) || isFallbackSslPath(path)),
        ),
      ]
      const fallbackOnly =
        actualArtifactPaths.some((path) => isFallbackSslPath(path)) &&
        !actualArtifactPaths.some((path) => isPrimarySslPath(path))
      const mentionsTlsKeyword = REVIEWER_TLS_KEYWORDS.some((keyword) => reviewText.includes(keyword))
      const mentionsTesterEvidence =
        reviewText.includes("tester") ||
        reviewText.includes("verification") ||
        reviewText.includes("common name") ||
        reviewText.includes("cn=") ||
        reviewText.includes("fingerprint") ||
        reviewText.includes("expiry")
      const hasPrimaryEvidencePath = actualArtifactPaths.some((path) => isPrimarySslPath(path))
      const hasFallbackEvidencePath = actualArtifactPaths.some((path) => isFallbackSslPath(path))
      const mentionsActualPath =
        (actualArtifactPaths.length > 0 && actualArtifactPaths.some((path) => reviewText.includes(path.toLowerCase()))) ||
        (hasPrimaryEvidencePath && /(^|[\s"'`(])\/app\/ssl(?:\/|\b)/.test(reviewText)) ||
        (hasFallbackEvidencePath && actualArtifactPaths.some((path) => reviewText.includes(toHomeLabel(path).toLowerCase())))
      const mentionsIrrelevantDocs = REVIEWER_IRRELEVANT_DOC_KEYWORDS.some((keyword) => reviewText.includes(keyword))
      const mentionsFallbackPath =
        hasFallbackEvidencePath &&
        actualArtifactPaths.filter((path) => isFallbackSslPath(path)).some((path) => reviewText.includes(toHomeLabel(path).toLowerCase()))
      const mentionsPrimaryPath = /(^|[\s"'`(])\/app\/ssl(?:\/|\b)/.test(reviewText)
      const claimsPrimaryPathAgainstFallback = fallbackOnly && mentionsPrimaryPath && !mentionsFallbackPath
      const missingActualOutputEvidence = actualArtifactPaths.length === 0
      if (input.reviewPassed === true && !mentionsIrrelevantDocs && !claimsPrimaryPathAgainstFallback && !missingActualOutputEvidence) {
        return { valid: true as const }
      }
      const hasTesterEvidenceInTrajectory = input.trajectory.some((record) => record.quality_signals.tester_passed === true)
      const genericApprovalOnly =
        /\b(approved|approve|looks good|lgtm|pass(ed)?)\b/.test(reviewText) &&
        !mentionsTlsKeyword &&
        !mentionsTesterEvidence &&
        !mentionsActualPath &&
        !mentionsIrrelevantDocs
      if (genericApprovalOnly && hasTesterEvidenceInTrajectory && !claimsPrimaryPathAgainstFallback && !missingActualOutputEvidence) {
        return { valid: true as const }
      }
      const mismatchReasons: string[] = []
      if (missingActualOutputEvidence) mismatchReasons.push("missing_actual_output_evidence")
      if (mentionsIrrelevantDocs && !mentionsTlsKeyword) mismatchReasons.push("irrelevant_doc_topic")
      if (!mentionsTlsKeyword) mismatchReasons.push("missing_tls_context")
      if (!mentionsTesterEvidence) mismatchReasons.push("missing_tester_evidence")
      if (!mentionsActualPath) mismatchReasons.push("missing_actual_path")
      if (claimsPrimaryPathAgainstFallback) mismatchReasons.push("claims_primary_path_without_evidence")
      if (mismatchReasons.length === 0) return { valid: true as const }
      return {
        valid: false as const,
        userMessage: RECOVERABLE_FAILURE_MESSAGES.reviewFailed,
        failureSignal: JSON.stringify({
          category: "review_mismatch",
          reason: "review output does not match current run intent/evidence",
          mismatch_reasons: mismatchReasons,
          required_paths: tlsAllowed.requiredPaths,
          fallback_paths: tlsAllowed.fallbackPaths,
          actual_output_paths: actualArtifactPaths,
        }),
      }
    }

    const summarizeSelfcheckFailure = (report: SessionClosedLoop.SelfCheckReport) =>
      report.results
        .filter((item) => item.exit_code !== 0)
        .slice(0, 3)
        .map((item) => `${item.command} exit=${item.exit_code}`)
        .join("; ") || "selfcheck command failed"

    const summarizeSelfcheckSuccess = (report: SessionClosedLoop.SelfCheckReport) =>
      report.results
        .slice(0, 3)
        .map((item) => `${item.command} exit=${item.exit_code}`)
        .join("; ") || "selfcheck passed"

    const replanGraphFromSubtasks = (tasks: MessageV2.SubtaskPart[]): ReplanTaskGraph => {
      const nodes = tasks.map((task) => ({
        id: task.task_id ?? task.id,
        task_role: task.task_role,
        agent: task.agent,
        description: task.description,
        blockedBy: Array.isArray(task.blocked_by) ? task.blocked_by : [],
        tags: Array.isArray(task.tags) ? task.tags : [],
        needsResearch: task.needs_research,
        run_id: task.run_id,
        source_user_message_id: task.source_user_message_id,
        intent_anchor_hash: task.intent_anchor_hash,
      }))
      return { nodes }
    }

    const toTaskGraphCandidate = (graph: ReplanTaskGraph): TaskGraphCandidate => ({
      nodes: graph.nodes.map((node) => ({
        id: node.id,
        task_role: node.task_role,
        agent: node.agent,
        description: node.description,
        blockedBy: node.blockedBy,
        tags: node.tags,
        needsResearch: node.needsResearch,
      })),
    })

    const testerSignal = (text: string | undefined) => {
      const normalized = (text ?? "").toLowerCase()
      if (!normalized.trim()) return "unknown"
      if (/\b(pass|passed|all tests passed|ok)\b/.test(normalized) && !/\b(fail|failed|error)\b/.test(normalized))
        return "passed"
      if (/\b(fail|failed|error|regression|assertion)\b/.test(normalized)) return "failed"
      return "unknown"
    }
    const listCompletedToolsInSession = Effect.fn("SessionPrompt.listCompletedToolsInSession")(function* (subtaskSessionID: SessionID) {
      const messages = yield* MessageV2.filterCompactedEffect(subtaskSessionID).pipe(Effect.orElseSucceed(() => []))
      return messages.flatMap((message) =>
        message.parts.flatMap((part) => {
          if (part.type !== "tool") return []
          if (part.state.status !== "completed") return []
          return [part.tool]
        }),
      )
    })
    const coderLocalSanitySignal = (text: string | undefined) =>
      /\b(local sanity check (passed|ok)|sanity check (passed|ok)|syntax (ok|passed)|command succeeded|file exists)\b/i.test(
        text ?? "",
      )

    const normalizeTaskGraph = (input: {
      graph: TaskGraphCandidate
      intent: TaskExecutionIntent
    }): NormalizedTaskGraph => {
      const warnings: string[] = []
      const seenInputIDs = new Set<string>()
      const nodes = input.graph.nodes.flatMap((node, index) => {
        const idRaw = typeof node.id === "string" ? node.id.trim() : ""
        if (!idRaw) {
          warnings.push(`TaskGraph node dropped at index ${index}: missing id`)
          return []
        }
        const explicitRole = isTaskRole(node.task_role) ? node.task_role : undefined
        const agentRole =
          typeof node.agent === "string" ? roleForAgent(node.agent.trim()) ?? legacyRoleForAgent(node.agent.trim()) : undefined
        // Single-writer invariant: agent=writer must always resolve to writer even if task_role is malformed/mismatched.
        const role = agentRole === "writer" ? "writer" : explicitRole ?? agentRole
        if (!role) {
          warnings.push(`TaskGraph node "${idRaw}" dropped: invalid task_role/agent`)
          return []
        }
        if (agentRole === "writer" && explicitRole && explicitRole !== "writer") {
          warnings.push(`TaskGraph node "${idRaw}" forced to writer because agent=writer`)
        }
        const description =
          typeof node.description === "string" && node.description.trim().length > 0
            ? node.description.trim()
            : `task ${idRaw}`
        const blockedByCandidate = Array.isArray(node.blockedBy)
          ? node.blockedBy
          : Array.isArray(node.blocked_by)
            ? node.blocked_by
            : typeof node.blockedBy === "string"
              ? [node.blockedBy]
              : typeof node.blocked_by === "string"
                ? [node.blocked_by]
                : []
        const tagsCandidate = Array.isArray(node.tags) ? node.tags : typeof node.tags === "string" ? [node.tags] : []
        const blockedBy = [...new Set(blockedByCandidate)]
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
        const tags = [...new Set(tagsCandidate)]
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
        const needsResearch = node.needsResearch === true || node.needs_research === true
        let id = idRaw
        let suffix = 1
        while (seenInputIDs.has(id)) {
          id = `${idRaw}_${suffix}`
          suffix += 1
        }
        if (id !== idRaw) {
          warnings.push(`TaskGraph duplicate id "${idRaw}" renamed to "${id}"`)
        }
        seenInputIDs.add(id)
        return [
          {
            id,
            task_role: role,
            agent: roleAgent(role),
            description,
            blockedBy,
            needsResearch,
            tags,
          } satisfies SessionClosedLoop.TaskNode,
        ]
      })
      if (nodes.length === 0) {
        return {
          ok: false,
          reason: "TaskGraph schema invalid: no valid nodes",
          warnings,
        }
      }
      const knownIDs = new Set(nodes.map((node) => node.id))
      const normalizedNodes = nodes.map((node) => {
        const filteredBlockedBy = node.blockedBy.filter((dependency) => dependency !== node.id && knownIDs.has(dependency))
        if (filteredBlockedBy.length !== node.blockedBy.length) {
          warnings.push(`TaskGraph node "${node.id}" had unknown/self dependencies and they were dropped`)
        }
        return {
          ...node,
          blockedBy: [...new Set(filteredBlockedBy)],
          tags: [...new Set(node.tags)],
        }
      })
      const blockingResearchIDs = normalizedNodes
        .filter((node) => node.task_role === "research")
        .filter((node) => RESEARCH_BLOCKING_PATTERNS.some((pattern) => pattern.test(`${node.description} ${node.tags.join(" ")}`.toLowerCase())))
        .map((node) => node.id)
      const withBlockingResearchDeps =
        blockingResearchIDs.length === 0
          ? normalizedNodes
          : normalizedNodes.map((node) => {
              if (node.task_role !== "coder") return node
              const text = `${node.description} ${node.tags.join(" ")}`.toLowerCase()
              const dependsOnResearch = CODER_RESEARCH_DEPENDENCY_PATTERNS.some((pattern) => pattern.test(text))
              if (!dependsOnResearch) return node
              const alreadyDependsOnResearch = node.blockedBy.some((dependency) => blockingResearchIDs.includes(dependency))
              if (alreadyDependsOnResearch) return node
              warnings.push(
                `TaskGraph node "${node.id}" inferred blocking research dependency and now depends on ${blockingResearchIDs.join(", ")}`,
              )
              return {
                ...node,
                blockedBy: [...new Set([...node.blockedBy, ...blockingResearchIDs])],
              }
            })
      const blockingResearchIDSet = new Set(blockingResearchIDs)
      const coderDependsOnResearchSemantics = (node: SessionClosedLoop.TaskNode) =>
        CODER_RESEARCH_DEPENDENCY_PATTERNS.some((pattern) => pattern.test(`${node.description} ${node.tags.join(" ")}`.toLowerCase()))
      const withResearchBoundCoder = (node: SessionClosedLoop.TaskNode): SessionClosedLoop.TaskNode => {
        if (node.task_role !== "coder") return node
        const alreadyBlockedByResearch = node.blockedBy.some((dependency) => blockingResearchIDSet.has(dependency))
        const shouldDependOnResearch = blockingResearchIDSet.size > 0 && (alreadyBlockedByResearch || coderDependsOnResearchSemantics(node))
        const blockedBy = shouldDependOnResearch
          ? [...new Set([...node.blockedBy, ...blockingResearchIDs])]
          : [...new Set(node.blockedBy)]
        const hasResearchDependency = blockedBy.some((dependency) => blockingResearchIDSet.has(dependency))
        const tags = hasResearchDependency ? node.tags.filter((tag) => tag !== "parallel") : [...node.tags]
        return {
          ...node,
          blockedBy,
          tags: [...new Set(tags)],
        } satisfies SessionClosedLoop.TaskNode
      }
      let nodesForExecution: SessionClosedLoop.TaskNode[] = withBlockingResearchDeps
      const seenIDs = new Set(nodesForExecution.map((node) => node.id))
      const nextID = (base: string) => {
        let value = base
        let suffix = 1
        while (seenIDs.has(value)) {
          value = `${base}_${suffix}`
          suffix += 1
        }
        seenIDs.add(value)
        return value
      }
      const nodeText = (node: SessionClosedLoop.TaskNode) =>
        `${node.id} ${node.description} ${node.tags.join(" ")}`.toLowerCase()
      const pathPrefixFromNode = (node: SessionClosedLoop.TaskNode) => {
        const text = nodeText(node)
        const match = [...text.matchAll(/(?:^|[\s`'"])((?:\.{0,2}\/|~\/)?[a-z0-9._-]+(?:\/[a-z0-9._-]+)+)/gi)][0]?.[1]
        if (!match) return
        const normalized = match.replace(/^(\.\/|~\/)/, "")
        const segments = normalized.split("/").filter((item) => item.length > 0)
        if (segments.length === 0) return
        return segments.slice(0, 2).join("/")
      }
      const artifactFamilyOfNode = (node: SessionClosedLoop.TaskNode) => {
        const text = nodeText(node)
        for (const family of ARTIFACT_FAMILY_PATTERNS) {
          if (family.patterns.some((pattern) => pattern.test(text))) return family.key
        }
        const prefix = pathPrefixFromNode(node)
        if (prefix) return `path:${prefix}`
        const ext = [...text.matchAll(/\.[a-z0-9]{1,5}\b/g)][0]?.[0]
        if (ext) return `ext:${ext}`
        const firstTag = node.tags[0]
        if (firstTag) return `tag:${firstTag.toLowerCase()}`
        return "generic"
      }
      const operationHitCount = (node: SessionClosedLoop.TaskNode) =>
        OPERATION_STEP_PATTERNS.filter((pattern) => pattern.test(nodeText(node))).length
      const workPackageHitCount = (node: SessionClosedLoop.TaskNode) =>
        WORK_PACKAGE_SIGNAL_PATTERNS.filter((pattern) => pattern.test(nodeText(node))).length
      const stepVerbHit = (node: SessionClosedLoop.TaskNode) =>
        STEP_VERB_PATTERNS.some((pattern) => pattern.test(nodeText(node)))
      const boundaryGroupsOfNode = (node: SessionClosedLoop.TaskNode) => {
        const text = nodeText(node)
        return WORK_PACKAGE_BOUNDARY_GROUPS.flatMap((group) =>
          group.patterns.some((pattern) => pattern.test(text)) ? [group.key] : [],
        )
      }
      const isOperationStepNode = (node: SessionClosedLoop.TaskNode) => {
        if (node.task_role !== "coder") return false
        const operationHits = operationHitCount(node)
        if (operationHits === 0) return false
        const workPackageHits = workPackageHitCount(node)
        return operationHits >= workPackageHits
      }
      const isVerificationAsCoderNode = (node: SessionClosedLoop.TaskNode) => {
        if (node.task_role !== "coder") return false
        const text = nodeText(node)
        const verificationHit = VERIFICATION_AS_CODER_PATTERNS.some((pattern) => pattern.test(text))
        if (!verificationHit) return false
        const implHit = ROLE_BOUNDARY_IMPL_SIGNAL_PATTERNS.some((pattern) => pattern.test(text))
        return !implHit || /\b(final|all requirements|all outputs|acceptance)\b/.test(text)
      }
      const repairVerificationAsCoder = (inputNodes: SessionClosedLoop.TaskNode[]) => {
        const verificationCoderIDs = new Set(
          inputNodes.filter((node) => isVerificationAsCoderNode(node)).map((node) => node.id),
        )
        if (verificationCoderIDs.size === 0) return inputNodes
        const implementationCoderIDs = inputNodes
          .filter((node) => node.task_role === "coder" && !verificationCoderIDs.has(node.id))
          .map((node) => node.id)
        warnings.push(
          `TaskGraph role-boundary repair converted coder verification nodes to tester: ${[...verificationCoderIDs].join(", ")}`,
        )
        return inputNodes.map((node) => {
          if (!verificationCoderIDs.has(node.id)) return node
          return {
            ...node,
            task_role: "tester",
            agent: "tester",
            blockedBy: [...new Set([...node.blockedBy, ...implementationCoderIDs])],
            needsResearch: false,
            tags: [...new Set(node.tags.filter((tag) => tag !== "parallel").concat(["test", "tester", "role-boundary"]))],
          } satisfies SessionClosedLoop.TaskNode
        })
      }
      const collapseOperationStepChains = (inputNodes: SessionClosedLoop.TaskNode[]) => {
        const coderNodes = inputNodes.filter((node) => node.task_role === "coder")
        if (coderNodes.length < 2) return inputNodes
        const orderByID = new Map(inputNodes.map((node, index) => [node.id, index]))
        const coderIDSet = new Set(coderNodes.map((node) => node.id))
        const indegree = new Map(coderNodes.map((node) => [node.id, 0]))
        const out = new Map(coderNodes.map((node) => [node.id, [] as string[]]))
        for (const node of coderNodes) {
          for (const dependency of node.blockedBy) {
            if (!coderIDSet.has(dependency)) continue
            indegree.set(node.id, (indegree.get(node.id) ?? 0) + 1)
            out.set(dependency, [...(out.get(dependency) ?? []), node.id])
          }
        }
        const nodeByID = new Map(inputNodes.map((node) => [node.id, node]))
        const removed = new Set<string>()
        const replacementByID = new Map<string, string>()
        const collapsed: Array<{ node: SessionClosedLoop.TaskNode; index: number }> = []
        const visited = new Set<string>()
        const orderedCoderIDs = coderNodes
          .map((node) => node.id)
          .sort((a, b) => (orderByID.get(a) ?? 0) - (orderByID.get(b) ?? 0))
        for (const id of orderedCoderIDs) {
          if (visited.has(id)) continue
          if ((indegree.get(id) ?? 0) !== 0) continue
          const chain = [id]
          let current = id
          while (true) {
            const nextList = out.get(current) ?? []
            if (nextList.length !== 1) break
            const next = nextList[0]!
            if (visited.has(next) || chain.includes(next)) break
            if ((indegree.get(next) ?? 0) !== 1) break
            chain.push(next)
            current = next
          }
          for (const item of chain) visited.add(item)
          if (chain.length < 2) continue
          const chainNodes = chain.flatMap((item) => {
            const match = nodeByID.get(item)
            return match ? [match] : []
          })
          if (chainNodes.length < 2) continue
          const families = [...new Set(chainNodes.map((node) => artifactFamilyOfNode(node)))]
          const nonGenericFamilies = [...new Set(families.filter((family) => family !== "generic"))]
          const family =
            nonGenericFamilies.length === 1 &&
            families.every((item) => item === "generic" || item === nonGenericFamilies[0])
              ? (nonGenericFamilies[0] ?? "generic")
              : (families[0] ?? "generic")
          const sameFamily =
            families.length === 1 ||
            (nonGenericFamilies.length === 1 && families.every((item) => item === "generic" || item === nonGenericFamilies[0]))
          if (!sameFamily) continue
          if (family === "generic") continue
          const boundaryGroups = [...new Set(chainNodes.flatMap((node) => boundaryGroupsOfNode(node)))]
          const mixedCoreAdapter = boundaryGroups.includes("core") && boundaryGroups.includes("adapter")
          const mixedSchemaIntegration = boundaryGroups.includes("schema") && boundaryGroups.includes("integration")
          const mixedBackendFrontend = boundaryGroups.includes("backend") && boundaryGroups.includes("frontend")
          if (mixedCoreAdapter || mixedSchemaIntegration || mixedBackendFrontend) continue
          const operationCount = chainNodes.filter((node) => isOperationStepNode(node)).length
          const mostlyOperationSteps = operationCount >= Math.ceil(chainNodes.length / 2)
          const linearStepVerbChain = chainNodes.length >= 3 && chainNodes.every((node) => stepVerbHit(node))
          if (!mostlyOperationSteps && !linearStepVerbChain) continue
          const chainSet = new Set(chain)
          const externalBlockedBy = [
            ...new Set(chainNodes.flatMap((node) => node.blockedBy).filter((dependency) => !chainSet.has(dependency))),
          ]
          const mergedID = nextID(`${family.replace(/[^a-z0-9:_-]/gi, "_")}_work_package`)
          const mergedNode = {
            id: mergedID,
            task_role: "coder",
            agent: "coder",
            description: `Implement ${family.replace(/[:_]/g, " ")} work package`,
            blockedBy: externalBlockedBy,
            needsResearch: chainNodes.some((node) => node.needsResearch === true),
            tags: [
              ...new Set(
                chainNodes
                  .flatMap((node) => node.tags)
                  .filter((tag) => tag !== "parallel")
                  .concat(["impl", "work-package", "single_scope:work_package"]),
              ),
            ],
          } satisfies SessionClosedLoop.TaskNode
          const firstIndex = Math.min(...chain.map((item) => orderByID.get(item) ?? Number.MAX_SAFE_INTEGER))
          collapsed.push({ node: mergedNode, index: firstIndex })
          for (const item of chain) {
            removed.add(item)
            replacementByID.set(item, mergedID)
          }
          warnings.push(
            `TaskGraph collapsed operation-step coder chain into work package "${mergedID}" (${chain.join(" -> ")})`,
          )
        }
        if (replacementByID.size === 0) return inputNodes
        const rewritten = inputNodes.flatMap((node) => {
          if (removed.has(node.id)) return []
          return [
            {
              ...node,
              blockedBy: [
                ...new Set(
                  node.blockedBy
                    .map((dependency) => replacementByID.get(dependency) ?? dependency)
                    .filter((dependency) => dependency !== node.id),
                ),
              ],
            } satisfies SessionClosedLoop.TaskNode,
          ]
        })
        return [...rewritten, ...collapsed.map((item) => item.node)].sort(
          (a, b) =>
            (orderByID.get(a.id) ??
              collapsed.find((item) => item.node.id === a.id)?.index ??
              Number.MAX_SAFE_INTEGER) -
            (orderByID.get(b.id) ??
              collapsed.find((item) => item.node.id === b.id)?.index ??
              Number.MAX_SAFE_INTEGER),
        )
      }
      nodesForExecution = collapseOperationStepChains(repairVerificationAsCoder(nodesForExecution)).map(withResearchBoundCoder)
      const requiresCoder = input.intent.requiresImplementation && !input.intent.allowsTesterOnly && !input.intent.researchOnly
      const hasSingleScopeHint = nodesForExecution.some((node) => {
        const text = `${node.description} ${node.tags.join(" ")}`.toLowerCase()
        return [
          "single_scope",
          "small_change",
          "single_scope:small_change",
          "single_scope:unsplittable",
          "single_scope:conflict_risk",
          "unsplittable",
          "cannot split",
          "single file",
          "single-point",
          "single point",
          "conflict risk",
          "same file",
          "不可拆",
          "单点",
          "单文件",
          "冲突风险",
          "同一文件",
        ].some((keyword) => text.includes(keyword))
      })
      const targetCoderCount =
        requiresCoder && input.intent.preferParallelCoders && !input.intent.smallSingleChange && !hasSingleScopeHint ? 2 : requiresCoder ? 1 : 0
      const shouldPreferParallelWorkPackages = targetCoderCount >= 2
      if (requiresCoder) {
        const packageDefs = [
          {
            key: "core",
            label: "Implement core logic and data flow",
            tags: ["impl", "coder-core"],
            keywords: ["core", "logic", "algorithm", "state", "domain", "business", "parser", "engine"],
          },
          {
            key: "integration",
            label: "Integrate and wire modules/interfaces",
            tags: ["impl", "coder-integration", "parallel"],
            keywords: ["integration", "wiring", "wire", "hook", "route", "bootstrap", "connect", "glue", "entrypoint"],
          },
          {
            key: "adapter",
            label: "Build adapter/wrapper boundaries",
            tags: ["impl", "coder-adapter", "parallel"],
            keywords: ["adapter", "wrapper", "bridge", "facade", "shim", "interop", "client", "provider"],
          },
          {
            key: "validation",
            label: "Add validation scripts and runtime checks",
            tags: ["impl", "coder-validation", "parallel"],
            keywords: ["validation", "verify", "verification", "check", "script", "smoke", "sanity", "probe"],
          },
          {
            key: "config",
            label: "Update config/schema/contracts",
            tags: ["impl", "coder-config", "parallel"],
            keywords: ["config", "schema", "contract", "option", "settings", "env", "flag", "manifest", "types"],
          },
          {
            key: "docs",
            label: "Update docs/examples and usage notes",
            tags: ["impl", "coder-docs", "parallel"],
            keywords: ["doc", "readme", "example", "sample", "usage", "guide", "tutorial"],
          },
          {
            key: "edge",
            label: "Handle edge cases, cancellation, and errors",
            tags: ["impl", "coder-edge", "parallel"],
            keywords: ["edge", "cancel", "cancellation", "timeout", "retry", "error", "failure", "fallback", "race"],
          },
        ] as const
        const coderNodes = nodesForExecution.filter((node) => node.task_role === "coder")
        const nonCoderNodes = nodesForExecution.filter((node) => node.task_role !== "coder")
        if (coderNodes.length === 0) {
          const source = nodesForExecution.find((node) => node.task_role !== "writer" && node.task_role !== "planner")
          const coreDescription = source ? `Implement core changes for: ${source.description}` : "Implement core requested code changes"
          const integrationDescription = source
            ? `Integrate changes and update affected call sites for: ${source.description}`
            : "Integrate changes and update affected call sites"
          const seededCoders: SessionClosedLoop.TaskNode[] = [
            {
              id: nextID("coder_core"),
              task_role: "coder",
              agent: "coder",
              description: coreDescription,
              blockedBy: [],
              needsResearch: false,
              tags: ["impl", "coder-core"],
            },
          ]
          if (shouldPreferParallelWorkPackages) {
            seededCoders.push({
              id: nextID("coder_integration"),
              task_role: "coder",
              agent: "coder",
              description: integrationDescription === coreDescription ? `${integrationDescription} (secondary workstream)` : integrationDescription,
              blockedBy: [],
              needsResearch: false,
              tags: ["impl", "coder-integration", "parallel"],
            })
          }
          nodesForExecution = [...nonCoderNodes, ...seededCoders].map(
            (node) =>
              ({
                ...node,
                needsResearch: node.needsResearch === true,
              }) satisfies SessionClosedLoop.TaskNode,
          )
        }
        if (coderNodes.length > 0) {
          const originalCoderByID = new Map(coderNodes.map((node) => [node.id, node]))
          const coderText = (node: SessionClosedLoop.TaskNode) => `${node.description} ${node.tags.join(" ")}`.toLowerCase()
          const hasAnyKeyword = (text: string, keywords: readonly string[]) => keywords.some((keyword) => text.includes(keyword))
          const inferPackageKey = (node: SessionClosedLoop.TaskNode) => {
            const text = coderText(node)
            for (const def of packageDefs) {
              if (hasAnyKeyword(text, def.keywords)) return def.key
            }
            return "core"
          }
          const groups = new Map<string, SessionClosedLoop.TaskNode[]>()
          for (const node of coderNodes) {
            const keyBase = inferPackageKey(node)
            const key = shouldPreferParallelWorkPackages && coderNodes.length > 1 ? `${keyBase}:${node.id}` : keyBase
            const prev = groups.get(key)
            groups.set(key, prev ? [...prev, node] : [node])
          }
          const descriptionsFor = (group: SessionClosedLoop.TaskNode[]) =>
            [...new Set(group.map((item) => item.description.trim()).filter((item) => item.length > 0))]
          const mergedCoders = [...groups.entries()].map(([key, group]) => {
            const def = packageDefs.find((item) => item.key === key)
            const first = group[0]!
            const descriptions = descriptionsFor(group)
            const description =
              group.length === 1
                ? first.description
                : `${def?.label ?? "Implement work package"}: ${descriptions.join("; ")}`
            const rawBlockedBy = [...new Set(group.flatMap((item) => item.blockedBy))]
            const rawTags = [...new Set([...group.flatMap((item) => item.tags), ...(def?.tags ?? ["impl"])])]
            return {
              id: group.length === 1 ? first.id : nextID(`coder_${key}`),
              task_role: "coder",
              agent: "coder",
              description,
              blockedBy: rawBlockedBy,
              needsResearch: group.some((item) => item.needsResearch === true),
              tags: rawTags,
              sourceNodes: group,
            }
          })
          const originalToMerged = new Map<string, string>()
          for (const merged of mergedCoders) {
            for (const source of merged.sourceNodes) {
              originalToMerged.set(source.id, merged.id)
            }
          }
          const cleanedMergedCoders = mergedCoders.map((node) => {
            const blockedBy = [...new Set(node.blockedBy.flatMap((dependency) => {
              const sourceCoder = originalCoderByID.get(dependency)
              if (!sourceCoder) return [dependency]
              const mergedDependency = originalToMerged.get(sourceCoder.id)
              if (!mergedDependency || mergedDependency === node.id) return []
              return [mergedDependency]
            }))]
            return {
              id: node.id,
              task_role: "coder",
              agent: "coder",
              description: node.description,
              blockedBy,
              needsResearch: node.needsResearch,
              tags: node.tags,
            } satisfies SessionClosedLoop.TaskNode
          })
          let reshapedCoders = cleanedMergedCoders
          if (shouldPreferParallelWorkPackages && reshapedCoders.length === 1) {
            const primary = reshapedCoders[0]!
            reshapedCoders = [
              primary,
              {
                id: nextID("coder_integration"),
                task_role: "coder",
                agent: "coder",
                description: `Integrate and wire interfaces for: ${primary.description}`,
                blockedBy: [...new Set(primary.blockedBy)],
                needsResearch: primary.needsResearch,
                tags: ["impl", "coder-integration", "parallel"],
              } satisfies SessionClosedLoop.TaskNode,
            ]
          }
          if (shouldPreferParallelWorkPackages && reshapedCoders.length > 5) {
            const keep = reshapedCoders.slice(0, 4)
            const mergedTail = reshapedCoders.slice(4)
            const mergedTailID = nextID("coder_support")
            const tailDescriptions = [...new Set(mergedTail.map((item) => item.description))]
            const tailBlockedBy = [...new Set(mergedTail.flatMap((item) => item.blockedBy).filter((id) => keep.some((node) => node.id === id)))]
            const tailTags = [...new Set(mergedTail.flatMap((item) => item.tags).concat(["impl", "coder-support", "parallel"]))]
            reshapedCoders = [
              ...keep,
              {
                id: mergedTailID,
                task_role: "coder",
                agent: "coder",
                description: `Implement support work packages: ${tailDescriptions.join("; ")}`,
                blockedBy: tailBlockedBy,
                needsResearch: mergedTail.some((item) => item.needsResearch === true),
                tags: tailTags,
              } satisfies SessionClosedLoop.TaskNode,
            ]
          }
          if (shouldPreferParallelWorkPackages) {
            const allBlocked = reshapedCoders.every((node) => node.blockedBy.length > 0)
            const reshapedCoderIDs = new Set(reshapedCoders.map((node) => node.id))
            const hasExternalDependencies = reshapedCoders.some((node) =>
              node.blockedBy.some((dependency) => !reshapedCoderIDs.has(dependency)),
            )
            if (allBlocked && !hasExternalDependencies) {
              const bootstrap = [...reshapedCoders]
                .sort((a, b) => {
                  if (a.blockedBy.length !== b.blockedBy.length) return a.blockedBy.length - b.blockedBy.length
                  return a.id.localeCompare(b.id)
                })[0]
              if (bootstrap) {
                reshapedCoders = reshapedCoders.map((node) => (node.id === bootstrap.id ? { ...node, blockedBy: [] } : node))
              }
            }
          }
          nodesForExecution = [...nonCoderNodes, ...reshapedCoders].map(
            (node) =>
              ({
                ...node,
                needsResearch: node.needsResearch === true,
              }) satisfies SessionClosedLoop.TaskNode,
          ).map(withResearchBoundCoder)
        }
      }
      if (
        requiresCoder &&
        nodesForExecution.filter((node) => node.task_role === "coder").length === 1 &&
        targetCoderCount >= 2
      ) {
        const primaryCoder = nodesForExecution.find((node) => node.task_role === "coder")
        const secondaryDescription = primaryCoder
          ? `Integrate changes and update affected call sites for: ${primaryCoder.description}`
          : "Integrate changes and update affected call sites"
        nodesForExecution = [
          ...nodesForExecution,
          {
            id: nextID("coder_integration"),
            task_role: "coder",
            agent: "coder",
            description: secondaryDescription,
            blockedBy: primaryCoder ? [...new Set(primaryCoder.blockedBy)] : [],
            needsResearch: primaryCoder?.needsResearch === true,
            tags: ["impl", "coder-integration", "parallel"],
          } satisfies SessionClosedLoop.TaskNode,
        ].map(withResearchBoundCoder)
      }
      nodesForExecution = nodesForExecution.map(withResearchBoundCoder)
      const coderNodes = nodesForExecution.filter((node) => node.task_role === "coder")
      const coderIDs = coderNodes.map((node) => node.id)
      const existingTesterNodes = nodesForExecution.filter((node) => node.task_role === "tester")
      const injectedTesterNodes =
        requiresCoder && coderNodes.length > 0 && existingTesterNodes.length === 0
          ? [
              {
                id: nextID(`test_${coderNodes[0]?.id ?? "impl"}`),
                task_role: "tester",
                agent: "tester",
                description:
                  coderNodes.length > 1
                    ? "Write and run validation tests across all implementation workstreams"
                    : `Write tests for: ${coderNodes[0]?.description ?? "implementation changes"}`,
                blockedBy: coderIDs,
                needsResearch: false,
                tags: ["test", "tester", ...new Set(coderNodes.flatMap((coderNode) => coderNode.tags))],
              } satisfies SessionClosedLoop.TaskNode,
            ]
          : []
      const withTester = [...nodesForExecution, ...injectedTesterNodes].map((node) => {
        if (node.task_role !== "tester") return node
        const dependencies = requiresCoder && coderIDs.length > 0 ? coderIDs : []
        return {
          ...node,
          blockedBy: [...new Set([...node.blockedBy, ...dependencies])],
          needsResearch: false,
        }
      })
      const executionCoderIDs = withTester.filter((node) => node.task_role === "coder").map((node) => node.id)
      const executionTesterIDs = withTester.filter((node) => node.task_role === "tester").map((node) => node.id)
      const executionNodeIDs = [...new Set([...executionCoderIDs, ...executionTesterIDs])]
      const withReviewerBatches = withTester.flatMap((node) => {
        if (node.task_role !== "reviewer") return [node]
        const reviewerDependencies = [...new Set([...node.blockedBy, ...executionNodeIDs])]
        const reviewerCoderDependencies = reviewerDependencies.filter((dependency) => executionCoderIDs.includes(dependency))
        const reviewerTesterDependencies = reviewerDependencies.filter((dependency) => executionTesterIDs.includes(dependency))
        if (reviewerCoderDependencies.length <= REVIEWER_BATCH_MAX_CODER_OUTPUTS) {
          return [
            {
              ...node,
              blockedBy: reviewerDependencies,
            },
          ]
        }
        const coderDependencyBatches: string[][] = []
        for (let index = 0; index < reviewerCoderDependencies.length; index += REVIEWER_BATCH_MAX_CODER_OUTPUTS) {
          coderDependencyBatches.push(reviewerCoderDependencies.slice(index, index + REVIEWER_BATCH_MAX_CODER_OUTPUTS))
        }
        const batchNodes = coderDependencyBatches.map((dependencies, index) => {
          const batchID = nextID(`${node.id}_batch_${index + 1}`)
          return {
            ...node,
            id: batchID,
            description: `${node.description} (batch ${index + 1}/${coderDependencyBatches.length})`,
            blockedBy: [...new Set([...dependencies, ...reviewerTesterDependencies])],
            tags: [...new Set([...node.tags, "review-batch"])],
          } satisfies SessionClosedLoop.TaskNode
        })
        return [
          ...batchNodes,
          {
            ...node,
            description: `${node.description} (final synthesis)`,
            blockedBy: [...new Set([...reviewerDependencies, ...batchNodes.map((batch) => batch.id)])],
            tags: [...new Set([...node.tags, "review-final"])],
          } satisfies SessionClosedLoop.TaskNode,
        ]
      })
      const withoutWriterNodes = withReviewerBatches.filter((node) => node.task_role !== "writer")
      if (withoutWriterNodes.length !== withReviewerBatches.length) {
        warnings.push("TaskGraph writer nodes were removed at normalize stage; runtime writer finalizer handles persistence.")
      }
      return {
        ok: true,
        graph: {
          nodes: withoutWriterNodes,
        },
        warnings,
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

    const emitPlannerGraphInvalid = Effect.fn("SessionPrompt.emitPlannerGraphInvalid")(function* (input: {
      sessionID: SessionID
      parent: MessageV2.User
      task: MessageV2.SubtaskPart
      retry_count: number
      action: "auto_retry" | "stopped"
      reason: string
      repaired: boolean
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
            type: "planner_taskgraph_invalid",
            task_id: input.task.task_id ?? input.task.id,
            retry_count: input.retry_count,
            action: input.action,
            repaired: input.repaired,
            reason: input.reason,
            message: "TaskGraph JSON invalid. Planner output must be parseable JSON.",
          },
          null,
          2,
        ),
      } satisfies MessageV2.TextPart)
    })

    const preparePlannerGraphRetryTask = Effect.fn("SessionPrompt.preparePlannerGraphRetryTask")(function* (input: {
      task: MessageV2.SubtaskPart
      retry_count: number
      reason: string
      repaired: boolean
    }) {
      const prompt = [
        input.task.prompt,
        "",
        "<planner_json_invalid>",
        "TaskGraph JSON invalid.",
        `Reason: ${input.reason}`,
        `Deterministic repair applied: ${input.repaired ? "yes" : "no"}`,
        `Current retry count: ${input.retry_count}`,
        'Return JSON only with exactly {"nodes":[...]}',
        'Never output `"blockedBy": "a", "b"`; use `"blockedBy": ["a", "b"]`.',
        'Never output `"tags": "x", "y"`; use `"tags": ["x", "y"]`.',
        '`blockedBy` must always be an array, including one dependency.',
        '`tags` must always be an array, including one tag.',
        "User numbered steps are not TaskGraph node boundaries.",
        "Output coder work packages instead of operation-step chains.",
        "Do not emit operation-step coder nodes such as create_dir/generate_file/merge_file/write_metadata/run_command.",
        "Use 2-5 coder nodes only when independent work packages exist; a simple cohesive artifact family can be one coder node.",
        "Prefer parallel coder packages and only keep coder-to-coder dependencies when hard dependencies exist.",
        "No markdown, no prose, no explanations.",
        "</planner_json_invalid>",
      ].join("\n")
      yield* sessions.updatePart({
        ...input.task,
        type: "subtask",
        tags: [...new Set([...(input.task.tags ?? []), "planner-retry", "taskgraph", "json-invalid"])],
        prompt,
      } satisfies MessageV2.SubtaskPart)
    })

    const enqueueTaskGraph = Effect.fn("SessionPrompt.enqueueTaskGraph")(function* (input: {
      sessionID: SessionID
      parent: MessageV2.User
      graph: TaskGraphCandidate
      intent: TaskExecutionIntent
      run_id: string
      intent_anchor_hash: string
      source_user_message_id: MessageID
      model: { providerID: ProviderID; modelID: ModelID; variant?: string }
      agent: string
      prefix?: string
      plannerGuardActive?: boolean
      onNodeEnqueued?: (task: MessageV2.SubtaskPart) => Effect.Effect<void>
    }) {
      const normalizedGraph = normalizeTaskGraph({ graph: input.graph, intent: input.intent })
      if (!normalizedGraph.ok) {
        return {
          accepted: false,
          reason: normalizedGraph.reason,
          warnings: normalizedGraph.warnings,
        }
      }
      const idMap = new Map<string, string>()
      for (const node of normalizedGraph.graph.nodes) {
        const nextID = input.prefix ? `${input.prefix}__${node.id}` : node.id
        idMap.set(node.id, nextID)
      }
      const filteredPlanner = normalizedGraph.graph.nodes.filter((node) => node.task_role === "planner")
      if (filteredPlanner.length > 0) {
        log.warn("dropping planner nodes from task graph", {
          sessionID: input.sessionID,
          plannerGuardActive: input.plannerGuardActive === true,
          ids: filteredPlanner.map((node) => node.id),
          prefix: input.prefix,
        })
      }
      const filteredWriter = normalizedGraph.graph.nodes.filter((node) => node.task_role === "writer")
      if (filteredWriter.length > 0) {
        log.warn("dropping writer nodes from task graph", {
          sessionID: input.sessionID,
          ids: filteredWriter.map((node) => node.id),
          prefix: input.prefix,
        })
      }
      const droppedNodeIDs = new Set(
        normalizedGraph.graph.nodes
          .filter((node) => node.task_role === "planner" || node.task_role === "writer")
          .map((node) => node.id),
      )
      const subtaskNodes = normalizedGraph.graph.nodes.filter(
        (node) => node.task_role !== "planner" && node.task_role !== "writer",
      )
      if (subtaskNodes.length === 0) {
        return {
          accepted: false,
          reason: "TaskGraph schema invalid: no executable nodes after filtering planner/writer",
          warnings: normalizedGraph.warnings,
        }
      }
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
        const mappedBlockedBy = node.blockedBy.flatMap((value) =>
          droppedNodeIDs.has(value) ? [] : [idMap.get(value) ?? value],
        )
        if (mappedBlockedBy.length !== node.blockedBy.length) {
          normalizedGraph.warnings.push(
            `TaskGraph node "${node.id}" had blockedBy references to dropped planner/writer nodes`,
          )
        }
        const subtask: MessageV2.SubtaskPart = {
          id: PartID.ascending(),
          messageID: message.id,
          sessionID: input.sessionID,
          type: "subtask",
          task_role: taskRole,
          task_id: idMap.get(node.id) ?? node.id,
          run_id: input.run_id,
          intent_anchor_hash: input.intent_anchor_hash,
          source_user_message_id: input.source_user_message_id,
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
      return {
        accepted: true,
        enqueued: subtaskNodes.length,
        warnings: normalizedGraph.warnings,
      }
    })

    const enqueueAdaptiveReplanPatch = Effect.fn("SessionPrompt.enqueueAdaptiveReplanPatch")(function* (input: {
      sessionID: SessionID
      parent: MessageV2.User
      subtaskParts: MessageV2.SubtaskPart[]
      completedTaskIDs: string[]
      runID: string
      intentAnchorHash: string
      sourceUserMessageID: MessageID
      model: { providerID: ProviderID; modelID: ModelID; variant?: string }
      intent: TaskExecutionIntent
      source: "tester" | "reviewer" | "selfcheck"
      failedTaskID: string
      failedAgent: string
      failureSignal: string
      evidence: string[]
      adaptiveConfig: AdaptiveReplanConfig
      anchorText?: string
      patchPrefix: string
      onNodeEnqueued?: (task: MessageV2.SubtaskPart) => Effect.Effect<void, never, never>
    }) {
      if (!input.adaptiveConfig.enabled) return { applied: false as const }

      const currentGraph = replanGraphFromSubtasks(input.subtaskParts)
      const proposal = deriveReplanProposalFromFailure({
        run_id: input.runID,
        source: input.source,
        failed_task_id: input.failedTaskID,
        failed_agent: input.failedAgent,
        failure_signal: input.failureSignal,
        normalized_graph: currentGraph,
        completed_task_ids: input.completedTaskIDs,
        intent_anchor: input.anchorText,
        evidence: input.evidence,
      })
      const patch = deriveTaskGraphPatchFromReplanProposal(proposal, currentGraph, input.completedTaskIDs, {
        minConfidence: input.adaptiveConfig.minConfidence,
      })
      if (!patch) {
        return {
          applied: false as const,
          proposal,
        }
      }
      const validation = validateTaskGraphPatch(patch, currentGraph, { completedTaskIDs: input.completedTaskIDs })
      if (!validation.valid) {
        log.warn("adaptive replan patch rejected", {
          sessionID: input.sessionID,
          patch_id: patch.id,
          errors: validation.errors,
          warnings: validation.warnings,
        })
        return {
          applied: false as const,
          proposal,
          patch,
          patchWarnings: validation.warnings,
        }
      }

      const applied = applyTaskGraphPatch(currentGraph, patch, { completedTaskIDs: input.completedTaskIDs })
      if (!applied.applied) {
        return {
          applied: false as const,
          proposal,
          patch,
          patchWarnings: applied.warnings,
        }
      }
      const affected = collectRepairSubtree(applied.graph, applied.affectedTaskIDs)
      const limited = affected.nodes.slice(0, Math.max(1, input.adaptiveConfig.maxPatchNodes))
      if (limited.length === 0) {
        return {
          applied: false as const,
          proposal,
          patch,
          patchWarnings: [...applied.warnings, "adaptive patch produced empty affected subtree"],
        }
      }

      const enqueueResult = yield* enqueueTaskGraph({
        sessionID: input.sessionID,
        parent: input.parent,
        graph: toTaskGraphCandidate({ nodes: limited }),
        intent: input.intent,
        run_id: input.runID,
        intent_anchor_hash: input.intentAnchorHash,
        source_user_message_id: input.sourceUserMessageID,
        model: input.model,
        agent: input.parent.agent,
        prefix: input.patchPrefix,
        plannerGuardActive: true,
        onNodeEnqueued: input.onNodeEnqueued,
      })
      if (!enqueueResult.accepted) {
        return {
          applied: false as const,
          proposal,
          patch,
          patchWarnings: [...applied.warnings, ...(enqueueResult.warnings ?? []), enqueueResult.reason ?? "enqueue rejected"],
        }
      }

      log.info("adaptive replan patch applied", {
        sessionID: input.sessionID,
        patch_id: patch.id,
        source: input.source,
        enqueued: enqueueResult.enqueued,
        affected: limited.map((node) => node.id),
      })

      return {
        applied: true as const,
        proposal,
        patch,
        patchWarnings: [...applied.warnings, ...(enqueueResult.warnings ?? [])],
      }
    })

    const enqueueCoderGuardTask = Effect.fn("SessionPrompt.enqueueCoderGuardTask")(function* (input: {
      sessionID: SessionID
      parent: MessageV2.User
      run_id: string
      intent_anchor_hash: string
      source_user_message_id: MessageID
      model: { providerID: ProviderID; modelID: ModelID; variant?: string }
      userText: string
      blockedTester?: MessageV2.SubtaskPart
      reason: string
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
      const task: MessageV2.SubtaskPart = {
        id: PartID.ascending(),
        messageID: message.id,
        sessionID: input.sessionID,
        type: "subtask",
        task_role: "coder",
        task_id: `guard_coder:${message.id}`,
        run_id: input.run_id,
        intent_anchor_hash: input.intent_anchor_hash,
        source_user_message_id: input.source_user_message_id,
        blocked_by: [],
        needs_research: false,
        tags: ["impl", "coder-guard"],
        description: input.blockedTester
          ? `Implement before tests: ${input.blockedTester.description}`.slice(0, 140)
          : "Implement requested code changes",
        agent: roleAgent("coder"),
        model: { providerID: input.model.providerID, modelID: input.model.modelID },
        prompt: [
          "<task role=\"coder\" id=\"guard_coder\">",
          "Implement the required code changes before running tester validation.",
          `Reason: ${input.reason}`,
          input.userText ? `Original user request: ${input.userText}` : "",
          input.blockedTester ? `Blocked tester task: ${input.blockedTester.description}` : "",
          "If implementation already exists, verify implementation completeness and list concrete files/functions touched.",
          "</task>",
        ]
          .filter((line) => line.length > 0)
          .join("\n"),
      }
      yield* sessions.updatePart(task)
      return task
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
        let plannerGraphRetries = 0
        let adaptivePatchRounds = 0
        let writerRan = false
        let writerFinalizerStarted = false
        let writerFinalizerCompleted = false
        let writerFinalizerFailed = false
        let reviewerRepairStatusShown = false
        let skipChangelogAndProjectLesson = false
        let skipGlobalResearchLesson = false
        let runID: string | undefined
        let runIntentAnchorHash: string | undefined
        let runSourceUserMessageID: MessageID | undefined
        const rememberedUserMessageIDs = new Set<string>()
        const researchDrafts: Array<{
          topic: string
          lesson: string
          detail: string
          fix: string
          tags: string[]
        }> = []
        const session = yield* sessions.get(sessionID).pipe(Effect.orDie)
        const projectRoot = ctx.worktree && ctx.worktree !== "/" ? ctx.worktree : ctx.directory
        const memoryRuntime = new MemoryRuntime({ projectRoot })
        let runWorktreeContext: WorktreeContext | undefined
        const coderTaskTargetAllowlist = new Map<string, string[]>()
        const coderApplyResults = new Map<string, ApplyResult>()
        const postApplyActualOutputPaths = new Set<string>()
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => cleanupWorktree(runWorktreeContext)).pipe(Effect.orElseSucceed(() => undefined)),
        )
        const schedulerTodos = new Map<string, SchedulerTodoItem>()
        const reviewerSuspendedForRepair = new Set<string>()
        const schedulerTodoSyncLock = Semaphore.makeUnsafe(1)
        let schedulerTodoOrder = 0
        const cappedFailureCategories = new Set<SubtaskFailureCategory>([
          "wrong_path",
          "stale_artifact",
          "tool_unavailable",
          "tool_schema_error",
          "tool_call_invalid",
          "file_write_verification_failed",
        ])
        const subtaskFailureCounters = new Map<
          string,
          {
            category: SubtaskFailureCategory
            count: number
            reason: string
            structured?: StructuredFailureSignal
          }
        >()
        const subtaskFailureCapHandled = new Set<string>()
        const handledInterruptionStatusMessages = new Set<string>()

        const taskBelongsToCurrentRun = (task: MessageV2.SubtaskPart) =>
          !!(
            runID &&
            runIntentAnchorHash &&
            runSourceUserMessageID &&
            task.run_id === runID &&
            task.intent_anchor_hash === runIntentAnchorHash &&
            task.source_user_message_id === runSourceUserMessageID
          )

        const taskTodoKey = (task: MessageV2.SubtaskPart) => {
          if (typeof task.task_id === "string" && task.task_id.trim().length > 0) return task.task_id.trim()
          if (typeof task.id === "string" && task.id.trim().length > 0) return task.id.trim()
          return closedLoop.taskKey(task)
        }
        const parseFileWriteEvidencePaths = (metadata: Record<string, unknown> | undefined) =>
          Array.isArray(metadata?.file_write_evidence)
            ? metadata.file_write_evidence
                .flatMap((entry) => {
                  if (!entry || typeof entry !== "object") return []
                  const filePath = (entry as Record<string, unknown>).file_path
                  return typeof filePath === "string" && filePath.trim().length > 0 ? [filePath.trim()] : []
                })
                .filter(Boolean)
            : []
        const runtimeActualOutputPaths = (fallback: string[]) =>
          postApplyActualOutputPaths.size > 0 ? [...postApplyActualOutputPaths] : fallback
        const ensureRunWorktreeContext = Effect.fn("SessionPrompt.ensureRunWorktreeContext")(function* () {
          if (!runID) return
          const ensuredRunID = runID
          if (runWorktreeContext?.run_id === runID) return
          yield* Effect.promise(() => cleanupWorktree(runWorktreeContext)).pipe(Effect.orElseSucceed(() => undefined))
          runWorktreeContext = yield* Effect.promise(() => createRunWorktree({ runID: ensuredRunID, projectRoot }))
        })
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
        const formatStructuredCoderFailure = (input: {
          task: MessageV2.SubtaskPart
          failureInfo?: SubtaskFailureInfo
        }) => {
          const category: SubtaskFailureCategory = input.failureInfo?.category ?? "unknown"
          const structured = input.failureInfo?.structured
          const requiredPaths = structured?.required_paths ?? []
          const fallbackPaths = structured?.fallback_paths ?? structured?.allowed_fallback_paths ?? []
          const allowedFallbackPaths = structured?.allowed_fallback_paths ?? fallbackPaths
          const actualOutputPaths = structured?.actual_output_paths ?? []
          const forbiddenPathsSeen = structured?.forbidden_paths_seen ?? []
          const toolName = structured?.tool_name
          const errorCategory = structured?.error_category
          const missingField = structured?.missing_field
          const filePath = structured?.file_path
          const expectedFragment = structured?.expected_fragment
          const readbackFragment = structured?.readback_fragment
          const repairInstruction =
            structured?.repair_instruction ??
            (category === "tool_schema_error"
              ? "use correct write tool schema or fallback to shell redirection only if allowed (and only within allowed paths)"
              : category === "tool_call_invalid"
                ? "use only registered tools"
                : category === "file_write_verification_failed"
                  ? "retry write/edit and verify file content with readback"
                  : "Retry implementation using only required_paths or runtime-provided absolute fallback_paths; do not reuse stale workspace artifacts.")
          const payload = {
            category,
            task_id: input.task.task_id ?? closedLoop.taskKey(input.task),
            required_paths: requiredPaths,
            fallback_paths: fallbackPaths,
            allowed_fallback_paths: allowedFallbackPaths,
            actual_output_paths: actualOutputPaths,
            forbidden_paths_seen: forbiddenPathsSeen,
            tool_name: toolName,
            error_category: errorCategory,
            missing_field: missingField,
            file_path: filePath,
            expected_fragment: expectedFragment,
            readback_fragment: readbackFragment,
            repair_instruction: repairInstruction,
          }
          const signalText = JSON.stringify(payload)
          return {
            payload,
            signalText,
          }
        }
        const emitCoderRepairRetryPrompt = Effect.fn("SessionPrompt.emitCoderRepairRetryPrompt")(function* (input: {
          task: MessageV2.SubtaskPart
          failureInfo?: SubtaskFailureInfo
          rounds: number
          actor: { agent: string; model: MessageV2.User["model"] }
        }) {
          const retry: MessageV2.User = {
            id: MessageID.ascending(),
            sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: input.actor.agent,
            model: input.actor.model,
          }
          yield* sessions.updateMessage(retry)
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: retry.id,
            sessionID,
            type: "text",
            synthetic: true,
            text:
              input.failureInfo?.category === "tool_unavailable"
                ? `${TERMINAL_FAILURE_PREFIX}当前 shell 工具暂不可用，请检查环境后重试。`
                : input.failureInfo?.category === "tool_schema_error"
                  ? RECOVERABLE_FAILURE_MESSAGES.toolFormat
                  : input.failureInfo?.category === "tool_call_invalid"
                    ? RECOVERABLE_FAILURE_MESSAGES.toolFormat
                    : input.failureInfo?.category === "file_write_verification_failed"
                      ? RECOVERABLE_FAILURE_MESSAGES.fileWriteVerification
                : input.rounds >= 2
                  ? RECOVERABLE_FAILURE_MESSAGES.default
                  : RECOVERABLE_FAILURE_MESSAGES.wrongPath,
          } satisfies MessageV2.TextPart)
        })
        const emitReviewerRepairStatus = Effect.fn("SessionPrompt.emitReviewerRepairStatus")(function* (input: {
          actor: { agent: string; model: MessageV2.User["model"] }
        }) {
          if (reviewerRepairStatusShown) return
          reviewerRepairStatusShown = true
          const statusMessage: MessageV2.User = {
            id: MessageID.ascending(),
            sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: input.actor.agent,
            model: input.actor.model,
          }
          yield* sessions.updateMessage(statusMessage)
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: statusMessage.id,
            sessionID,
            type: "text",
            synthetic: true,
            text: RECOVERABLE_FAILURE_MESSAGES.reviewFailed,
          } satisfies MessageV2.TextPart)
        })
        const suspendReviewerTaskForRepair = Effect.fn("SessionPrompt.suspendReviewerTaskForRepair")(function* (input: {
          task: MessageV2.SubtaskPart
          reason: string
        }) {
          const key = closedLoop.taskKey(input.task)
          if (reviewerSuspendedForRepair.has(key)) return
          reviewerSuspendedForRepair.add(key)
          yield* upsertSchedulerTodo({
            key: taskTodoKey(input.task),
            content: `[SKIPPED] ${input.task.description}`,
            status: "failed",
            taskRole: input.task.task_role,
            taskID: input.task.task_id ?? key,
          })
          yield* slog.info("suspending failed reviewer task until repair flow completes", {
            task_id: input.task.task_id ?? key,
            reason: input.reason,
          })
        })
        const onAdaptivePatchNodeEnqueued = (task: MessageV2.SubtaskPart) =>
          upsertSchedulerTodo({
            key: taskTodoKey(task),
            content: task.description,
            status: "pending",
            taskRole: task.task_role,
            taskID: task.task_id ?? closedLoop.taskKey(task),
          })
        const recordTrajectoryForSubtask = Effect.fn("SessionPrompt.recordTrajectoryForSubtask")(function* (input: {
          task: MessageV2.SubtaskPart
          result?: { output: string; metadata: Record<string, unknown> }
          outcome: "success" | "failure" | "recovered" | "cancelled" | "skipped"
          quality?: {
            tester_passed?: boolean
            reviewer_approved?: boolean
            selfcheck_passed?: boolean
            artifact_paths_verified?: boolean
            command_success?: boolean
            local_sanity_check?: boolean
            drift_detected?: boolean
          }
          failure?: {
            signal: string
            failed_behavior?: string
            wrong_artifacts?: string[]
            root_cause?: string
          }
          recovery?: {
            repair_action: string
            corrected_artifacts?: string[]
            success_signal: string
          }
          evidence?: string[]
        }) {
          if (!runID || !runSourceUserMessageID || !runIntentAnchorHash) return
          const record = extractTrajectoryEvidenceFromSubtask({
            run_id: runID,
            source_user_message_id: String(runSourceUserMessageID),
            intent_anchor_hash: runIntentAnchorHash,
            task: {
              id: input.task.id,
              task_id: input.task.task_id,
              task_role: input.task.task_role,
              agent: input.task.agent,
              description: input.task.description,
              prompt: input.task.prompt,
            },
            output: input.result?.output,
            metadata: input.result?.metadata ?? {},
            outcome: input.outcome,
            quality_signals: input.quality ?? {},
            failure: input.failure,
            recovery: input.recovery,
            evidence_refs: input.evidence,
          })
          yield* closedLoop.recordTrajectory({ sessionID, record }).pipe(Effect.orElseSucceed(() => undefined))
        })
        const emitActiveRunInterruptionReply = Effect.fn("SessionPrompt.emitActiveRunInterruptionReply")(function* (input: {
          parent: MessageV2.User
          action: Exclude<ActiveRunInterruptionAction, "none">
          text: string
        }) {
          const msg: MessageV2.Assistant = {
            id: MessageID.ascending(),
            parentID: input.parent.id,
            role: "assistant",
            mode: input.parent.agent,
            agent: input.parent.agent,
            variant: input.parent.model.variant,
            path: { cwd: ctx.directory, root: ctx.worktree },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: input.parent.model.modelID,
            providerID: input.parent.model.providerID,
            time: { created: Date.now(), completed: Date.now() },
            finish: "stop",
            sessionID,
          }
          yield* sessions.updateMessage(msg)
          const textPart = yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: msg.id,
            sessionID,
            type: "text",
            text: interruptionReplyText({
              action: input.action,
              languageCode: LanguageRule.detectLanguage(input.text).code,
            }),
          })
          return { info: msg, parts: [textPart] } satisfies MessageV2.WithParts
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
          const allSubtaskParts = msgs.flatMap((msg) =>
            msg.parts.filter((part): part is MessageV2.SubtaskPart => part.type === "subtask"),
          )

          if (!lastUser) throw new Error("No user message found in stream. This should never happen.")
          let currentRequest = getCurrentUserRequest(msgs, lastUser.id)
          const latestUserMessage = currentRequest?.message ?? getLatestUserMessage(msgs)
          let latestUserText = currentRequest?.text ?? ""
          let latestIntentUserMessage = currentRequest?.message
          let intentSourceText = currentRequest?.text ?? ""
          let executionIntent = classifyTaskExecutionIntent(intentSourceText)

          const lastAssistantMsg = msgs.findLast(
            (msg) => msg.info.role === "assistant" && msg.info.id === lastAssistant?.id,
          )
          const activeRunForExitGuard = yield* closedLoop.activeRun(sessionID)
          const completedForExitGuard =
            activeRunForExitGuard?.status === "active" ? yield* closedLoop.listCompletedSubtasks(sessionID) : []
          const hasTaggedSubtasksForExitGuard = allSubtaskParts.some(
            (task) => !!task.run_id || !!task.intent_anchor_hash || !!task.source_user_message_id,
          )
          const explicitlySkippedForExitGuard = new Set(
            [...schedulerTodos.values()].flatMap((todo) =>
              todo.status === "failed" &&
              typeof todo.taskID === "string" &&
              todo.content.trim().startsWith("[SKIPPED]")
                ? [todo.taskID]
                : [],
            ),
          )
          const hasPendingRequiredNonWriterTasks =
            activeRunForExitGuard?.status === "active" &&
            allSubtaskParts.some((task) => {
              if (task.task_role === "planner" || task.task_role === "writer") return false
              const matchesActiveRun =
                task.run_id === activeRunForExitGuard.run_id &&
                task.intent_anchor_hash === activeRunForExitGuard.intent_anchor_hash &&
                task.source_user_message_id === activeRunForExitGuard.source_message_id
              const adoptableLegacyTask =
                !hasTaggedSubtasksForExitGuard && !task.run_id && !task.intent_anchor_hash && !task.source_user_message_id
              if (!matchesActiveRun && !adoptableLegacyTask) return false
              const taskKey = closedLoop.taskKey(task)
              return !completedForExitGuard.includes(taskKey) && !explicitlySkippedForExitGuard.has(taskKey)
            })
          const activeRunInterruption =
            activeRunForExitGuard?.status === "active" &&
            latestUserMessage &&
            latestUserMessage.info.id !== activeRunForExitGuard.source_message_id
              ? classifyActiveRunInterruption(latestUserText)
              : "none"

          if (activeRunInterruption === "status" && activeRunForExitGuard?.status === "active" && latestUserMessage) {
            const requestFromActiveSource = getCurrentUserRequest(msgs, activeRunForExitGuard.source_message_id)
            if (requestFromActiveSource) {
              currentRequest = requestFromActiveSource
              latestUserText = requestFromActiveSource.text
              latestIntentUserMessage = requestFromActiveSource.message
              intentSourceText = requestFromActiveSource.text
              executionIntent = classifyTaskExecutionIntent(intentSourceText)
            }
            const interruptionMessageID = String(latestUserMessage.info.id)
            if (!handledInterruptionStatusMessages.has(interruptionMessageID)) {
              handledInterruptionStatusMessages.add(interruptionMessageID)
              const reply = yield* emitActiveRunInterruptionReply({
                parent: latestUserMessage.info,
                action: "status",
                text: userTextFromParts(latestUserMessage.parts),
              })
              if (!hasPendingRequiredNonWriterTasks) return reply
            }
          }

          if (
            (activeRunInterruption === "cancel" || activeRunInterruption === "pause") &&
            activeRunForExitGuard?.status === "active" &&
            latestUserMessage
          ) {
            if (activeRunInterruption === "cancel") {
              yield* closedLoop.cancelRun({ sessionID, run_id: activeRunForExitGuard.run_id }).pipe(
                Effect.orElseSucceed(() => undefined),
              )
            }
            return yield* emitActiveRunInterruptionReply({
              parent: latestUserMessage.info,
              action: activeRunInterruption,
              text: userTextFromParts(latestUserMessage.parts),
            })
          }

          if (activeRunInterruption === "replan" && activeRunForExitGuard?.status === "active") {
            yield* closedLoop.cancelRun({ sessionID, run_id: activeRunForExitGuard.run_id }).pipe(
              Effect.orElseSucceed(() => undefined),
            )
            yield* closedLoop.requestIntentAnchorRefresh(sessionID).pipe(Effect.orElseSucceed(() => undefined))
          }
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
            !hasPendingRequiredNonWriterTasks &&
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

          const runtimeConfig = yield* config.get()
          const providerRoutingConfig = runtimeConfig.experimental?.provider_routing
          const adaptiveReplanConfig = resolveAdaptiveReplanConfig(runtimeConfig.experimental?.adaptive_replan)
          const projectRoot = ctx.worktree && ctx.worktree !== "/" ? ctx.worktree : ctx.directory
          const telemetryStoreResolved = resolveProviderTelemetryStore({
            routingEnabled: providerRoutingConfig?.enabled === true,
            telemetry: providerRoutingConfig?.telemetry,
            projectRoot,
          })
          if (telemetryStoreResolved.warnings.length > 0) {
            log.debug("provider telemetry warnings", {
              sessionID,
              agent: lastUser.agent,
              warnings: telemetryStoreResolved.warnings,
            })
          }
          const providerRouteDecision: ProviderRouteDecision = providerRoutingConfig?.enabled
            ? yield* Effect.gen(function* () {
                const providerMap = yield* provider
                  .list()
                  .pipe(Effect.orElseSucceed(() => ({} as Record<string, Provider.Info>)))
                const availableProviders = Object.keys(providerMap)
                const availableModels = Object.fromEntries(
                  Object.entries(providerMap).map(([providerID, info]) => [providerID, Object.keys(info.models ?? {})]),
                )
                const decision = resolveProviderRoute({
                  agent: asProviderRouteAgent(lastUser.agent),
                  taskRole: roleForAgent(lastUser.agent),
                  currentProvider: lastUser.model.providerID,
                  currentModel: lastUser.model.modelID,
                  config: providerRoutingConfig,
                  availableProviders,
                  availableModels,
                  healthStore: getDefaultProviderHealthStore(),
                  telemetryStore: telemetryStoreResolved.store,
                  projectRoot,
                })
                if (decision.warnings.length > 0) {
                  log.debug("provider route warnings", {
                    sessionID,
                    agent: lastUser.agent,
                    warnings: decision.warnings,
                  })
                }
                return decision
              })
            : resolveProviderRoute({
                agent: asProviderRouteAgent(lastUser.agent),
                taskRole: roleForAgent(lastUser.agent),
                currentProvider: lastUser.model.providerID,
                currentModel: lastUser.model.modelID,
                config: providerRoutingConfig,
                healthStore: getDefaultProviderHealthStore(),
                telemetryStore: telemetryStoreResolved.store,
                projectRoot,
              })
          const routedProvider = providerRouteDecision.selected.provider ?? lastUser.model.providerID
          const routedModel = providerRouteDecision.selected.model ?? lastUser.model.modelID
          const model = yield* getModel(ProviderID.make(routedProvider), ModelID.make(routedModel), sessionID).pipe(
            Effect.catch(() =>
              getModel(lastUser.model.providerID, lastUser.model.modelID, sessionID).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    if (!providerRouteDecision.enabled) return
                    log.debug("provider route fallback to current model after model resolution failure", {
                      sessionID,
                      agent: lastUser.agent,
                      provider_route_decision: providerRouteDecisionMetadata(providerRouteDecision),
                    })
                  }),
                ),
              ),
            ),
          )
          let anchor = yield* closedLoop.resolveIntentAnchor({ sessionID, messages: msgs })
          if (
            latestIntentUserMessage &&
            latestIntentUserMessage.info.role === "user" &&
            anchor?.source_message_id !== latestIntentUserMessage.info.id
          ) {
            yield* closedLoop.requestIntentAnchorRefresh(sessionID).pipe(Effect.orElseSucceed(() => undefined))
            const refreshed = yield* closedLoop.resolveIntentAnchor({ sessionID, messages: msgs })
            if (refreshed) anchor = refreshed
          }
          sessionAnchor = anchor ?? sessionAnchor
          const runSourceMessageID =
            latestIntentUserMessage && latestIntentUserMessage.info.role === "user"
              ? latestIntentUserMessage.info.id
              : lastUser.id
          const runAnchorText = (anchor?.text ?? intentSourceText).trim()
          const nextRunHash = intentAnchorHash(runAnchorText)
          if (
            !runID &&
            activeRunForExitGuard?.status === "active" &&
            activeRunForExitGuard.source_message_id === runSourceMessageID &&
            activeRunForExitGuard.intent_anchor_hash === nextRunHash
          ) {
            runID = activeRunForExitGuard.run_id
            runIntentAnchorHash = activeRunForExitGuard.intent_anchor_hash
            runSourceUserMessageID = activeRunForExitGuard.source_message_id
          }
          if (
            !runID ||
            !runIntentAnchorHash ||
            !runSourceUserMessageID ||
            runSourceUserMessageID !== runSourceMessageID ||
            runIntentAnchorHash !== nextRunHash
          ) {
            runID = ulid()
            runIntentAnchorHash = nextRunHash
            runSourceUserMessageID = runSourceMessageID
            writerRan = false
            writerFinalizerStarted = false
            writerFinalizerCompleted = false
            writerFinalizerFailed = false
            reviewerRepairStatusShown = false
            skipChangelogAndProjectLesson = false
            skipGlobalResearchLesson = false
            plannerSeeded = false
            reviewerRounds = 0
            plannerViolationRetries = 0
            plannerGraphRetries = 0
            schedulerTodos.clear()
            reviewerSuspendedForRepair.clear()
            schedulerTodoOrder = 0
            subtaskFailureCounters.clear()
            subtaskFailureCapHandled.clear()
            reviewerDecisionInfo.clear()
            testerDecisionInfo.clear()
            researchDrafts.length = 0
            coderTaskTargetAllowlist.clear()
            coderApplyResults.clear()
            postApplyActualOutputPaths.clear()
            yield* Effect.promise(() => cleanupWorktree(runWorktreeContext)).pipe(Effect.orElseSucceed(() => undefined))
            runWorktreeContext = undefined
            yield* closedLoop.startRun({
              sessionID,
              run_id: runID,
              source_message_id: runSourceMessageID,
              intent_anchor_hash: runIntentAnchorHash,
            })
            yield* ensureRunWorktreeContext()
            yield* syncSchedulerTodos()
          }
          if (!runID || !runIntentAnchorHash || !runSourceUserMessageID) {
            throw new Error("run identity missing after initialization")
          }
          const rawSubtaskParts = allSubtaskParts
          const hasTaggedSubtasks = rawSubtaskParts.some(
            (task) => !!task.run_id || !!task.intent_anchor_hash || !!task.source_user_message_id,
          )
          const subtaskParts = rawSubtaskParts.flatMap((task) => {
            if (taskBelongsToCurrentRun(task)) return [task]
            if (!task.run_id && !task.intent_anchor_hash && !task.source_user_message_id && !hasTaggedSubtasks) {
              log.warn("adopting legacy subtask into current run", {
                sessionID,
                task_id: task.task_id ?? task.id,
                task_role: task.task_role,
                run_id: runID,
              })
              return [
                {
                  ...task,
                  run_id: runID,
                  intent_anchor_hash: runIntentAnchorHash,
                  source_user_message_id: runSourceUserMessageID,
                } satisfies MessageV2.SubtaskPart,
              ]
            }
            if (!task.run_id && !task.intent_anchor_hash && !task.source_user_message_id) {
              log.warn("dropping legacy subtask without run identity", {
                sessionID,
                task_id: task.task_id ?? task.id,
                task_role: task.task_role,
              })
              return []
            }
            log.warn("dropping subtask due to run identity mismatch", {
              sessionID,
              task_id: task.task_id ?? task.id,
              task_role: task.task_role,
              task_run_id: task.run_id,
              task_intent_anchor_hash: task.intent_anchor_hash,
              task_source_user_message_id: task.source_user_message_id,
              run_id: runID,
              run_intent_anchor_hash: runIntentAnchorHash,
              run_source_user_message_id: runSourceUserMessageID,
            })
            return []
          })
          if (subtaskParts.length === 0 && !plannerSeeded) {
            const plannerAgent = yield* agents.get("planner")
            if (plannerAgent && shouldForceTaskGraph({ agent: lastUser.agent, text: latestUserText })) {
              if (
                latestIntentUserMessage &&
                runSourceUserMessageID &&
                latestIntentUserMessage.info.id !== runSourceUserMessageID
              ) {
                log.warn("planner seed blocked: current request message id mismatches active run source", {
                  sessionID,
                  latest_user_message_id: latestIntentUserMessage.info.id,
                  run_source_user_message_id: runSourceUserMessageID,
                  run_id: runID,
                })
                continue
              }
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
                run_id: runID,
                intent_anchor_hash: runIntentAnchorHash,
                source_user_message_id: runSourceUserMessageID,
                blocked_by: [],
                tags: ["taskgraph", "orchestrator"],
                description: "Build TaskGraph",
                agent: plannerAgent.name,
                model: { providerID: model.providerID, modelID: model.id },
                prompt: [
                  "Build an executable TaskGraph for this request.",
                  "This is mandatory for non-trivial requests.",
                  `Intent anchor: ${runAnchorText}`,
                  "Return JSON only with {nodes:[...]} and include task_role on every node.",
                  "Use execution roles only: coder/tester/research/reviewer/writer.",
                  'blockedBy must always be an array (for example: ["impl"], ["impl","test_impl"]).',
                  'tags must always be an array (for example: ["python"], ["test","asyncio"]).',
                  'Forbidden JSON: `"blockedBy": "impl", "test_impl"` and `"tags": "python", "asyncio"`.',
                  "User numbered steps are not TaskGraph node boundaries.",
                  "TaskGraph nodes must represent work packages, not shell/file operation steps.",
                  "Do not emit operation-step coder nodes such as create_dir/generate_file/merge_file/write_metadata/run_command.",
                  "Do not split one cohesive artifact family into linear coder steps like create_dir -> generate_file -> merge_file -> write_metadata -> run_check.",
                  "TLS/cert artifact-family anti-pattern: create_dir -> generate_key -> generate_cert -> create_pem -> write_verification.",
                  "TLS/cert artifact-family preferred split: coder_cert_artifacts (dir/key/cert/pem/verification.txt) + coder_check_script (check_cert.py).",
                  "Group dependent operations into one coder package when they share one artifact family and do not provide meaningful parallelism.",
                  "Create separate coder nodes only when deliverables are independent (for example: core vs adapter/script, backend vs frontend, schema/config vs business logic, independent modules).",
                  "Use 2-5 coder nodes only when independent work packages exist; a simple cohesive artifact family can be one coder node.",
                  "Only add research when needed. If coder can directly do a simple, clearly specified edit, skip separate research.",
                  "If coder depends on research findings (for example identify/find/locate/determine/investigate first, then fix/use findings/based on findings/after locating), coder must blockedBy that research node.",
                  "Background-only research that coder does not depend on may run in parallel.",
                  "Prefer work packages (core logic, integration/wiring, adapter/wrapper, validation, config/schema, docs/examples, edge handling) over linear action steps.",
                  "Avoid linear operation-step decomposition like create_dir -> create_file -> write_logic -> verify unless there is hard dependency.",
                  "Tester owns final requirement verification; reviewer owns acceptance review.",
                  "Coder may run local sanity checks but must not be used as final verifier/acceptance role.",
                  "Keep coder nodes parallel with blockedBy: [] when interface/path/function/file contracts allow independent work.",
                  "Do not output markdown, prose, or explanation text.",
                  "",
                  "User request:",
                  latestUserText,
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
              (task) =>
                task.task_role !== "writer" &&
                !completed.includes(closedLoop.taskKey(task)) &&
                !(task.task_role === "reviewer" && reviewerSuspendedForRepair.has(closedLoop.taskKey(task))),
            )
            const coderTasks = subtaskParts.filter((task) => task.task_role === "coder")
            const completedCoderCount = coderTasks.filter((task) => completed.includes(closedLoop.taskKey(task))).length
            const hasAllCodersCompleted = coderTasks.length > 0 && completedCoderCount === coderTasks.length
            const hasPendingCoder = pending.some((task) => task.task_role === "coder")
            const pendingTester = pending.find((task) => task.task_role === "tester")
            const requireCoderBeforeTester =
              executionIntent.requiresImplementation && !executionIntent.allowsTesterOnly && !executionIntent.researchOnly
            if (requireCoderBeforeTester && !hasAllCodersCompleted && pendingTester && !hasPendingCoder) {
              const guardTask = yield* enqueueCoderGuardTask({
                sessionID,
                parent: lastUser,
                run_id: runID,
                intent_anchor_hash: runIntentAnchorHash,
                source_user_message_id: runSourceUserMessageID,
                model: lastUser.model,
                userText: latestUserText,
                blockedTester: pendingTester,
                reason: "tester task was queued before any coder implementation task",
              })
              yield* upsertSchedulerTodo({
                key: taskTodoKey(guardTask),
                content: guardTask.description,
                status: "pending",
                taskRole: guardTask.task_role,
                taskID: guardTask.task_id ?? closedLoop.taskKey(guardTask),
              })
              continue
            }
            for (const task of subtaskParts) {
              if (task.task_role === "writer") continue
              const suspendedReviewer = task.task_role === "reviewer" && reviewerSuspendedForRepair.has(closedLoop.taskKey(task))
              yield* upsertSchedulerTodo({
                key: taskTodoKey(task),
                content: suspendedReviewer ? `[SKIPPED] ${task.description}` : task.description,
                status: suspendedReviewer ? "failed" : completed.includes(closedLoop.taskKey(task)) ? "completed" : "pending",
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

              let readyTasks = layers.layers[0] ?? []
              const requireCoderBeforeTester =
                executionIntent.requiresImplementation && !executionIntent.allowsTesterOnly && !executionIntent.researchOnly
              if (requireCoderBeforeTester && !hasAllCodersCompleted) {
                const testerOnlyLayer = readyTasks.length > 0 && readyTasks.every((task) => task.task_role === "tester")
                if (testerOnlyLayer) {
                  const blockedTester = readyTasks[0]
                  if (!blockedTester) continue
                  const guardTask = yield* enqueueCoderGuardTask({
                    sessionID,
                    parent: lastUser,
                    run_id: runID,
                    intent_anchor_hash: runIntentAnchorHash,
                    source_user_message_id: runSourceUserMessageID,
                    model: lastUser.model,
                    userText: latestUserText,
                    blockedTester,
                    reason: "tester became runnable before coder completion",
                  })
                  yield* upsertSchedulerTodo({
                    key: taskTodoKey(guardTask),
                    content: guardTask.description,
                    status: "pending",
                    taskRole: guardTask.task_role,
                    taskID: guardTask.task_id ?? closedLoop.taskKey(guardTask),
                  })
                  continue
                }
                if (hasPendingCoder) {
                  readyTasks = readyTasks.filter((task) => task.task_role !== "tester")
                  if (readyTasks.length === 0) continue
                }
              }
              const unresolvedCoderApplyTasks = coderTasks.filter((coderTask) => {
                const coderKey = closedLoop.taskKey(coderTask)
                if (!coderTaskTargetAllowlist.has(coderKey)) return false
                const apply = coderApplyResults.get(coderKey)
                return !apply || !apply.ok
              })
              if (unresolvedCoderApplyTasks.length > 0) {
                readyTasks = readyTasks.filter((task) => task.task_role !== "tester" && task.task_role !== "reviewer")
                if (readyTasks.length === 0) continue
              }
              const cappedReadyTasks = readyTasks.filter((task) => {
                const state = subtaskFailureCounters.get(closedLoop.taskKey(task))
                if (!state) return false
                return cappedFailureCategories.has(state.category) && state.count >= 2
              })
              if (cappedReadyTasks.length > 0) {
                for (const cappedTask of cappedReadyTasks) {
                  const cappedKey = closedLoop.taskKey(cappedTask)
                  const counter = subtaskFailureCounters.get(cappedKey)
                  if (!counter) continue
                  const capMarker = `${cappedKey}:${counter.category}`
                  if (subtaskFailureCapHandled.has(capMarker)) continue
                  subtaskFailureCapHandled.add(capMarker)
                  const failureInfo: SubtaskFailureInfo = {
                    category: counter.category,
                    reason: counter.reason,
                    structured: counter.structured,
                    displayMessage: toUserFacingFailureMessage({
                      category: counter.category,
                      reason: counter.reason,
                    }),
                  }
                  const signal = formatStructuredCoderFailure({ task: cappedTask, failureInfo })
                  yield* upsertSchedulerTodo({
                    key: taskTodoKey(cappedTask),
                    content: `[SKIPPED] ${cappedTask.description}`,
                    status: "failed",
                    taskRole: cappedTask.task_role,
                    taskID: cappedTask.task_id ?? closedLoop.taskKey(cappedTask),
                  })
                  if (adaptiveReplanConfig.enabled) {
                    yield* enqueueAdaptiveReplanPatch({
                      sessionID,
                      parent: lastUser,
                      subtaskParts,
                      completedTaskIDs: completed,
                      runID: runID ?? "run:unknown",
                      intentAnchorHash: runIntentAnchorHash ?? "intent:unknown",
                      sourceUserMessageID: runSourceUserMessageID ?? lastUser.id,
                      model: lastUser.model,
                      intent: executionIntent,
                      source: "selfcheck",
                      failedTaskID: cappedTask.task_id ?? closedLoop.taskKey(cappedTask),
                      failedAgent: cappedTask.agent,
                      failureSignal: signal.signalText,
                      evidence: [cappedTask.description, counter.reason],
                      adaptiveConfig: adaptiveReplanConfig,
                      anchorText: sessionAnchor?.text,
                      patchPrefix: `adaptive_patch_${++adaptivePatchRounds}`,
                      onNodeEnqueued: onAdaptivePatchNodeEnqueued,
                    }).pipe(Effect.orElseSucceed(() => ({ applied: false as const })))
                  } else {
                    yield* emitCoderRepairRetryPrompt({
                      task: cappedTask,
                      failureInfo,
                      rounds: counter.count,
                      actor: { agent: lastUser.agent, model: lastUser.model },
                    })
                  }
                }
                readyTasks = readyTasks.filter((task) => {
                  const state = subtaskFailureCounters.get(closedLoop.taskKey(task))
                  if (!state) return true
                  return !(cappedFailureCategories.has(state.category) && state.count >= 2)
                })
                if (readyTasks.length === 0) continue
              }
              const coderReady = readyTasks.filter((task) => task.task_role === "coder")
              const testerReady = readyTasks.filter((task) => task.task_role === "tester")
              const reviewerReady = readyTasks.filter((task) => task.task_role === "reviewer")
              const researchReady = readyTasks.filter((task) => task.task_role === "research")
              const plannerReady = readyTasks.filter((task) => task.task_role === "planner")
              const otherReady = readyTasks.filter(
                (task) =>
                  task.task_role !== "coder" &&
                  task.task_role !== "tester" &&
                  task.task_role !== "reviewer" &&
                  task.task_role !== "research" &&
                  task.task_role !== "planner",
              )
              const dispatchBatch = [
                ...coderReady.slice(0, SCHEDULER_CODER_MAX_CONCURRENCY),
                ...researchReady,
                ...plannerReady.slice(0, 1),
                ...testerReady.slice(0, SCHEDULER_TESTER_MAX_CONCURRENCY),
                ...reviewerReady.slice(0, SCHEDULER_REVIEWER_MAX_CONCURRENCY),
                ...otherReady,
              ]
              if (dispatchBatch.length === 0) continue
              const layerResults = yield* Effect.forEach(
                dispatchBatch,
                Effect.fnUntraced(function* (task) {
                  const inActiveRun = yield* closedLoop.isTaskInActiveRun({
                    sessionID,
                    run_id: task.run_id,
                    intent_anchor_hash: task.intent_anchor_hash,
                    source_user_message_id: task.source_user_message_id,
                  })
                  if (!inActiveRun) {
                    log.warn("skipping subtask outside active run", {
                      sessionID,
                      task_id: task.task_id ?? task.id,
                      task_role: task.task_role,
                      task_run_id: task.run_id,
                      task_intent_anchor_hash: task.intent_anchor_hash,
                      task_source_user_message_id: task.source_user_message_id,
                    })
                    yield* setSchedulerTodoStatus({ task, status: "failed" })
                    yield* recordTrajectoryForSubtask({
                      task,
                      outcome: "skipped",
                      evidence: ["skipped: task identity does not match active run"],
                    })
                    return { task, result: undefined, completedKey: closedLoop.taskKey(task), skipped: true }
                  }
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
                  let skipCoderExecutionReason: string | undefined
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
                  if (taskRole === "coder") {
                    const requiredPathsForRun = resolveCoderRequiredPathsForTask(nextTask)
                    const requiredTargetPaths = ensureAbsolutePathList(requiredPathsForRun, { cwd: projectRoot })
                    const taskKey = closedLoop.taskKey(task)
                    let coderPathContext: PathContext
                    if (requiredTargetPaths.length > 0) {
                      yield* ensureRunWorktreeContext()
                      if (runWorktreeContext) {
                        const sandboxRequiredPaths = requiredTargetPaths.map((targetPath) =>
                          mapTargetPathToSandbox(runWorktreeContext!, targetPath),
                        )
                        coderTaskTargetAllowlist.set(taskKey, requiredTargetPaths)
                        coderPathContext = createPathContext({
                          requiredPaths: requiredPathsForRun,
                          targetPaths: requiredTargetPaths,
                          sandboxPaths: sandboxRequiredPaths,
                          fallbackPaths: [],
                          actualOutputPaths: [],
                          projectRoot: runWorktreeContext.sandbox_root,
                          forbiddenRoots: ["/", projectRoot],
                        })
                        nextTask = {
                          ...nextTask,
                          prompt: [
                            nextTask.prompt,
                            "",
                            "<worktree_context>",
                            `run_id: ${runID}`,
                            `sandbox_root: ${runWorktreeContext.sandbox_root}`,
                            `working_directory: ${runWorktreeContext.sandbox_root}`,
                            `target_paths: ${requiredTargetPaths.join(", ")}`,
                            `sandbox_paths: ${sandboxRequiredPaths.join(", ")}`,
                            "You are an execution coder, not a tutorial writer.",
                            "Worktree execution requirement: create/modify current-run files at sandbox_paths now using tools.",
                            "Do not merely describe commands, scripts, or tutorials.",
                            "Do not claim completion with 'after running this script/command'.",
                            "Script-only output is not completion unless the task explicitly asks for script-only artifact output.",
                            "Write only sandbox_paths; do not write outside worktree_context.",
                            "Do not claim target_paths as completed in coder stage. target_paths can be claimed only after apply.",
                            "</worktree_context>",
                          ].join("\n"),
                        }
                      } else {
                        coderPathContext = createPathContext({
                          requiredPaths: requiredTargetPaths,
                          targetPaths: requiredTargetPaths,
                          fallbackPaths: [],
                          actualOutputPaths: [],
                          projectRoot,
                          forbiddenRoots: ["/"],
                        })
                      }
                    } else {
                      const maybeTlsLikePathTask = /\b(tls|ssl|cert|certificate|check[_-]?cert|verification\.txt|server\.(?:key|crt|pem))\b/i.test(
                        `${nextTask.description}\n${nextTask.prompt}\n${(nextTask.tags ?? []).join(" ")}`,
                      )
                      if (maybeTlsLikePathTask) {
                        skipCoderExecutionReason = "path_resolution_failed: unable to resolve target paths for coder task"
                      }
                      coderPathContext = createPathContext({
                        requiredPaths: [],
                        fallbackPaths: [],
                        actualOutputPaths: [],
                        projectRoot,
                        forbiddenRoots: [
                          "/",
                          `${projectRoot}/ssl`,
                          `${projectRoot}/test/certs`,
                          `${projectRoot}/packages/codemate/ssl`,
                        ],
                      })
                    }
                    nextTask = {
                      ...nextTask,
                      prompt: `${nextTask.prompt}\n\n${renderPathContextBlock(coderPathContext)}`,
                    }
                  }
                  if (taskRole === "reviewer") {
                    const trajectoryAll = yield* closedLoop.listTrajectory(sessionID).pipe(Effect.orElseSucceed(() => []))
                    const trajectoryForRun = runID ? filterTrajectoryByRun(trajectoryAll, runID) : []
                    const requiredPathsForRun = extractRequiredPaths(`${nextTask.description}\n${nextTask.prompt}`)
                    const postApplyPaths = runtimeActualOutputPaths(
                      trajectoryForRun
                        .filter((record) => record.agent === "coder")
                        .flatMap((record) => record.artifact_paths),
                    )
                    const sharedPathContext = pathContextFromTrajectory({
                      requiredPaths: requiredPathsForRun.length > 0 ? requiredPathsForRun : [...DEFAULT_REQUIRED_EXECUTION_PATHS],
                      trajectoryArtifactPaths: postApplyPaths,
                      projectRoot,
                      forbiddenRoots: [
                        "/",
                        `${projectRoot}/ssl`,
                        `${projectRoot}/test/certs`,
                        `${projectRoot}/packages/codemate/ssl`,
                      ],
                    })
                    nextTask = {
                      ...nextTask,
                      prompt: `${nextTask.prompt}\n\n${renderPathContextBlock(sharedPathContext)}`,
                    }
                    const tlsEvidence = computeCurrentRunTlsAllowedPaths(trajectoryForRun, postApplyPaths)
                    const evidenceRecords = trajectoryForRun
                      .filter((record) => record.agent === "coder" || record.agent === "tester")
                      .slice(-8)
                    const evidenceArtifacts = [
                      ...new Set(runtimeActualOutputPaths(evidenceRecords.flatMap((record) => record.artifact_paths)).filter((item) => item.trim().length > 0)),
                    ]
                    const evidenceVerification = evidenceRecords
                      .flatMap((record) => record.verification_results)
                      .filter((item) => item.trim().length > 0)
                      .slice(-6)
                    const evidenceSummary = [
                      `Intent anchor: ${sessionAnchor?.text ?? "n/a"}`,
                      `Required paths (contract): ${tlsEvidence.requiredPaths.join(", ")}`,
                      `Fallback paths (contract): ${tlsEvidence.fallbackPaths.join(", ")}`,
                      `Actual output paths (source=trajectory): ${evidenceArtifacts.length > 0 ? evidenceArtifacts.join(", ") : "none"}`,
                      `Current-run verification evidence: ${evidenceVerification.length > 0 ? evidenceVerification.join(" | ") : "none"}`,
                      "Do not treat required/fallback contract paths as actual unless they are listed in actual output paths.",
                      "Review scope binding: review only the current run intent and evidence above.",
                      "Ignore unrelated historical topics (for example README/docs/architecture cleanup) unless they appear in current-run evidence.",
                    ].join("\n")
                    nextTask = {
                      ...nextTask,
                      prompt: `${nextTask.prompt}\n\n<review_binding>\n${evidenceSummary}\n</review_binding>`,
                    }
                  }
                  if (taskRole === "tester") {
                    const trajectoryAll = yield* closedLoop.listTrajectory(sessionID).pipe(Effect.orElseSucceed(() => []))
                    const trajectoryForRun = runID ? filterTrajectoryByRun(trajectoryAll, runID) : []
                    const requiredPathsForRun = extractRequiredPaths(`${nextTask.description}\n${nextTask.prompt}`)
                    const postApplyPaths = runtimeActualOutputPaths(
                      trajectoryForRun
                        .filter((record) => record.agent === "coder")
                        .flatMap((record) => record.artifact_paths),
                    )
                    const sharedPathContext = pathContextFromTrajectory({
                      requiredPaths: requiredPathsForRun.length > 0 ? requiredPathsForRun : [...DEFAULT_REQUIRED_EXECUTION_PATHS],
                      trajectoryArtifactPaths: postApplyPaths,
                      projectRoot,
                      forbiddenRoots: [
                        "/",
                        `${projectRoot}/ssl`,
                        `${projectRoot}/test/certs`,
                        `${projectRoot}/packages/codemate/ssl`,
                      ],
                    })
                    nextTask = {
                      ...nextTask,
                      prompt: `${nextTask.prompt}\n\n${renderPathContextBlock(sharedPathContext)}`,
                    }
                    const currentRunEvidence = computeCurrentRunTlsAllowedPaths(trajectoryForRun, postApplyPaths)
                    const actualOutputPaths = currentRunEvidence.actualOutputPaths
                    const testerBinding = [
                      "Tester evidence binding:",
                      "Verify only actual files from coder trajectory for this run. Do not treat planner-required paths as actual outputs.",
                      "If actual output paths are empty, fail with missing_actual_output_evidence.",
                      "Run check_cert.py only from allowed current-run path.",
                      "Verify server.key permission from allowed current-run path.",
                      "Verify certificate subject/CN/expiry/fingerprint from allowed current-run path.",
                      `Required paths (contract): ${currentRunEvidence.requiredPaths.join(", ")}`,
                      `Fallback paths (contract): ${currentRunEvidence.fallbackPaths.join(", ")}`,
                      `Actual output paths from coder trajectory (test only these): ${actualOutputPaths.length > 0 ? actualOutputPaths.join(", ") : "none"}`,
                      `Allowed current-run paths: ${currentRunEvidence.allowedPaths.join(", ")}`,
                      `Forbidden evidence paths: ${TLS_FORBIDDEN_EVIDENCE_PATHS.join(", ")}`,
                      "If any forbidden evidence path is used, return failure with category stale_test_evidence.",
                    ].join("\n")
                    nextTask = {
                      ...nextTask,
                      prompt: `${nextTask.prompt}\n\n<test_binding>\n${testerBinding}\n</test_binding>`,
                    }
                  }

                  yield* setSchedulerTodoStatus({ task, status: "executing" })
                  let result =
                    task.task_role === "coder" && skipCoderExecutionReason
                      ? undefined
                      : yield* handleSubtask({ task: nextTask, model, lastUser, sessionID, session, msgs })
                  const currentTaskKey = closedLoop.taskKey(task)
                  if (task.task_role === "coder" && skipCoderExecutionReason) {
                    subtaskFailureInfo.set(currentTaskKey, {
                      category: "unknown",
                      reason: skipCoderExecutionReason,
                      displayMessage: "当前子任务路径解析失败，已停止该次尝试。",
                    })
                  }
                  if (task.task_role === "coder" && result) {
                    const allowlistedTargets = coderTaskTargetAllowlist.get(currentTaskKey) ?? []
                    if (allowlistedTargets.length > 0 && runWorktreeContext) {
                      const sandboxOutputs = parseFileWriteEvidencePaths(result.metadata)
                      const applyResult = yield* Effect.promise(() =>
                        applySandboxOutputs({
                          context: runWorktreeContext!,
                          allowlistedTargetPaths: allowlistedTargets,
                          sandboxOutputPaths: sandboxOutputs,
                        }),
                      )
                      coderApplyResults.set(currentTaskKey, applyResult)
                      if (!applyResult.ok) {
                        const reason = `worktree_apply_failed: ${applyResult.reason ?? "unknown"}`
                        subtaskFailureInfo.set(currentTaskKey, {
                          category: "unknown",
                          reason,
                          displayMessage: "当前子任务产物应用失败，已阻止后续验证。",
                        })
                        result = undefined
                      } else {
                        for (const outputPath of applyResult.actual_output_paths) {
                          postApplyActualOutputPaths.add(outputPath)
                        }
                        result = {
                          ...result,
                          metadata: {
                            ...result.metadata,
                            apply_result: applyResult,
                            actual_output_paths: applyResult.actual_output_paths,
                          },
                        }
                      }
                    }
                  }
                  const failureInfo = !result ? subtaskFailureInfo.get(currentTaskKey) : undefined
                  yield* setSchedulerTodoStatus({
                    task,
                    status: result ? "completed" : "failed",
                  })
                  if (result) {
                    subtaskFailureCounters.delete(currentTaskKey)
                    for (const marker of [...subtaskFailureCapHandled]) {
                      if (marker.startsWith(`${currentTaskKey}:`)) subtaskFailureCapHandled.delete(marker)
                    }
                  } else if (failureInfo && cappedFailureCategories.has(failureInfo.category)) {
                    const previous = subtaskFailureCounters.get(currentTaskKey)
                    const nextCount = previous?.category === failureInfo.category ? previous.count + 1 : 1
                    subtaskFailureCounters.set(currentTaskKey, {
                      category: failureInfo.category,
                      count: nextCount,
                      reason: failureInfo.reason,
                      structured: failureInfo.structured,
                    })
                  }
                  if (task.task_role === "tester") {
                    if (!result) {
                      testerDecisionInfo.set(currentTaskKey, {
                        passed: false,
                        category: "tester_failed",
                        failure_signal: "tester task execution failed",
                      })
                      yield* closedLoop
                        .recordFailureEvent({
                          sessionID,
                          run_id: runID,
                          failed_stage: "tester",
                          failed_agent: task.agent,
                          task_id: task.task_id ?? closedLoop.taskKey(task),
                          intent_anchor: sessionAnchor?.text,
                          failure_signal: `tester task execution failed: ${task.description}`,
                          evidence_refs: [task.description],
                        })
                        .pipe(Effect.orElseSucceed(() => undefined))
                      yield* enqueueAdaptiveReplanPatch({
                        sessionID,
                        parent: lastUser,
                        subtaskParts,
                        completedTaskIDs: completed,
                        runID: runID ?? "run:unknown",
                        intentAnchorHash: runIntentAnchorHash ?? "intent:unknown",
                        sourceUserMessageID: runSourceUserMessageID ?? lastUser.id,
                        model: lastUser.model,
                        intent: executionIntent,
                        source: "tester",
                        failedTaskID: task.task_id ?? closedLoop.taskKey(task),
                        failedAgent: task.agent,
                        failureSignal: `tester task execution failed: ${task.description}`,
                        evidence: [task.description],
                        adaptiveConfig: adaptiveReplanConfig,
                        anchorText: sessionAnchor?.text,
                        patchPrefix: `adaptive_patch_${++adaptivePatchRounds}`,
                        onNodeEnqueued: onAdaptivePatchNodeEnqueued,
                      }).pipe(Effect.orElseSucceed(() => ({ applied: false as const })))
                      yield* recordTrajectoryForSubtask({
                        task,
                        result,
                        outcome: "failure",
                        quality: { tester_passed: false, command_success: false },
                        failure: {
                          signal: "tester task execution failed",
                          failed_behavior: task.description,
                        },
                        evidence: [task.description],
                      })
                    }
                    if (result) {
                      const signal = testerSignal(result.output)
                      const trajectoryAll = yield* closedLoop.listTrajectory(sessionID).pipe(Effect.orElseSucceed(() => []))
                      const trajectoryForRun = runID ? filterTrajectoryByRun(trajectoryAll, runID) : []
                      const postApplyPaths = runtimeActualOutputPaths(
                        trajectoryForRun
                          .filter((record) => record.agent === "coder")
                          .flatMap((record) => record.artifact_paths),
                      )
                      const testerBinding = evaluateTesterEvidenceBinding({
                        testerText: result.output,
                        taskDescription: task.description,
                        intentAnchor: sessionAnchor?.text,
                        trajectory: trajectoryForRun,
                        actualOutputOverride: postApplyPaths,
                      })
                      const staleEvidence = !testerBinding.valid && testerBinding.stale
                      const testerPassed = signal === "passed" && testerBinding.valid
                      if (signal === "failed" || staleEvidence) {
                        const failureSignal = staleEvidence
                          ? testerBinding.failureSignal ?? "stale_test_evidence"
                          : "tester reported failures"
                        testerDecisionInfo.set(currentTaskKey, {
                          passed: false,
                          category: staleEvidence ? "stale_test_evidence" : "tester_failed",
                          failure_signal: failureSignal,
                          user_message: staleEvidence ? testerBinding.userMessage : undefined,
                          forbidden_paths_seen: staleEvidence ? testerBinding.forbidden_paths_seen : undefined,
                        })
                        yield* closedLoop
                          .recordFailureEvent({
                            sessionID,
                            run_id: runID,
                            failed_stage: "tester",
                            failed_agent: task.agent,
                            task_id: task.task_id ?? closedLoop.taskKey(task),
                            intent_anchor: sessionAnchor?.text,
                            failure_signal: staleEvidence
                              ? failureSignal
                              : `tester reported failures: ${task.description}`,
                            evidence_refs: [task.description],
                          })
                          .pipe(Effect.orElseSucceed(() => undefined))
                        yield* enqueueAdaptiveReplanPatch({
                          sessionID,
                          parent: lastUser,
                          subtaskParts,
                          completedTaskIDs: completed,
                          runID: runID ?? "run:unknown",
                          intentAnchorHash: runIntentAnchorHash ?? "intent:unknown",
                          sourceUserMessageID: runSourceUserMessageID ?? lastUser.id,
                          model: lastUser.model,
                          intent: executionIntent,
                          source: "tester",
                          failedTaskID: task.task_id ?? closedLoop.taskKey(task),
                          failedAgent: task.agent,
                          failureSignal: staleEvidence ? failureSignal : `tester reported failures: ${task.description}`,
                          evidence: [task.description],
                          adaptiveConfig: adaptiveReplanConfig,
                          anchorText: sessionAnchor?.text,
                          patchPrefix: `adaptive_patch_${++adaptivePatchRounds}`,
                          onNodeEnqueued: onAdaptivePatchNodeEnqueued,
                        }).pipe(Effect.orElseSucceed(() => ({ applied: false as const })))
                        yield* recordTrajectoryForSubtask({
                          task,
                          result,
                          outcome: "failure",
                          quality: { tester_passed: false, command_success: false },
                          failure: {
                            signal: staleEvidence ? "stale_test_evidence" : "tester reported failures",
                            failed_behavior: task.description,
                            wrong_artifacts: staleEvidence ? testerBinding.forbidden_paths_seen : undefined,
                            root_cause: staleEvidence ? failureSignal : undefined,
                          },
                          evidence: [task.description],
                        })
                      }
                      if (testerPassed) {
                        testerDecisionInfo.set(currentTaskKey, {
                          passed: true,
                          category: "unknown",
                        })
                        yield* closedLoop
                          .resolveFailureEvent({
                            sessionID,
                            run_id: runID,
                            failed_stage: "tester",
                            failed_agent: task.agent,
                            repair_action: "apply fixes and rerun tester",
                            success_signal: `tester passed: ${task.description}`,
                            evidence_refs: [task.description],
                          })
                          .pipe(Effect.orElseSucceed(() => undefined))
                        yield* recordTrajectoryForSubtask({
                          task,
                          result,
                          outcome: "success",
                          quality: {
                            tester_passed: true,
                            command_success: true,
                            artifact_paths_verified: true,
                          },
                          recovery: {
                            repair_action: "apply fixes and rerun tester",
                            success_signal: `tester passed: ${task.description}`,
                          },
                          evidence: [task.description],
                        })
                      }
                      if (signal === "unknown" && testerBinding.valid) {
                        testerDecisionInfo.set(currentTaskKey, {
                          passed: true,
                          category: "unknown",
                        })
                        yield* recordTrajectoryForSubtask({
                          task,
                          result,
                          outcome: "success",
                          quality: { command_success: true },
                          evidence: [task.description],
                        })
                      }
                      if (signal === "unknown" && !testerBinding.valid) {
                        const failureSignal = testerBinding.failureSignal ?? "stale_test_evidence"
                        testerDecisionInfo.set(currentTaskKey, {
                          passed: false,
                          category: "stale_test_evidence",
                          failure_signal: failureSignal,
                          user_message: testerBinding.userMessage,
                          forbidden_paths_seen: testerBinding.forbidden_paths_seen,
                        })
                        yield* closedLoop
                          .recordFailureEvent({
                            sessionID,
                            run_id: runID,
                            failed_stage: "tester",
                            failed_agent: task.agent,
                            task_id: task.task_id ?? closedLoop.taskKey(task),
                            intent_anchor: sessionAnchor?.text,
                            failure_signal: failureSignal,
                            evidence_refs: [task.description],
                          })
                          .pipe(Effect.orElseSucceed(() => undefined))
                        yield* recordTrajectoryForSubtask({
                          task,
                          result,
                          outcome: "failure",
                          quality: { tester_passed: false, command_success: false },
                          failure: {
                            signal: "stale_test_evidence",
                            failed_behavior: task.description,
                            wrong_artifacts: testerBinding.forbidden_paths_seen,
                            root_cause: failureSignal,
                          },
                          evidence: [task.description],
                        })
                      }
                    }
                  }
                  if (task.task_role === "reviewer" && !result) {
                    reviewerDecisionInfo.set(currentTaskKey, {
                      passed: false,
                      failure_signal: "reviewer task execution failed",
                      user_message: RECOVERABLE_FAILURE_MESSAGES.reviewFailed,
                    })
                    yield* closedLoop
                      .recordFailureEvent({
                        sessionID,
                        run_id: runID,
                        failed_stage: "reviewer",
                        failed_agent: task.agent,
                        task_id: task.task_id ?? closedLoop.taskKey(task),
                        intent_anchor: sessionAnchor?.text,
                        failure_signal: `reviewer task execution failed: ${task.description}`,
                        evidence_refs: [task.description],
                      })
                      .pipe(Effect.orElseSucceed(() => undefined))
                    yield* recordTrajectoryForSubtask({
                      task,
                      outcome: "failure",
                      quality: { reviewer_approved: false, command_success: false },
                      failure: {
                        signal: "reviewer task execution failed",
                        failed_behavior: task.description,
                      },
                      evidence: [task.description],
                    })
                  }
                  if (task.task_role === "reviewer" && result) {
                    const review = parseReviewerOutput(result.output)
                    const trajectoryAll = yield* closedLoop.listTrajectory(sessionID).pipe(Effect.orElseSucceed(() => []))
                    const trajectoryForRun = runID ? filterTrajectoryByRun(trajectoryAll, runID) : []
                    const postApplyPaths = runtimeActualOutputPaths(
                      trajectoryForRun
                        .filter((record) => record.agent === "coder")
                        .flatMap((record) => record.artifact_paths),
                    )
                    const binding = evaluateReviewerEvidenceBinding({
                      reviewText: [result.output, review.notes ?? ""].join("\n"),
                      reviewPassed: review.passed,
                      taskDescription: task.description,
                      intentAnchor: sessionAnchor?.text,
                      trajectory: trajectoryForRun,
                      actualOutputOverride: postApplyPaths,
                    })
                    const reviewerPassed = review.passed && binding.valid
                    reviewerDecisionInfo.set(currentTaskKey, {
                      passed: reviewerPassed,
                      notes: review.notes,
                      task_graph: reviewerPassed ? undefined : review.task_graph,
                      failure_signal:
                        reviewerPassed
                          ? undefined
                          : (binding.valid
                              ? review.notes?.trim() || "reviewer requested fixes"
                              : binding.failureSignal ?? "review_mismatch"),
                      user_message: binding.valid ? undefined : binding.userMessage,
                    })
                    yield* recordTrajectoryForSubtask({
                      task,
                      result,
                      outcome: reviewerPassed ? "success" : "failure",
                      quality: {
                        reviewer_approved: reviewerPassed,
                        command_success: reviewerPassed,
                      },
                      failure: reviewerPassed
                        ? undefined
                        : {
                            signal: binding.valid ? review.notes?.trim() || "reviewer requested fixes" : "review_mismatch",
                            failed_behavior: task.description,
                            root_cause: binding.valid ? undefined : binding.failureSignal,
                          },
                      evidence: [task.description, ...(review.notes ? [review.notes] : [])],
                    })
                  }
                  if (task.task_role !== "tester" && task.task_role !== "reviewer") {
                    if (task.task_role === "coder" && !result) {
                      const failureLabel =
                        failureInfo?.category && failureInfo.category !== "unknown" ? failureInfo.category : "execution_failed"
                      const structured = formatStructuredCoderFailure({ task, failureInfo })
                      const failureSignal = failureInfo?.reason
                        ? `${failureLabel}: ${structured.signalText}`
                        : `coder task execution failed: ${task.description}`
                      yield* closedLoop
                        .recordFailureEvent({
                          sessionID,
                          run_id: runID,
                          failed_stage: "coder",
                          failed_agent: task.agent,
                          task_id: task.task_id ?? closedLoop.taskKey(task),
                          intent_anchor: sessionAnchor?.text,
                          failure_signal: failureSignal,
                          evidence_refs: [task.description],
                        })
                        .pipe(Effect.orElseSucceed(() => undefined))
                    }
                    const quality =
                      task.task_role === "coder"
                        ? {
                            command_success: !!result,
                            ...(result && coderLocalSanitySignal(result.output) ? { local_sanity_check: true } : {}),
                          }
                        : { command_success: !!result }
                    yield* recordTrajectoryForSubtask({
                      task,
                      result,
                      outcome: result ? "success" : "failure",
                      quality,
                      failure: result
                        ? undefined
                        : {
                            signal: "subtask execution failed",
                            failed_behavior: task.description,
                            root_cause:
                              task.task_role === "coder" && failureInfo
                                ? formatStructuredCoderFailure({ task, failureInfo }).signalText
                                : failureInfo?.reason,
                          },
                      evidence: [task.description],
                    })
                  }
                  return { task: nextTask, result, completedKey: closedLoop.taskKey(task), skipped: false }
                }),
                { concurrency: "unbounded" },
              )

              let stopAfterPlannerViolation = false
              const skipCompletion = new Set<string>()
              for (const item of layerResults) {
                if (!item) continue
                if (item.skipped) {
                  skipCompletion.add(item.completedKey)
                  continue
                }
                if (!item.result?.output) continue
                if (item.task.task_role === "tester") {
                  const testerDecision = testerDecisionInfo.get(item.completedKey)
                  if (testerDecision && !testerDecision.passed) {
                    skipCompletion.add(item.completedKey)
                    continue
                  }
                }
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
                  if (!graph.ok) {
                    plannerGraphRetries += 1
                    skipCompletion.add(item.completedKey)
                    log.warn("TaskGraph JSON invalid", {
                      sessionID,
                      reason: graph.reason,
                      repaired: graph.repaired,
                      retry_count: plannerGraphRetries,
                    })
                    if (plannerGraphRetries <= PLANNER_GRAPH_MAX_RETRIES) {
                      yield* emitPlannerGraphInvalid({
                        sessionID,
                        parent: lastUser,
                        task: item.task,
                        retry_count: plannerGraphRetries,
                        action: "auto_retry",
                        reason: graph.reason,
                        repaired: graph.repaired,
                      })
                      yield* preparePlannerGraphRetryTask({
                        task: item.task,
                        retry_count: plannerGraphRetries,
                        reason: graph.reason,
                        repaired: graph.repaired,
                      })
                      continue
                    }
                    yield* emitPlannerGraphInvalid({
                      sessionID,
                      parent: lastUser,
                      task: item.task,
                      retry_count: plannerGraphRetries,
                      action: "stopped",
                      reason: graph.reason,
                      repaired: graph.repaired,
                    })
                    const error = new NamedError.Unknown({
                      message: `TaskGraph JSON invalid after ${plannerGraphRetries} retries: ${graph.reason}`,
                    })
                    yield* bus.publish(Session.Event.Error, { sessionID, error: error.toObject() })
                    stopAfterPlannerViolation = true
                    continue
                  }
                  const enqueueResult = yield* enqueueTaskGraph({
                    sessionID,
                    parent: lastUser,
                    graph: graph.graph,
                    intent: executionIntent,
                    run_id: runID,
                    intent_anchor_hash: runIntentAnchorHash,
                    source_user_message_id: runSourceUserMessageID,
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
                  if (!enqueueResult.accepted) {
                    const reason = enqueueResult.reason ?? "TaskGraph schema invalid"
                    plannerGraphRetries += 1
                    skipCompletion.add(item.completedKey)
                    log.warn("TaskGraph schema invalid", {
                      sessionID,
                      reason,
                      warnings: enqueueResult.warnings,
                      retry_count: plannerGraphRetries,
                    })
                    if (plannerGraphRetries <= PLANNER_GRAPH_MAX_RETRIES) {
                      yield* emitPlannerGraphInvalid({
                        sessionID,
                        parent: lastUser,
                        task: item.task,
                        retry_count: plannerGraphRetries,
                        action: "auto_retry",
                        reason,
                        repaired: graph.repaired,
                      })
                      yield* preparePlannerGraphRetryTask({
                        task: item.task,
                        retry_count: plannerGraphRetries,
                        reason,
                        repaired: graph.repaired,
                      })
                      continue
                    }
                    yield* emitPlannerGraphInvalid({
                      sessionID,
                      parent: lastUser,
                      task: item.task,
                      retry_count: plannerGraphRetries,
                      action: "stopped",
                      reason,
                      repaired: graph.repaired,
                    })
                    const error = new NamedError.Unknown({
                      message: `TaskGraph schema invalid after ${plannerGraphRetries} retries: ${reason}`,
                    })
                    yield* bus.publish(Session.Event.Error, { sessionID, error: error.toObject() })
                    stopAfterPlannerViolation = true
                    continue
                  }
                  plannerGraphRetries = 0
                }
                if (item.task.task_role !== "reviewer") continue
                const decision = reviewerDecisionInfo.get(item.completedKey) ?? {
                  ...parseReviewerOutput(item.result.output),
                  failure_signal: undefined,
                }
                if (decision.passed) {
                  yield* closedLoop
                    .resolveFailureEvent({
                      sessionID,
                      run_id: runID,
                      failed_stage: "reviewer",
                      failed_agent: item.task.agent,
                      repair_action: "apply reviewer fixes and rerun reviewer",
                      success_signal: `reviewer passed: ${item.task.description}`,
                      evidence_refs: [item.task.description],
                    })
                    .pipe(Effect.orElseSucceed(() => undefined))
                  reviewerRounds = 0
                  continue
                }
                skipCompletion.add(item.completedKey)
                const reviewerFailureSignal =
                  decision.failure_signal ??
                  decision.notes?.trim() ??
                  `reviewer requested fixes: ${item.task.description}`
                yield* closedLoop
                  .recordFailureEvent({
                    sessionID,
                    run_id: runID,
                    failed_stage: "reviewer",
                    failed_agent: item.task.agent,
                    task_id: item.task.task_id ?? closedLoop.taskKey(item.task),
                    intent_anchor: sessionAnchor?.text,
                    failure_signal: reviewerFailureSignal,
                    evidence_refs: [item.task.description, ...(decision.notes ? [decision.notes] : [])],
                  })
                  .pipe(Effect.orElseSucceed(() => undefined))
                const adaptiveReviewerPatch = yield* enqueueAdaptiveReplanPatch({
                  sessionID,
                  parent: lastUser,
                  subtaskParts,
                  completedTaskIDs: completed,
                  runID: runID ?? "run:unknown",
                  intentAnchorHash: runIntentAnchorHash ?? "intent:unknown",
                  sourceUserMessageID: runSourceUserMessageID ?? lastUser.id,
                  model: lastUser.model,
                  intent: executionIntent,
                  source: "reviewer",
                  failedTaskID: item.task.task_id ?? closedLoop.taskKey(item.task),
                  failedAgent: item.task.agent,
                  failureSignal: reviewerFailureSignal,
                  evidence: [item.task.description, ...(decision.notes ? [decision.notes] : [])],
                  adaptiveConfig: adaptiveReplanConfig,
                  anchorText: sessionAnchor?.text,
                  patchPrefix: `adaptive_patch_${++adaptivePatchRounds}`,
                  onNodeEnqueued: onAdaptivePatchNodeEnqueued,
                }).pipe(Effect.orElseSucceed(() => ({ applied: false as const })))
                if (adaptiveReviewerPatch.applied) {
                  yield* suspendReviewerTaskForRepair({
                    task: item.task,
                    reason: "adaptive repair patch enqueued",
                  })
                  yield* emitReviewerRepairStatus({
                    actor: { agent: lastUser.agent, model: lastUser.model },
                  })
                  continue
                }
                if (!decision.task_graph) {
                  reviewerRounds += 1
                  if (reviewerFailureSignal.includes('"category":"review_mismatch"') || reviewerRounds >= 2) {
                    yield* slog.info("stopping auto reviewer redispatch without repair graph", {
                      task_id: item.task.task_id ?? closedLoop.taskKey(item.task),
                      reviewer_rounds: reviewerRounds,
                    })
                    stopAfterPlannerViolation = true
                  }
                  continue
                }
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
                const enqueueResult = yield* enqueueTaskGraph({
                  sessionID,
                  parent: lastUser,
                  graph: decision.task_graph,
                  intent: executionIntent,
                  run_id: runID,
                  intent_anchor_hash: runIntentAnchorHash,
                  source_user_message_id: runSourceUserMessageID,
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
                if (!enqueueResult.accepted) {
                  log.warn("reviewer task graph rejected", {
                    sessionID,
                    reason: enqueueResult.reason,
                    warnings: enqueueResult.warnings,
                  })
                } else {
                  yield* suspendReviewerTaskForRepair({
                    task: item.task,
                    reason: "reviewer-provided repair graph enqueued",
                  })
                  yield* emitReviewerRepairStatus({
                    actor: { agent: lastUser.agent, model: lastUser.model },
                  })
                }
              }
              for (const item of layerResults) {
                if (!item) continue
                if (skipCompletion.has(item.completedKey)) continue
                const canMarkCompleted = yield* closedLoop.isTaskInActiveRun({
                  sessionID,
                  run_id: item.task.run_id,
                  intent_anchor_hash: item.task.intent_anchor_hash,
                  source_user_message_id: item.task.source_user_message_id,
                })
                if (!canMarkCompleted || !item.result?.output?.trim()) continue
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
                  explicit_request: latestUserText,
                  task_graph: subtaskParts.map((task) => ({
                    task_id: task.task_id ?? task.id,
                    task_role: task.task_role,
                    description: task.description,
                  })),
                  completedSubtasks: completedAfter.length,
                  summaries,
                  diffs,
                })
                yield* closedLoop.markDriftChecked({ sessionID, completedSubtasks: checkpoint })

                if (drift.is_drift) {
                  yield* closedLoop
                    .recordTrajectory({
                      sessionID,
                      record: createTrajectoryRecord({
                        run_id: runID ?? "run:unknown",
                        source_user_message_id: runSourceUserMessageID ? String(runSourceUserMessageID) : undefined,
                        intent_anchor_hash: runIntentAnchorHash,
                        task_id: `drift:${checkpoint}`,
                        agent: "orchestrator",
                        action_summary: "orchestrator drift decision",
                        expected_outputs: [],
                        actual_outputs: [drift.reason],
                        artifact_paths: [],
                        commands_run: [],
                        verification_results: drift.evidence,
                        tool_results: [],
                        outcome: "failure",
                        quality_signals: { drift_detected: true },
                        failure: {
                          signal: drift.reason,
                        },
                        evidence_refs: drift.evidence,
                      }),
                    })
                    .pipe(Effect.orElseSucceed(() => undefined))
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

            const memoryPack =
              step === 1 && userText
                ? yield* Effect.promise(() =>
                    memoryRuntime.beforeAgentCall({
                      agent: "task-orchestrator",
                      attribution: {
                        session_id: String(sessionID),
                        message_id: latestUserMessage ? String(latestUserMessage.info.id) : undefined,
                        project_id: ctx.project.id,
                        project_root: projectRoot,
                        process_id: "task-orchestrator",
                        agent: "task-orchestrator",
                      },
                      query: userText,
                      topK: 5,
                    }),
                  ).pipe(Effect.orElseSucceed(() => ({ records: [], reminder: "" })))
                : { records: [], reminder: "" }
            const reusableLessonsRaw =
              step === 1 && userText
                ? yield* closedLoop
                    .searchReusableLessons({
                      sessionID,
                      query: userText,
                      topK: 40,
                    })
                    .pipe(Effect.orElseSucceed(() => []))
                : []
            const reusableLessons =
              agent.name === "writer"
                ? reusableLessonsRaw.filter((item) => item.scope === "project")
                : reusableLessonsRaw
            const reusableLessonsEligible = reusableLessons.filter((item) =>
              item.scope === "project" ? item.quality.confidence >= 0.5 : item.quality.confidence >= 0.8,
            )
            const agentMemoryConfig = step === 1 ? (yield* config.get()).experimental?.agent_memory : undefined
            const relevantPatternsFromLessons =
              step === 1 && userText
                ? searchRelevantPatterns({
                    patterns: buildPatternRecordsFromLessons(reusableLessonsEligible),
                    userText,
                    intentAnchor: anchor?.text,
                    agentName: agent.name,
                    taskRole: roleForAgent(agent.name),
                    projectRoot,
                    maxPatterns: 5,
                  })
                : []
            const relevantPatterns: PatternRecord[] =
              step === 1 && userText
                ? yield* Effect.promise(async () => {
                    const selected = createAgentMemoryIndex(projectRoot, agentMemoryConfig)
                    for (const warning of selected.warnings) {
                      log.debug("agent memory backend warning", { warning, backend: selected.config.backend })
                    }
                    const index = selected.index
                    if (!index) return relevantPatternsFromLessons
                    const fromIndex = await syncProjectMemorySources(projectRoot, index)
                      .then(() =>
                        searchRelevantPatternsFromMemoryIndex(index, {
                          userText,
                          intentAnchor: anchor?.text,
                          agentName: agent.name,
                          taskRole: roleForAgent(agent.name),
                          projectRoot,
                          maxPatterns: 5,
                        }),
                      )
                      .catch(() => [])
                    if (fromIndex.length > 0) return fromIndex
                    return relevantPatternsFromLessons
                  }).pipe(Effect.orElseSucceed(() => relevantPatternsFromLessons))
                : []
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
            const memoryReminder = memoryPack.reminder || undefined
            const lessonReminder =
              reusableLessonsEligible.length > 0
                ? [
                    "<system-reminder>",
                    "Reusable lessons loaded at task start from previous runs (apply only when relevant):",
                    ...reusableLessonsEligible.slice(0, 5).map((item) => LessonSchema.formatLessonForInjection(item)),
                    "</system-reminder>",
                  ].join("\n")
                : undefined
            const patternReminder =
              relevantPatterns.length > 0
                ? [
                    "<system-reminder>",
                    formatPatternsForPrompt(relevantPatterns),
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
            const languageRule = activeLanguageRuleFromMessages(msgs)
            const system = [
              ...(languageRule ? [languageRule] : []),
              ...env,
              ...instructions,
              ...(skills ? [skills] : []),
              ...(anchor ? [closedLoop.intentReminder(anchor)] : []),
              ...(memoryReminder ? [memoryReminder] : []),
              ...(patternReminder ? [patternReminder] : []),
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
              provider_route_decision: providerRouteDecision,
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
              const selfcheckRecord = createTrajectoryRecord({
                run_id: runID ?? "run:unknown",
                source_user_message_id: runSourceUserMessageID ? String(runSourceUserMessageID) : undefined,
                intent_anchor_hash: runIntentAnchorHash,
                task_id: "selfcheck:final",
                agent: "selfcheck",
                action_summary: "final selfcheck verification",
                expected_outputs: [],
                actual_outputs: [],
                artifact_paths: [],
                commands_run: report.results.map((item) => item.command),
                verification_results: report.results.map((item) => `${item.command} exit=${item.exit_code}`),
                tool_results: [],
                outcome: report.success ? "success" : "failure",
                quality_signals: {
                  selfcheck_passed: report.success,
                  command_success: report.success,
                },
                failure: report.success
                  ? undefined
                  : {
                      signal: summarizeSelfcheckFailure(report),
                    },
                recovery: report.success
                  ? {
                      repair_action: "fix issues and rerun checks",
                      success_signal: summarizeSelfcheckSuccess(report),
                    }
                  : undefined,
                evidence_refs: report.results.slice(0, 3).map((item) => `selfcheck:${item.command}:exit=${item.exit_code}`),
              })
              yield* closedLoop.recordTrajectory({ sessionID, record: selfcheckRecord }).pipe(Effect.orElseSucceed(() => undefined))
              if (report.success) {
                yield* closedLoop
                  .resolveFailureEvent({
                    sessionID,
                    run_id: runID,
                    failed_stage: "selfcheck",
                    success_signal: summarizeSelfcheckSuccess(report),
                    repair_action: "fix issues and rerun checks",
                    evidence_refs: report.results.slice(0, 3).map((item) => `selfcheck:${item.command}:exit=${item.exit_code}`),
                  })
                  .pipe(Effect.orElseSucceed(() => undefined))
                yield* closedLoop.bumpSelfCheckRounds({ sessionID, reset: true })
                return "break" as const
              }

              yield* closedLoop
                .recordFailureEvent({
                  sessionID,
                  run_id: runID,
                  failed_stage: "selfcheck",
                  failed_agent: "orchestrator",
                  failure_signal: summarizeSelfcheckFailure(report),
                  intent_anchor: anchor?.text,
                  evidence_refs: report.results.slice(0, 3).map((item) => `selfcheck:${item.command}:exit=${item.exit_code}`),
                })
                .pipe(Effect.orElseSucceed(() => undefined))
              const completedForReplan = yield* closedLoop.listCompletedSubtasks(sessionID).pipe(Effect.orElseSucceed(() => []))
              const selfcheckFailureSignal = summarizeSelfcheckFailure(report)
              const replanProposal = deriveReplanProposalFromFailure({
                run_id: runID ?? "run:unknown",
                source: "selfcheck",
                failed_task_id: "selfcheck:final",
                failed_agent: "selfcheck",
                failure_signal: selfcheckFailureSignal,
                normalized_graph: replanGraphFromSubtasks(subtaskParts),
                completed_task_ids: completedForReplan,
                intent_anchor: anchor?.text,
                evidence: report.results.slice(0, 3).map((item) => `${item.command} exit=${item.exit_code}`),
              })
              const adaptiveSelfcheckPatch = yield* enqueueAdaptiveReplanPatch({
                sessionID,
                parent: lastUser,
                subtaskParts,
                completedTaskIDs: completedForReplan,
                runID: runID ?? "run:unknown",
                intentAnchorHash: runIntentAnchorHash ?? "intent:unknown",
                sourceUserMessageID: runSourceUserMessageID ?? lastUser.id,
                model: lastUser.model,
                intent: executionIntent,
                source: "selfcheck",
                failedTaskID: "selfcheck:final",
                failedAgent: "selfcheck",
                failureSignal: selfcheckFailureSignal,
                evidence: report.results.slice(0, 3).map((item) => `${item.command} exit=${item.exit_code}`),
                adaptiveConfig: adaptiveReplanConfig,
                anchorText: anchor?.text,
                patchPrefix: `adaptive_patch_${++adaptivePatchRounds}`,
                onNodeEnqueued: onAdaptivePatchNodeEnqueued,
              }).pipe(Effect.orElseSucceed(() => ({ applied: false as const })))
              const replanSection = formatReplanProposalForPrompt(replanProposal)
              const rounds = yield* closedLoop.bumpSelfCheckRounds({ sessionID })
              if (adaptiveSelfcheckPatch.applied) {
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
                    `Selfcheck failed (round ${rounds}/5).`,
                    "Adaptive replan patch applied; rerun affected repair subtree.",
                    "Report:",
                    JSON.stringify(report, null, 2),
                    replanSection ? `\n${replanSection}` : "",
                  ].join("\n\n"),
                } satisfies MessageV2.TextPart)
                return "continue" as const
              }
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
                      replanSection ? `\n${replanSection}` : "",
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
                  replanSection ? `\n${replanSection}` : "",
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

        const activeRun = yield* closedLoop.activeRun(sessionID)
        const runStillActive =
          !!activeRun &&
          activeRun.status === "active" &&
          !!runID &&
          activeRun.run_id === runID &&
          (!runIntentAnchorHash || activeRun.intent_anchor_hash === runIntentAnchorHash) &&
          (!runSourceUserMessageID || activeRun.source_message_id === runSourceUserMessageID)
        const completedSubtasks = runStillActive ? yield* closedLoop.listCompletedSubtasks(sessionID) : []
        const runTrajectoryCount =
          runStillActive && runID
            ? filterTrajectoryByRun(
                yield* closedLoop.listTrajectory(sessionID).pipe(Effect.orElseSucceed(() => [])),
                runID,
              ).length
            : 0
        let unresolvedRequiredTaskKeys: string[] = []
        if (runStillActive) {
          const finalMsgsForRunCheck = yield* MessageV2.filterCompactedEffect(sessionID)
          const requiredTaskKeys = [
            ...new Set(
              finalMsgsForRunCheck.flatMap((message) =>
                message.parts.flatMap((part) => {
                  if (part.type !== "subtask") return []
                  if (part.task_role === "planner" || part.task_role === "writer") return []
                  if (!taskBelongsToCurrentRun(part)) return []
                  return [closedLoop.taskKey(part)]
                }),
              ),
            ),
          ]
          const explicitlySkippedTaskKeys = new Set(
            [...schedulerTodos.values()].flatMap((todo) =>
              todo.status === "failed" &&
              typeof todo.taskID === "string" &&
              todo.content.trim().startsWith("[SKIPPED]")
                ? [todo.taskID]
                : [],
            ),
          )
          unresolvedRequiredTaskKeys = requiredTaskKeys.filter(
            (taskKey) => !completedSubtasks.includes(taskKey) && !explicitlySkippedTaskKeys.has(taskKey),
          )
          if (unresolvedRequiredTaskKeys.length > 0) {
            yield* slog.info("skipping writer finalizer: required task evidence incomplete", {
              pending_required_tasks: unresolvedRequiredTaskKeys,
            })
          }
        }
        const diffs = yield* summary.diff({ sessionID }).pipe(Effect.orElseSucceed(() => []))
        if (
          runStillActive &&
          (completedSubtasks.length > 0 || runTrajectoryCount > 0) &&
          !writerRan &&
          !writerFinalizerStarted &&
          !writerFinalizerCompleted &&
          !writerFinalizerFailed &&
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
          runStillActive &&
          (completedSubtasks.length > 0 || runTrajectoryCount > 0) &&
          !writerRan &&
          !writerFinalizerStarted &&
          !writerFinalizerCompleted &&
          !writerFinalizerFailed &&
          unresolvedRequiredTaskKeys.length === 0 &&
          (!skipChangelogAndProjectLesson || (!skipGlobalResearchLesson && researchDrafts.length > 0))
        ) {
          const latestMsgs = yield* MessageV2.filterCompactedEffect(sessionID)
          const finalUserMsg = latestMsgs.findLast((message) => message.info.role === "user")
          if (!finalUserMsg || finalUserMsg.info.role !== "user") {
            writerFinalizerFailed = true
            yield* compaction.prune({ sessionID }).pipe(Effect.ignore, Effect.forkIn(scope))
            return yield* lastAssistant(sessionID)
          }
          const finalUserText = finalUserMsg.parts
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("\n")
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
          const trajectoryAll = yield* closedLoop.listTrajectory(sessionID).pipe(Effect.orElseSucceed(() => []))
          const trajectoryForRun = runID ? filterTrajectoryByRun(trajectoryAll, runID) : []
          const postApplyPathsForWriter = runtimeActualOutputPaths(
            trajectoryForRun
              .filter((record) => record.agent === "coder")
              .flatMap((record) => record.artifact_paths),
          )
          const reviewerTaskIDsForRun = [
            ...new Set(
              latestMsgs.flatMap((message) =>
                message.parts.flatMap((part) => {
                  if (part.type !== "subtask") return []
                  if (part.task_role !== "reviewer") return []
                  if (!taskBelongsToCurrentRun(part)) return []
                  return [part.task_id ?? closedLoop.taskKey(part)]
                }),
              ),
            ),
          ]
          const reviewerApprovedTaskIDs = new Set(
            trajectoryForRun
              .filter((record) => record.agent === "reviewer" && record.outcome === "success" && record.quality_signals.reviewer_approved)
              .map((record) => record.task_id)
              .filter((item): item is string => typeof item === "string" && item.trim().length > 0),
          )
          const hasReviewerTasksForRun = reviewerTaskIDsForRun.length > 0
          const hasAnyReviewerApproval = reviewerApprovedTaskIDs.size > 0
          const missingReviewerApprovals = reviewerTaskIDsForRun.filter((taskID) => !reviewerApprovedTaskIDs.has(taskID))
          if (hasReviewerTasksForRun && !hasAnyReviewerApproval) {
            yield* slog.info("skipping writer finalizer: reviewer approval evidence missing", {
              reviewer_tasks: reviewerTaskIDsForRun,
              approved: [...reviewerApprovedTaskIDs],
              missing: missingReviewerApprovals,
            })
          } else {
          const trajectoryEvidenceSection = formatTrajectoryEvidenceForWriter(trajectoryForRun)
          const rawArtifactPaths = postApplyPathsForWriter.filter((item) => item.trim().length > 0)
          const writerRequiredPaths = extractRequiredPaths([sessionAnchor?.text ?? "", finalUserText].join("\n"))
          const writerPathContext = pathContextFromTrajectory({
            requiredPaths: writerRequiredPaths.length > 0 ? writerRequiredPaths : [...DEFAULT_REQUIRED_EXECUTION_PATHS],
            trajectoryArtifactPaths: postApplyPathsForWriter,
            projectRoot,
            forbiddenRoots: [
              "/",
              `${projectRoot}/ssl`,
              `${projectRoot}/test/certs`,
              `${projectRoot}/packages/codemate/ssl`,
            ],
          })
          const worktreeApplyExpected = coderTaskTargetAllowlist.size > 0
          const allowedWriterEvidencePaths =
            writerPathContext.actual_output_paths.length > 0
              ? writerPathContext.actual_output_paths
              : worktreeApplyExpected
                ? []
              : ensureAbsolutePathList(
                  [...writerPathContext.required_paths, ...writerPathContext.fallback_paths],
                  { cwd: projectRoot },
                )
          const sanitizedArtifactPaths = sanitizeArtifactPathsForCurrentRun(
            rawArtifactPaths,
            [sessionAnchor?.text ?? "", finalUserText].join("\n"),
            allowedWriterEvidencePaths,
          )
          if (sanitizedArtifactPaths.warnings.length > 0) {
            yield* slog.info("artifact path sanitizer dropped non-current-run paths", {
              warnings: sanitizedArtifactPaths.warnings,
              rejected_paths: sanitizedArtifactPaths.rejected_paths,
            })
          }
          const actualArtifactPaths = sanitizedArtifactPaths.accepted_paths
          const trajectoryOutputs =
            postApplyActualOutputPaths.size > 0
              ? [...new Set(actualArtifactPaths)]
              : [...new Set([...actualArtifactPaths, ...trajectoryForRun.flatMap((record) => record.actual_outputs)])]
          const isPrimarySslPath = (path: string) => /^\/app\/(?:ssl(?:\/|$)|check_cert\.py$)/.test(path)
          const fallbackRoot = toAbsolutePath("~/app", { cwd: projectRoot })
          const isFallbackSslPath = (path: string) =>
            fallbackRoot ? path === `${fallbackRoot}/check_cert.py` || path.startsWith(`${fallbackRoot}/ssl/`) : false
          const fallbackSslOnly =
            actualArtifactPaths.some((path) => isFallbackSslPath(path)) &&
            !actualArtifactPaths.some((path) => isPrimarySslPath(path))
          const hasTrajectoryEvidence = trajectoryForRun.length > 0
          const lines = hasTrajectoryEvidence
            ? trajectoryOutputs.slice(0, 30).map((entry) => `- ${entry}`)
            : completedSummaries.length > 0
              ? completedSummaries.slice(0, 30).map((summary) => `- ${summary}`)
              : diffs.length > 0
                ? diffs
                    .slice(0, 30)
                    .map((diff) => `- ${diff.file ?? "unknown"} (+${Math.max(0, diff.additions)}, -${Math.max(0, diff.deletions)})`)
                : ["- evidence missing"]
          const changedFilesHeader = hasTrajectoryEvidence
            ? "Changed outputs (source=trajectory evidence):"
            : completedSummaries.length > 0
              ? "Changed files fallback (completed subtasks summary):"
              : diffs.length > 0
                ? "Changed files fallback (git diff):"
                : "Changed files:"
          const trajectoryEvidencePaths = new Set(actualArtifactPaths)
          const diffConflictCount = hasTrajectoryEvidence
            ? diffs.filter((diff) => {
                const file = diff.file?.trim()
                if (!file) return false
                return !trajectoryEvidencePaths.has(file)
              }).length
            : 0
          const failureRecoveryCandidates = yield* closedLoop
            .listFailureRecoveryCandidates(sessionID)
            .pipe(Effect.orElseSucceed(() => []))
          const lessonSafeFailureRecoveryCandidates = failureRecoveryCandidates.map((candidate) => ({
            ...candidate,
            failure_signal: sanitizeInternalFailureForKnowledge(candidate.failure_signal),
            evidence_refs: (candidate.evidence_refs ?? []).map((item) => sanitizeInternalFailureForKnowledge(item)).filter(Boolean),
          }))
          const failureRecoverySection =
            lessonSafeFailureRecoveryCandidates.length === 0
              ? ["Failure recovery candidates: none available."]
              : [
                  "Failure recovery candidates:",
                  ...lessonSafeFailureRecoveryCandidates.slice(-8).flatMap((candidate) => [
                    `- Failed stage: ${candidate.failed_stage}`,
                    `  Failed agent: ${candidate.failed_agent ?? "n/a"}`,
                    `  Failure signal: ${candidate.failure_signal}`,
                    `  Repair action: ${candidate.repair_action ?? "n/a"}`,
                    `  Success signal: ${candidate.success_signal ?? "n/a"}`,
                    `  Evidence: ${(candidate.evidence_refs ?? []).join("; ") || "n/a"}`,
                  ]),
                ]
          const lessonProposals = deriveLessonProposalsFromTrajectory(trajectoryForRun, {
            run_id: runID,
            failure_recovery_candidates: lessonSafeFailureRecoveryCandidates,
          })
          const lessonProposalSection = formatLessonProposalsForWriter(lessonProposals)
          const hasTesterOrReviewerEvidence = trajectoryForRun.some(
            (record) => record.quality_signals.tester_passed === true || record.quality_signals.reviewer_approved === true,
          )
          const unsupportedCoderAcceptanceClaim = trajectoryForRun.some((record) => {
            if (record.agent !== "coder") return false
            const evidence = [
              record.action_summary,
              ...record.actual_outputs,
              ...record.verification_results,
              ...record.tool_results,
            ]
              .join("\n")
              .toLowerCase()
            return /\b(all requirements (verified|met)|verified all requirements|full acceptance|task fully validated)\b/.test(
              evidence,
            )
          })
          const writerTask: MessageV2.SubtaskPart = {
            id: PartID.ascending(),
            messageID: MessageID.ascending(),
            sessionID,
            type: "subtask",
            task_role: "writer",
            task_id: `writer:final:${sessionID}`,
            run_id: runID,
            intent_anchor_hash: runIntentAnchorHash,
            source_user_message_id: runSourceUserMessageID,
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
              "Use Execution evidence as source of truth.",
              "Do not infer current-run outputs from similarly named workspace files when evidence is available.",
              "If evidence conflicts with git diff/workspace files, prefer evidence and mention conflict.",
              "If execution evidence is missing, say evidence missing and use completed subtasks fallback only.",
              "Do NOT scan similarly named old directories (for example ssl/, test/certs/) to infer this run's outputs.",
              `Required paths (contract): ${writerPathContext.required_paths.join(", ")}`,
              `Fallback paths (contract): ${writerPathContext.fallback_paths.join(", ")}`,
              `Actual output paths (source=trajectory evidence): ${actualArtifactPaths.length > 0 ? actualArtifactPaths.join(", ") : "none"}`,
              actualArtifactPaths.length > 0
                ? `Use these exact artifact paths from current-run evidence: ${actualArtifactPaths.join(", ")}`
                : "Artifact paths from current-run evidence: none",
              "In changelog/final summary/lessons, claim only actual output paths; do not claim contract required/fallback paths unless they appear in actual output paths.",
              fallbackSslOnly
                ? "Path binding rule: this run used fallback absolute app path under HOME. Do NOT claim /app/ssl success in changelog/lessons."
                : "Path binding rule: claim only paths proven by current-run evidence.",
              "Topic binding rule: do not include unrelated topics (README/docs/architecture/markdown cleanup) unless current-run evidence explicitly includes them.",
              "For normal session lessons, you must follow lesson_classify output scope exactly.",
              "Do NOT override lesson_classify scope based on intuition.",
              "Global lesson writes are allowed only when lesson_classify returns global OR a lesson comes from research drafts and passes the global research quality gate.",
              "Prioritize lesson candidates from `Lesson proposals from trajectory` before writing any other session lesson.",
              "Do not invent unrelated lessons that are not grounded in trajectory evidence or listed proposals.",
              "Every proposal you choose must still go through lesson_classify before lesson_write, and lesson_write must include classification_id.",
              "If proposal confidence is low or evidence is insufficient, you may skip writing that proposal.",
              "You may claim a failure_pattern lesson came from failure recovery only when supported by listed candidates.",
              unsupportedCoderAcceptanceClaim && !hasTesterOrReviewerEvidence
                ? "Coder self-report note: coder claimed full requirement verification without tester/reviewer evidence. Treat this as unsupported and do not use it as final proof."
                : "Coder self-report note: none.",
              "Rule: If completed subtasks > 0 and mode allows changelog/project lessons, do NOT no-op even when git diff is empty.",
              `Intent anchor: ${sessionAnchor?.text ?? "n/a"}`,
              `Completed subtasks: ${completedSubtasks.length}`,
              hasTrajectoryEvidence ? `Trajectory records: ${trajectoryForRun.length}` : "Trajectory records: 0 (evidence missing)",
              "",
              trajectoryEvidenceSection,
              "",
              lessonProposalSection,
              "",
              diffConflictCount > 0
                ? `Evidence conflict note: ${diffConflictCount} git diff paths do not match trajectory outputs. Prefer trajectory evidence.`
                : "Evidence conflict note: none.",
              "",
              changedFilesHeader,
              ...lines,
              "",
              ...failureRecoverySection,
              "",
              "Research drafts:",
              researchDrafts.length > 0 ? JSON.stringify(researchDrafts, null, 2) : "[]",
              "",
              renderPathContextBlock(
                createPathContext({
                  requiredPaths: writerPathContext.required_paths,
                  fallbackPaths: writerPathContext.fallback_paths,
                  actualOutputPaths: actualArtifactPaths,
                  projectRoot,
                  forbiddenRoots: writerPathContext.forbidden_search_roots,
                }),
              ),
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
          writerFinalizerStarted = true
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
          const writerOutput = writerResult?.output?.toLowerCase() ?? ""
          const writerNoOp = writerOutput.includes("no-op") || writerOutput.includes("no op")
          const writerSessionID =
            typeof writerResult?.metadata?.sessionId === "string" ? SessionID.make(writerResult.metadata.sessionId) : undefined
          const writerToolsUsed = writerSessionID ? yield* listCompletedToolsInSession(writerSessionID) : []
          const writerPersistenceTools = writerToolsUsed.filter((toolID) =>
            toolID === "lesson_classify" || toolID === "lesson_write" || toolID === "changelog_append",
          )
          const writerHasPersistenceToolCall = writerPersistenceTools.length > 0
          const writerClaimsToolCallInText =
            /["']action["']\s*:\s*["'](?:lesson_classify|lesson_write|changelog_append)["']/i.test(writerOutput) ||
            /<tool_call>/i.test(writerOutput)
          const writerPersistenceRequired = !skipChangelogAndProjectLesson
          const writerPersistenceFailed =
            !!writerResult && writerPersistenceRequired && !writerHasPersistenceToolCall
          if (!writerResult || writerNoOp || writerPersistenceFailed) {
            const failureSignal =
              !writerResult
                ? "writer task failed"
                : writerNoOp
                  ? "writer returned no-op persistence result"
                  : "writer_persistence_failed"
            yield* closedLoop
              .recordFailureEvent({
                sessionID,
                run_id: runID,
                failed_stage: "writer",
                failed_agent: writerTask.agent,
                task_id: writerTask.task_id,
                intent_anchor: sessionAnchor?.text,
                failure_signal: failureSignal,
                evidence_refs: [
                  writerTask.description,
                  ...(writerPersistenceFailed
                    ? [
                        `required_persistence=true`,
                        `actual_persistence_toolcalls=${writerPersistenceTools.length}`,
                        writerClaimsToolCallInText ? "textual_toolcall_claim_detected=true" : "textual_toolcall_claim_detected=false",
                      ]
                    : []),
                ],
              })
              .pipe(Effect.orElseSucceed(() => undefined))
            yield* setSchedulerTodoStatus({
              task: writerTask,
              status: "failed",
            })
            writerFinalizerFailed = true
          }
          if (writerResult && !writerNoOp && !writerPersistenceFailed) {
            yield* closedLoop
              .resolveFailureEvent({
                sessionID,
                run_id: runID,
                failed_stage: "writer",
                failed_agent: writerTask.agent,
                task_id: writerTask.task_id,
                repair_action: "rerun writer persistence pass",
                success_signal: "writer persistence toolcall completed",
                evidence_refs: [writerTask.description],
              })
              .pipe(Effect.orElseSucceed(() => undefined))
            writerFinalizerCompleted = true
          }
          writerRan = true
          }
        }

        if (runStillActive) {
          yield* closedLoop.completeRun({ sessionID, run_id: runID }).pipe(Effect.orElseSucceed(() => undefined))
          yield* Effect.promise(() => cleanupWorktree(runWorktreeContext)).pipe(Effect.orElseSucceed(() => undefined))
          runWorktreeContext = undefined
        }

        yield* compaction.prune({ sessionID }).pipe(Effect.ignore, Effect.forkIn(scope))
        return yield* lastAssistant(sessionID)
      },
    )

    const runLoop = (sessionID: SessionID) =>
      Effect.scoped(
        runLoopUnsafe(sessionID).pipe(
          Effect.catchCause((cause) => {
          const firstDie = Cause.findDie(cause)
          const firstFail = Cause.findFail(cause)
          const firstFailJSON = JSON.stringify(firstFail)
          const nullFail =
            firstFailJSON.includes('"_tag":"Fail"') &&
            (firstFailJSON.includes('"error":null') || firstFailJSON.includes('"error":undefined'))
          const dieValue =
            firstDie._tag === "Success" && firstDie && typeof firstDie === "object" && "value" in firstDie
              ? firstDie.value
              : undefined
          const nullDefect =
            !!dieValue &&
            typeof dieValue === "object" &&
            "_tag" in dieValue &&
            dieValue["_tag"] === "Die" &&
            "defect" in dieValue &&
            (dieValue["defect"] === null || dieValue["defect"] === undefined)
          const message = [
            nullDefect
              ? "SessionPrompt.loop failed with null defect. This usually indicates missing/unexpected test LLM mocks or an orDie boundary receiving null."
              : "SessionPrompt.loop failed.",
            `null_fail=${String(nullFail)}`,
            `first_fail=${firstFailJSON}`,
            `first_defect=${JSON.stringify(firstDie)}`,
          ].join(" ")
          if (nullFail) {
            return Effect.gen(function* () {
              const error = new NamedError.Unknown({ message })
              yield* bus.publish(Session.Event.Error, { sessionID, error: error.toObject() })
              return yield* lastAssistant(sessionID)
            })
          }
          return Effect.die(new NamedError.Unknown({ message }))
          }),
        ),
      )

    const loop: (input: LoopInput) => Effect.Effect<MessageV2.WithParts> = Effect.fn("SessionPrompt.loop")(function* (
      input: LoopInput,
    ) {
      return yield* state.ensureRunning(
        input.sessionID,
        closedLoop
          .cancelRun({ sessionID: input.sessionID })
          .pipe(
            Effect.orElseSucceed(() => undefined),
            Effect.flatMap(() => lastAssistant(input.sessionID)),
          ),
        runLoop(input.sessionID),
      )
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
