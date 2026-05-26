import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import { access, constants } from "node:fs/promises"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import type { SessionPrompt } from "../session/prompt"
import * as LanguageRule from "@/session/language-rule"
import { Config } from "@/config/config"
import * as SessionClosedLoop from "@/session/closed-loop"
import { Cause, Effect, Exit, Schema } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { preflightShellTool } from "./shell"
import {
  derivePathContextFromPrompt,
  ensureAbsolutePathList,
  extractRequiredPaths,
  hasForbiddenPath,
  parsePathContextBlock,
  resolveActualOutputPathsFromText,
  resolveFallbackPaths,
} from "@/session/path-context"

export interface TaskPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<MessageV2.WithParts>
}

const id = "task"
const LEGACY_SUBAGENT_ALIAS: Record<string, string> = {
  general: "coder",
  explore: "planner",
  scout: "research",
}

type Metadata = {
  sessionId?: SessionID
  model?: {
    modelID: string
    providerID: string
  }
  reused?: boolean
  fingerprint?: string
  file_write_evidence?: FileWriteEvidence[]
  researchDraft?: {
    topic: string
    lesson: string
    detail: string
    fix: string
    tags: string[]
  }
}

const MIN_RESEARCH_LESSON_CHARS = 120
const SHELL_REQUIRED_PATTERN =
  /\b(openssl|bash|shell|chmod|chown|stat|permission|certificate|private key|server\.crt|server\.key|server\.pem)\b/i
const STALE_ARTIFACT_PATTERNS = [/packages\/codemate\/ssl/i, /test\/certs/i, /(^|[\s"'`(])ssl\//i, /(^|[\s"'`(])\/util\/ssl\b/i]

type GuardFailure = {
  category: "tool_unavailable" | "wrong_path" | "stale_artifact"
  reason: string
  requiredPaths?: string[]
  fallbackPaths?: string[]
  allowedFallbackPaths?: string[]
  actualOutputPaths?: string[]
  forbiddenPathsSeen?: string[]
  repairInstruction?: string
}

type ToolSchemaFailure = {
  category: "tool_schema_error"
  reason: string
  toolName: "write" | "edit"
  errorCategory: "tool_schema_error"
  missingField: string
  repairInstruction: string
}

type ToolCallInvalidFailure = {
  category: "tool_call_invalid"
  reason: string
  toolName: string
  errorCategory: "unknown_tool" | "invalid_tool_call"
  repairInstruction: string
}

type FileWriteVerificationFailure = {
  category: "file_write_verification_failed"
  reason: string
  toolName: "write" | "edit"
  filePath?: string
  expectedFragment?: string
  readbackFragment?: string
  repairInstruction: string
}

type FileWriteEvidence = {
  file_path: string
  tool: "write" | "edit"
  mtime_ms?: number
  sha256?: string
  readback_fragment?: string
  existed_before?: boolean
}

function normalizePosixPath(input: string) {
  return input.replaceAll("\\", "/").replace(/\/+/g, "/").replace(/\/$/, "")
}

function outputBasename(input: string) {
  const normalized = normalizePosixPath(input)
  const parts = normalized.split("/")
  return parts[parts.length - 1] ?? normalized
}

function renderPathConstraintInstruction(input: {
  requiredPaths: string[]
  targetPaths?: string[]
  sandboxPaths?: string[]
  fallbackPaths: string[]
  allowedSearchRoots: string[]
  forbiddenSearchRoots: string[]
}) {
  return [
    "Path constraints for this task:",
    `- required_paths (request contract): ${input.requiredPaths.join(", ") || "none"}.`,
    `- target_paths (apply targets): ${input.targetPaths?.join(", ") || "none"}.`,
    `- sandbox_paths (execution-only writable paths): ${input.sandboxPaths?.join(", ") || "none"}.`,
    `- fallback_paths (absolute): ${input.fallbackPaths.join(", ") || "none"}.`,
    `- allowed_search_roots (absolute only): ${input.allowedSearchRoots.join(", ") || "none"}.`,
    `- forbidden_search_roots: ${input.forbiddenSearchRoots.join(", ") || "/"}.`,
    "- Do not infer or expand home paths yourself. Use only absolute fallback paths provided above.",
    "- You are an execution coder, not a tutorial writer.",
    "- For file-producing tasks, you must use tools to create/modify files in this run.",
    "- Do not merely describe commands, scripts, or steps as completion.",
    "- Do not use 'after running this script/command' as completion evidence.",
    "- Script-only output is not completion unless the task explicitly requires script-only artifact output.",
    "- Do not claim completion unless current-run outputs are created at sandbox_paths and applied to target_paths.",
    "- If allowed paths cannot be written, report failure and stop.",
  ].join("\n")
}

function inferNeedsShellPreflight(text: string) {
  const normalized = text.toLowerCase()
  if (SHELL_REQUIRED_PATTERN.test(normalized)) return true
  if (normalized.includes("/app/")) return true
  return false
}

function inferNeedsOpenSSL(text: string) {
  const normalized = text.toLowerCase()
  return normalized.includes("openssl") || /\b(certificate|private key|server\.crt|server\.key|server\.pem)\b/.test(normalized)
}

function looksLikeShellCommandToolName(toolName: string) {
  const normalized = toolName.trim()
  if (!normalized) return false
  if (/\s/.test(normalized)) return true
  if (/[|&;<>`$()]/.test(normalized)) return true
  const lower = normalized.toLowerCase()
  const shellPrefixes = [
    "ls",
    "cd",
    "pwd",
    "cat",
    "echo",
    "grep",
    "find",
    "chmod",
    "chown",
    "mkdir",
    "rm",
    "cp",
    "mv",
    "sed",
    "awk",
    "python",
    "node",
    "git",
    "openssl",
    "bash",
    "sh",
    "zsh",
  ]
  return shellPrefixes.some((prefix) => lower === prefix || lower.startsWith(`${prefix} `))
}

function detectCoderToolSchemaFailure(error: unknown): ToolSchemaFailure | undefined {
  const reason = error instanceof Error ? error.message : String(error ?? "")
  const normalized = reason.trim()
  if (!normalized) return
  const lower = normalized.toLowerCase()
  const missingKeyMatch = normalized.match(/Missing key at \[\s*["']?([A-Za-z0-9_.-]+)["']?\s*\]/i)
  const missingField = missingKeyMatch?.[1] ?? (lower.includes("filepath") ? "filePath" : undefined)
  if (!missingField) return
  const schemaLike =
    lower.includes("schemaerror") || lower.includes("invalid arguments") || lower.includes("missing key at")
  if (!schemaLike) return
  const toolName: "write" | "edit" | undefined =
    /\bwrite\b/i.test(normalized) ? "write" : /\bedit\b/i.test(normalized) ? "edit" : undefined
  if (!toolName && missingField !== "filePath") return
  return {
    category: "tool_schema_error",
    reason: normalized,
    toolName: toolName ?? "write",
    errorCategory: "tool_schema_error",
    missingField,
    repairInstruction:
      "use correct write tool schema or fallback to shell redirection only if allowed (and only within allowed paths)",
  }
}

function detectCoderToolCallInvalidFailure(error: unknown): ToolCallInvalidFailure | undefined {
  const reason = error instanceof Error ? error.message : String(error ?? "")
  const normalized = reason.trim()
  if (!normalized) return
  if (normalized.startsWith("[tool_call_invalid]")) {
    const payloadText = normalized.slice("[tool_call_invalid]".length).trim()
    if (payloadText.startsWith("{")) {
      try {
        const parsed = JSON.parse(payloadText) as Record<string, unknown>
        const toolName =
          typeof parsed.tool_name === "string" && parsed.tool_name.trim().length > 0
            ? parsed.tool_name.trim()
            : typeof parsed.tool === "string" && parsed.tool.trim().length > 0
              ? parsed.tool.trim()
              : "unknown"
        const errorCategory =
          parsed.error_category === "unknown_tool" || parsed.error_category === "invalid_tool_call"
            ? parsed.error_category
            : "invalid_tool_call"
        const repairInstruction =
          typeof parsed.repair_instruction === "string" && parsed.repair_instruction.trim().length > 0
            ? parsed.repair_instruction.trim()
            : looksLikeShellCommandToolName(toolName)
              ? "use bash tool for shell commands"
              : "use only registered tools"
        return {
          category: "tool_call_invalid",
          reason:
            typeof parsed.reason === "string" && parsed.reason.trim().length > 0
              ? parsed.reason.trim()
              : normalized,
          toolName,
          errorCategory,
          repairInstruction,
        }
      } catch {
        // fall through to string heuristics
      }
    }
  }
  const unknownToolMatch = normalized.match(/\bunknown tool\b[:\s]+(.+)$/i)
  const toolName = unknownToolMatch?.[1]?.trim()
  if (!toolName && !/invalid tool/i.test(normalized)) return
  const resolvedTool = toolName || "unknown"
  const shellLike = looksLikeShellCommandToolName(resolvedTool)
  return {
    category: "tool_call_invalid",
    reason: normalized,
    toolName: resolvedTool,
    errorCategory: "unknown_tool",
    repairInstruction: shellLike ? "use bash tool for shell commands" : "use only registered tools",
  }
}

function detectCoderFileWriteVerificationFailure(error: unknown): FileWriteVerificationFailure | undefined {
  const reason = error instanceof Error ? error.message : String(error ?? "")
  const normalized = reason.trim()
  if (!normalized) return
  const prefix = "[file_write_verification_failed]"
  if (!normalized.startsWith(prefix)) return
  const payloadText = normalized.slice(prefix.length).trim()
  if (!payloadText.startsWith("{")) {
    return {
      category: "file_write_verification_failed",
      reason: normalized,
      toolName: "write",
      repairInstruction: "retry write/edit and verify file content with readback",
    }
  }
  try {
    const parsed = JSON.parse(payloadText) as Record<string, unknown>
    return {
      category: "file_write_verification_failed",
      reason:
        typeof parsed.reason === "string" && parsed.reason.trim().length > 0
          ? parsed.reason.trim()
          : normalized,
      toolName: parsed.tool_name === "edit" ? "edit" : "write",
      filePath: typeof parsed.file_path === "string" ? parsed.file_path : undefined,
      expectedFragment: typeof parsed.expected_fragment === "string" ? parsed.expected_fragment : undefined,
      readbackFragment: typeof parsed.readback_fragment === "string" ? parsed.readback_fragment : undefined,
      repairInstruction:
        typeof parsed.repair_instruction === "string" && parsed.repair_instruction.trim().length > 0
          ? parsed.repair_instruction
          : "retry write/edit and verify file content with readback",
    }
  } catch {
    return {
      category: "file_write_verification_failed",
      reason: normalized,
      toolName: "write",
      repairInstruction: "retry write/edit and verify file content with readback",
    }
  }
}

function detectCoderPathGuardFailure(input: {
  prompt: string
  description: string
  projectRoot?: string
  resultText: string
}): GuardFailure | undefined {
  const mergedPrompt = `${input.description}\n${input.prompt}`
  const fromPrompt = parsePathContextBlock(mergedPrompt)
  const inferred = derivePathContextFromPrompt({
    text: mergedPrompt,
    cwd: input.projectRoot,
    projectRoot: input.projectRoot,
    forbiddenRoots: input.projectRoot
      ? [
          `${input.projectRoot}/ssl`,
          `${input.projectRoot}/test/certs`,
          `${input.projectRoot}/packages/codemate/ssl`,
        ]
      : undefined,
  })
  const requiredPaths = fromPrompt?.required_paths.length ? fromPrompt.required_paths : inferred.required_paths
  const targetPaths = fromPrompt?.target_paths.length ? fromPrompt.target_paths : requiredPaths
  const sandboxPaths = fromPrompt?.sandbox_paths.length ? fromPrompt.sandbox_paths : []
  const allowedFallbackPaths = fromPrompt?.fallback_paths.length ? fromPrompt.fallback_paths : inferred.fallback_paths
  const allowedSearchRoots = fromPrompt?.allowed_search_roots.length
    ? fromPrompt.allowed_search_roots
    : inferred.allowed_search_roots
  const forbiddenSearchRoots = fromPrompt?.forbidden_search_roots.length
    ? fromPrompt.forbidden_search_roots
    : inferred.forbidden_search_roots
  if (requiredPaths.length === 0) return
  const requiredAbsolutePaths = ensureAbsolutePathList(requiredPaths, { cwd: input.projectRoot })
  const targetAbsolutePaths = ensureAbsolutePathList(targetPaths, { cwd: input.projectRoot })
  const sandboxAbsolutePaths = ensureAbsolutePathList(sandboxPaths, { cwd: input.projectRoot })
  const allowedPathSet = new Set([
    ...requiredAbsolutePaths.map((item) => normalizePosixPath(item)),
    ...targetAbsolutePaths.map((item) => normalizePosixPath(item)),
    ...sandboxAbsolutePaths.map((item) => normalizePosixPath(item)),
    ...allowedFallbackPaths.map((item) => normalizePosixPath(item)),
  ])
  const output = input.resultText
  const lower = output.toLowerCase()
  const mentionedPaths = resolveActualOutputPathsFromText(output, { cwd: input.projectRoot })
  const actualOutputPaths = [...new Set(mentionedPaths.filter((path) => allowedPathSet.has(normalizePosixPath(path))))]
  const forbiddenPathsSeen = new Set<string>()

  for (const pattern of STALE_ARTIFACT_PATTERNS) {
    if (!pattern.test(lower)) continue
    const staleCandidate = mentionedPaths.find((path) => pattern.test(path.toLowerCase()))
    forbiddenPathsSeen.add(staleCandidate ?? pattern.source)
  }

  for (const forbidden of hasForbiddenPath(mentionedPaths, forbiddenSearchRoots)) {
    forbiddenPathsSeen.add(forbidden)
  }

  if (forbiddenPathsSeen.size > 0) {
    const forbidden = [...forbiddenPathsSeen].slice(0, 6)
    return {
      category: "stale_artifact",
      reason: [
        `Coder output referenced stale workspace artifact paths: ${forbidden.join(", ")}`,
        `Allowed paths: ${requiredPaths.join(", ")}; fallback: ${allowedFallbackPaths.join(", ") || "(none)"}`,
      ].join(". "),
      requiredPaths,
      fallbackPaths: allowedFallbackPaths,
      allowedFallbackPaths,
      actualOutputPaths,
      forbiddenPathsSeen: forbidden,
      repairInstruction:
        "Retry implementation using only required_paths or runtime-provided absolute fallback_paths; do not reuse stale workspace artifacts.",
    }
  }

  const wrongPathHits = new Set<string>()
  for (const requiredPath of [...requiredPaths, ...requiredAbsolutePaths]) {
    const base = outputBasename(requiredPath)
    const directPathRegex = new RegExp(`(/[^\\s"'\\\`<>()]*${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi")
    const homePathRegex = new RegExp(`(~/[^\\s"'\\\`<>()]*${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi")
    const directMatches = [...(output.match(directPathRegex) ?? []), ...(output.match(homePathRegex) ?? [])]
    for (const hit of directMatches) {
      const normalizedHit = normalizePosixPath(hit)
      if (allowedPathSet.has(normalizedHit)) continue
      wrongPathHits.add(normalizedHit)
    }
    if (
      directMatches.length === 0 &&
      lower.includes(base.toLowerCase()) &&
      !lower.includes(requiredPath.toLowerCase()) &&
      !allowedFallbackPaths.some((path) => lower.includes(path.toLowerCase())) &&
      !requiredAbsolutePaths.some((path) => lower.includes(path.toLowerCase()))
    ) {
      wrongPathHits.add(base)
    }
  }
  if (wrongPathHits.size > 0) {
    const forbidden = [...wrongPathHits].slice(0, 6)
    return {
      category: "wrong_path",
      reason: [
        `Coder output referenced unexpected artifact paths: ${forbidden.join(", ")}`,
        `Allowed paths: ${requiredPaths.join(", ")}; fallback: ${allowedFallbackPaths.join(", ") || "(none)"}`,
      ].join(". "),
      requiredPaths,
      fallbackPaths: allowedFallbackPaths,
      allowedFallbackPaths,
      actualOutputPaths,
      forbiddenPathsSeen: forbidden,
      repairInstruction:
        "Retry implementation using only required_paths or runtime-provided absolute fallback_paths; do not reuse stale workspace artifacts.",
    }
  }

  if (allowedSearchRoots.length > 0 && mentionedPaths.length > 0) {
    const outOfScope = mentionedPaths.filter((candidate) => {
      const normalized = normalizePosixPath(candidate)
      return !allowedSearchRoots.some((root) => normalized === root || normalized.startsWith(`${root}/`))
    })
    if (outOfScope.length > 0) {
      return {
        category: "wrong_path",
        reason: [
          `Coder output referenced paths outside allowed search roots: ${[...new Set(outOfScope)].slice(0, 6).join(", ")}`,
          `Allowed roots: ${allowedSearchRoots.join(", ") || "(none)"}`,
        ].join(". "),
        requiredPaths,
        fallbackPaths: allowedFallbackPaths,
        allowedFallbackPaths,
        actualOutputPaths,
        forbiddenPathsSeen: [...new Set(outOfScope)].slice(0, 6),
        repairInstruction:
          "Retry implementation using only required_paths or runtime-provided absolute fallback_paths; do not search outside allowed roots.",
      }
    }
  }
  return
}

function detectExistingFileCurrentRunEvidenceFailure(input: {
  resultText: string
  projectRoot?: string
  requiredPaths: string[]
  fallbackPaths: string[]
  preRunExists: Map<string, boolean>
  fileWriteEvidence: FileWriteEvidence[]
}): FileWriteVerificationFailure | undefined {
  if (input.fileWriteEvidence.length === 0) return
  const allowedPaths = ensureAbsolutePathList([...input.requiredPaths, ...input.fallbackPaths], { cwd: input.projectRoot })
  if (allowedPaths.length === 0) return
  const allowedSet = new Set(allowedPaths.map((item) => normalizePosixPath(item)))
  const mentioned = resolveActualOutputPathsFromText(input.resultText, {
    cwd: input.projectRoot,
    allowedPaths,
  }).map((item) => normalizePosixPath(item))
  if (mentioned.length === 0) return
  const verifiedSet = new Set(
    input.fileWriteEvidence
      .filter(
        (entry) =>
          entry.file_path &&
          typeof entry.mtime_ms === "number" &&
          typeof entry.sha256 === "string" &&
          entry.sha256.trim().length > 0 &&
          typeof entry.readback_fragment === "string" &&
          entry.readback_fragment.trim().length > 0,
      )
      .map((entry) => normalizePosixPath(entry.file_path)),
  )
  const missing = mentioned.find((candidate) => {
    if (!allowedSet.has(candidate)) return false
    if (!input.preRunExists.get(candidate)) return false
    return !verifiedSet.has(candidate)
  })
  if (!missing) return
  return {
    category: "file_write_verification_failed",
    reason: `existing target path lacks current-run write evidence: ${missing}`,
    toolName: "write",
    filePath: missing,
    repairInstruction: "retry write/edit and capture mtime/hash/readback evidence for existing target files",
  }
}

function detectFileWriteOutsideAllowedRoots(input: {
  fileWriteEvidence: FileWriteEvidence[]
  allowedSearchRoots: string[]
}): GuardFailure | undefined {
  if (input.fileWriteEvidence.length === 0) return
  const allowedRoots = input.allowedSearchRoots.map((item) => normalizePosixPath(item)).filter(Boolean)
  if (allowedRoots.length === 0) return
  const outside = input.fileWriteEvidence
    .map((entry) => normalizePosixPath(entry.file_path))
    .filter((filepath) => filepath.length > 0 && !allowedRoots.some((root) => filepath === root || filepath.startsWith(`${root}/`)))
  if (outside.length === 0) return
  return {
    category: "wrong_path",
    reason: `write/edit attempted outside allowed search roots: ${[...new Set(outside)].slice(0, 8).join(", ")}`,
    requiredPaths: [],
    fallbackPaths: [],
    allowedFallbackPaths: [],
    actualOutputPaths: [],
    forbiddenPathsSeen: [...new Set(outside)].slice(0, 8),
    repairInstruction: "retry using only runtime-provided sandbox paths; do not write outside allowed_search_roots.",
  }
}

const collectFileWriteEvidence = Effect.fn("TaskTool.collectFileWriteEvidence")(function* (input: {
  sessionID: SessionID
  sinceMessageID?: MessageID
}) {
  const { sessionID, sinceMessageID } = input
  const messages = yield* MessageV2.filterCompactedEffect(sessionID).pipe(Effect.orElseSucceed(() => []))
  const scopedMessages = (() => {
    if (!sinceMessageID) return messages
    const index = messages.findIndex((message) => message.info.id === sinceMessageID)
    if (index < 0) return messages
    return messages.slice(index + 1)
  })()
  const evidence = new Map<string, FileWriteEvidence>()
  for (const message of scopedMessages) {
    for (const part of message.parts) {
      if (part.type !== "tool") continue
      if (part.tool !== "write" && part.tool !== "edit") continue
      if (part.state.status !== "completed") continue
      const metadata = (part.state.metadata ?? {}) as Record<string, unknown>
      const verification = (metadata.verification ?? {}) as Record<string, unknown>
      const input = (part.state.input ?? {}) as Record<string, unknown>
      const filePath =
        typeof verification.file_path === "string"
          ? verification.file_path
          : typeof metadata.filepath === "string"
            ? metadata.filepath
            : typeof input.filePath === "string"
              ? input.filePath
              : ""
      if (!filePath) continue
      const mtimeMs = typeof verification.mtime_ms === "number" ? verification.mtime_ms : undefined
      const sha256 = typeof verification.sha256 === "string" ? verification.sha256 : undefined
      const readbackFragment =
        typeof verification.readback_fragment === "string" ? verification.readback_fragment : undefined
      const hasVerifiedReadback =
        typeof mtimeMs === "number" &&
        typeof sha256 === "string" &&
        sha256.trim().length > 0 &&
        typeof readbackFragment === "string" &&
        readbackFragment.trim().length > 0
      if (!hasVerifiedReadback) continue
      evidence.set(filePath, {
        file_path: filePath,
        tool: part.tool,
        mtime_ms: mtimeMs,
        sha256,
        readback_fragment: readbackFragment,
        existed_before: typeof metadata.exists === "boolean" ? metadata.exists : undefined,
      })
    }
  }
  return [...evidence.values()]
})

const collectInvalidToolCallEvidence = Effect.fn("TaskTool.collectInvalidToolCallEvidence")(function* (input: {
  sessionID: SessionID
  sinceMessageID?: MessageID
}) {
  const { sessionID, sinceMessageID } = input
  const messages = yield* MessageV2.filterCompactedEffect(sessionID).pipe(Effect.orElseSucceed(() => []))
  const scopedMessages = (() => {
    if (!sinceMessageID) return messages
    const index = messages.findIndex((message) => message.info.id === sinceMessageID)
    if (index < 0) return messages
    return messages.slice(index + 1)
  })()
  const failures: ToolCallInvalidFailure[] = []
  for (const message of scopedMessages) {
    for (const part of message.parts) {
      if (part.type !== "tool") continue
      if (part.tool !== "invalid") continue
      const inputData = (part.state.input ?? {}) as Record<string, unknown>
      const metadata = (part.state.status === "completed" ? part.state.metadata : undefined) as Record<string, unknown> | undefined
      const toolName =
        typeof inputData.tool === "string" && inputData.tool.trim().length > 0
          ? inputData.tool.trim()
          : typeof metadata?.tool === "string" && metadata.tool.trim().length > 0
            ? metadata.tool.trim()
            : "unknown"
      const errorCategory =
        inputData.error_category === "unknown_tool" || inputData.error_category === "invalid_tool_call"
          ? inputData.error_category
          : metadata?.error_category === "unknown_tool" || metadata?.error_category === "invalid_tool_call"
            ? metadata.error_category
            : "invalid_tool_call"
      const repairInstruction =
        typeof inputData.repair_instruction === "string" && inputData.repair_instruction.trim().length > 0
          ? inputData.repair_instruction.trim()
          : typeof metadata?.repair_instruction === "string" && metadata.repair_instruction.trim().length > 0
            ? metadata.repair_instruction.trim()
            : looksLikeShellCommandToolName(toolName)
              ? "use bash tool for shell commands"
              : "use only registered tools"
      failures.push({
        category: "tool_call_invalid",
        reason:
          typeof inputData.error === "string" && inputData.error.trim().length > 0
            ? inputData.error.trim()
            : "invalid tool call generated by model",
        toolName,
        errorCategory,
        repairInstruction,
      })
    }
  }
  return failures
})

const snapshotPathExistence = Effect.fn("TaskTool.snapshotPathExistence")(function* (paths: string[]) {
  const normalized = [...new Set(paths.map((item) => normalizePosixPath(item)).filter((item) => item.length > 0))]
  const entries = yield* Effect.forEach(normalized, (candidate) =>
    Effect.promise(async () => {
      try {
        await access(candidate, constants.F_OK)
        return [candidate, true] as const
      } catch {
        return [candidate, false] as const
      }
    }),
  )
  return new Map(entries)
})

export const Parameters = Schema.Struct({
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  task_id: Schema.optional(Schema.String).annotate({
    description:
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
  }),
  command: Schema.optional(Schema.String).annotate({ description: "The command that triggered this task" }),
})

export const TaskTool = Tool.define<typeof Parameters, Metadata, Agent.Service | Config.Service | Session.Service | SessionClosedLoop.Service>(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const loop = yield* SessionClosedLoop.Service

    const run = Effect.fn("TaskTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const cfg = yield* config.get()
      const legacy = LEGACY_SUBAGENT_ALIAS[params.subagent_type]
      if (legacy) {
        return yield* Effect.fail(
          new Error(
            `Subagent "${params.subagent_type}" has been removed. Use "${legacy}" instead (migration: general->coder, explore->planner, scout->research).`,
          ),
        )
      }

      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: id,
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }

      const next = yield* agent.get(params.subagent_type)
      if (!next) {
        return yield* Effect.fail(new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`))
      }
      const taskText = `${params.description}\n${params.prompt}`
      if (next.name === "coder" && inferNeedsShellPreflight(taskText)) {
        const preflight = yield* Effect.promise(() =>
          preflightShellTool({
            shell: cfg.shell,
            requireOpenSSL: inferNeedsOpenSSL(taskText),
          }),
        )
        if (!preflight.available) {
          return yield* Effect.fail(
            new Error(
              `[tool_unavailable] bash tool preflight failed: ${preflight.reason ?? "shell tooling unavailable for this task"}`,
            ),
          )
        }
      }
      const isResearchTask = next.name === "research"
      const promptText = `${params.description}\n${params.prompt}`.toLowerCase()
      const wantsRefresh = ["latest", "refresh", "重新", "最新", "实时", "today"].some((word) => promptText.includes(word))

      if (isResearchTask) {
        const cached = yield* loop.findResearchLesson({
          topic: `${params.description}\n${params.prompt}`,
          tags: [next.name],
          refresh: wantsRefresh,
        })
        if (cached) {
          return {
            title: `${params.description} (reused research)`,
            metadata: {
              sessionId: undefined,
              model: undefined,
              reused: true,
              fingerprint: cached.fingerprint,
            },
            output: [
              "reused_research: true",
              "",
              "<task_result>",
              cached.lesson,
              "</task_result>",
            ].join("\n"),
          }
        }
      }

      const taskID = params.task_id
      const session = taskID
        ? yield* sessions.get(SessionID.make(taskID)).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined
      const parent = yield* sessions.get(ctx.sessionID)
      const parentAgent = parent.agent
        ? yield* agent.get(parent.agent).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined
      const nextSession =
        session ??
        (yield* sessions.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${next.name} subagent)`,
          permission: [
            ...deriveSubagentSessionPermission({
              parentSessionPermission: parent.permission ?? [],
              parentAgent,
              subagent: next,
            }),
            ...(cfg.experimental?.primary_tools?.map((item) => ({
              pattern: "*",
              action: "allow" as const,
              permission: item,
            })) ?? []),
          ],
        }))

      const msg = yield* Effect.sync(() => MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }))
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))

      const model = next.model ?? {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }

      yield* ctx.metadata({
        title: params.description,
        metadata: {
          sessionId: nextSession.id,
          model,
        },
      })

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))
      const runCancel = yield* EffectBridge.make()

      const messageID = MessageID.ascending()
      const cancel = ops.cancel(nextSession.id)

      function onAbort() {
        runCancel.fork(cancel)
      }

      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          ctx.abort.addEventListener("abort", onAbort)
        }),
        () =>
          Effect.gen(function* () {
            const taskTextWithDescription = `${params.description}\n${params.prompt}`
            const inferredPathContext =
              next.name === "coder"
                ? (() => {
                    const fromPrompt = parsePathContextBlock(taskTextWithDescription)
                    if (fromPrompt) return fromPrompt
                    const requiredPaths = extractRequiredPaths(taskTextWithDescription)
                    const fallbackPaths = resolveFallbackPaths(requiredPaths, { cwd: process.cwd() })
                    const allowedAbsolute = ensureAbsolutePathList([...requiredPaths, ...fallbackPaths], {
                      cwd: process.cwd(),
                    })
                    return {
                      required_paths: requiredPaths,
                      target_paths: requiredPaths,
                      sandbox_paths: [],
                      fallback_paths: fallbackPaths,
                      actual_output_paths: [],
                      allowed_search_roots: [...new Set(allowedAbsolute.map((item) => normalizePosixPath(item).split("/").slice(0, -1).join("/") || "/"))],
                      forbidden_search_roots: ["/"],
                    }
                  })()
                : undefined
            const pathConstraintInstruction = inferredPathContext
              ? renderPathConstraintInstruction({
                  requiredPaths: inferredPathContext.required_paths,
                  targetPaths: inferredPathContext.target_paths,
                  sandboxPaths: inferredPathContext.sandbox_paths,
                  fallbackPaths: inferredPathContext.fallback_paths,
                  allowedSearchRoots: inferredPathContext.allowed_search_roots,
                  forbiddenSearchRoots: inferredPathContext.forbidden_search_roots,
                })
              : undefined
            const absoluteConstraintPaths = inferredPathContext
              ? ensureAbsolutePathList(
                  [...inferredPathContext.required_paths, ...inferredPathContext.fallback_paths],
                  { cwd: process.cwd() },
                )
              : []
            const preRunPathExistence =
              next.name === "coder" && absoluteConstraintPaths.length > 0
                ? yield* snapshotPathExistence(absoluteConstraintPaths)
                : new Map<string, boolean>()
            const promptWithConstraint = pathConstraintInstruction
              ? `${params.prompt}\n\n${pathConstraintInstruction}`
              : params.prompt
            const parts = yield* ops.resolvePromptParts(promptWithConstraint)
            const inheritedLanguageRule = ctx.messages
              .slice()
              .reverse()
              .flatMap((item) => {
                if (item.info.role !== "user") return []
                const rule = LanguageRule.extractLanguageRule(item.info.system)
                if (!rule) return []
                return [rule]
              })[0]
            const result = yield* ops
              .prompt({
                messageID,
                sessionID: nextSession.id,
                model: {
                  modelID: model.modelID,
                  providerID: model.providerID,
                },
                agent: next.name,
                system: inheritedLanguageRule,
                tools: {
                  ...(next.permission.some((rule) => rule.permission === "todowrite") ? {} : { todowrite: false }),
                  ...(next.permission.some((rule) => rule.permission === id) ? {} : { task: false }),
                  ...Object.fromEntries((cfg.experimental?.primary_tools ?? []).map((item) => [item, false])),
                },
                parts,
              })
              .pipe(
                Effect.catchCause((cause) => {
                  if (next.name !== "coder") return Effect.failCause(cause)
                  const squashed = Cause.squash(cause)
                  const invalidToolFailure = detectCoderToolCallInvalidFailure(squashed)
                  if (invalidToolFailure) {
                    const payload = {
                      category: invalidToolFailure.category,
                      tool_name: invalidToolFailure.toolName,
                      error_category: invalidToolFailure.errorCategory,
                      repair_instruction: invalidToolFailure.repairInstruction,
                      reason: invalidToolFailure.reason,
                    }
                    return Effect.fail(new Error(`[tool_call_invalid] ${JSON.stringify(payload)}`))
                  }
                  const writeVerificationFailure = detectCoderFileWriteVerificationFailure(squashed)
                  if (writeVerificationFailure) {
                    const payload = {
                      category: writeVerificationFailure.category,
                      tool_name: writeVerificationFailure.toolName,
                      file_path: writeVerificationFailure.filePath,
                      expected_fragment: writeVerificationFailure.expectedFragment,
                      readback_fragment: writeVerificationFailure.readbackFragment,
                      repair_instruction: writeVerificationFailure.repairInstruction,
                      reason: writeVerificationFailure.reason,
                    }
                    return Effect.fail(new Error(`[file_write_verification_failed] ${JSON.stringify(payload)}`))
                  }
                  const schemaFailure = detectCoderToolSchemaFailure(squashed)
                  if (!schemaFailure) return Effect.failCause(cause)
                  const payload = {
                    category: schemaFailure.category,
                    tool_name: schemaFailure.toolName,
                    error_category: schemaFailure.errorCategory,
                    missing_field: schemaFailure.missingField,
                    repair_instruction: schemaFailure.repairInstruction,
                    reason: schemaFailure.reason,
                  }
                  return Effect.fail(new Error(`[tool_schema_error] ${JSON.stringify(payload)}`))
                }),
              )
            const resultText = result.parts.findLast((item) => item.type === "text")?.text ?? ""
            const fileWriteEvidence =
              next.name === "coder"
                ? yield* collectFileWriteEvidence({
                    sessionID: nextSession.id,
                    sinceMessageID: messageID,
                  })
                : []
            if (next.name === "coder") {
              const invalidToolFailures = yield* collectInvalidToolCallEvidence({
                sessionID: nextSession.id,
                sinceMessageID: messageID,
              })
              const lastInvalid = invalidToolFailures.at(-1)
              if (lastInvalid) {
                const payload = {
                  category: "tool_call_invalid",
                  tool_name: lastInvalid.toolName,
                  error_category: lastInvalid.errorCategory,
                  repair_instruction: lastInvalid.repairInstruction,
                  reason: lastInvalid.reason,
                }
                return yield* Effect.fail(new Error(`[tool_call_invalid] ${JSON.stringify(payload)}`))
              }
              const writeEvidenceFailure = inferredPathContext
                ? detectExistingFileCurrentRunEvidenceFailure({
                    resultText,
                    projectRoot: process.cwd(),
                    requiredPaths: inferredPathContext.required_paths,
                    fallbackPaths: inferredPathContext.fallback_paths,
                    preRunExists: preRunPathExistence,
                    fileWriteEvidence,
                  })
                : undefined
              if (writeEvidenceFailure) {
                const payload = {
                  category: writeEvidenceFailure.category,
                  tool_name: writeEvidenceFailure.toolName,
                  file_path: writeEvidenceFailure.filePath,
                  expected_fragment: writeEvidenceFailure.expectedFragment,
                  readback_fragment: writeEvidenceFailure.readbackFragment,
                  repair_instruction: writeEvidenceFailure.repairInstruction,
                  reason: writeEvidenceFailure.reason,
                }
                return yield* Effect.fail(new Error(`[file_write_verification_failed] ${JSON.stringify(payload)}`))
              }
              const outOfRootWriteFailure = inferredPathContext
                ? detectFileWriteOutsideAllowedRoots({
                    fileWriteEvidence,
                    allowedSearchRoots: inferredPathContext.allowed_search_roots,
                  })
                : undefined
              if (outOfRootWriteFailure) {
                const payload = {
                  category: outOfRootWriteFailure.category,
                  required_paths: outOfRootWriteFailure.requiredPaths ?? [],
                  fallback_paths: outOfRootWriteFailure.fallbackPaths ?? outOfRootWriteFailure.allowedFallbackPaths ?? [],
                  allowed_fallback_paths: outOfRootWriteFailure.allowedFallbackPaths ?? [],
                  actual_output_paths: outOfRootWriteFailure.actualOutputPaths ?? [],
                  forbidden_paths_seen: outOfRootWriteFailure.forbiddenPathsSeen ?? [],
                  repair_instruction: outOfRootWriteFailure.repairInstruction,
                  reason: outOfRootWriteFailure.reason,
                }
                return yield* Effect.fail(new Error(`[${outOfRootWriteFailure.category}] ${JSON.stringify(payload)}`))
              }
              const guardFailure = detectCoderPathGuardFailure({
                description: params.description,
                prompt: promptWithConstraint,
                projectRoot: process.cwd(),
                resultText,
              })
              if (guardFailure) {
                const payload = {
                  category: guardFailure.category,
                  required_paths: guardFailure.requiredPaths ?? [],
                  fallback_paths: guardFailure.fallbackPaths ?? guardFailure.allowedFallbackPaths ?? [],
                  allowed_fallback_paths: guardFailure.allowedFallbackPaths ?? [],
                  actual_output_paths: guardFailure.actualOutputPaths ?? [],
                  forbidden_paths_seen: guardFailure.forbiddenPathsSeen ?? [],
                  repair_instruction:
                    guardFailure.repairInstruction ??
                    "Retry implementation using only required_paths or runtime-provided absolute fallback_paths; do not reuse stale workspace artifacts.",
                  reason: guardFailure.reason,
                }
                return yield* Effect.fail(new Error(`[${guardFailure.category}] ${JSON.stringify(payload)}`))
              }
            }
            const researchLesson = resultText.trim()
            const trimmedEvidence = fileWriteEvidence.length > 0 ? fileWriteEvidence.slice(0, 12) : undefined
            return {
              title: params.description,
              metadata: {
                sessionId: nextSession.id,
                model,
                ...(trimmedEvidence ? { file_write_evidence: trimmedEvidence } : {}),
                ...(isResearchTask && researchLesson.length >= MIN_RESEARCH_LESSON_CHARS
                  ? {
                      researchDraft: {
                        topic: `${params.description}\n${params.prompt}`,
                        lesson: researchLesson.slice(0, 800),
                        detail: `subagent=${next.name}`,
                        fix: "reuse this research summary for similar tasks unless user requests refresh",
                        tags: ["research"],
                      },
                    }
                  : {}),
              },
              output: [
                `task_id: ${nextSession.id} (for resuming to continue this task if needed)`,
                "",
                "<task_result>",
                resultText,
                "</task_result>",
              ].join("\n"),
            }
          }),
        (_, exit) =>
          Effect.gen(function* () {
            if (Exit.hasInterrupts(exit)) yield* cancel
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                ctx.abort.removeEventListener("abort", onAbort)
              }),
            ),
          ),
      )
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(
          Effect.catchCause((cause) => {
            const firstDie = Cause.findDie(cause)
            const firstFail = Cause.findFail(cause)
            const pretty = (() => {
              try {
                return Cause.pretty(cause).trim()
              } catch (error) {
                return `Unable to pretty-print cause: ${error instanceof Error ? error.message : String(error)}`
              }
            })()
            const failValue =
              firstFail._tag === "Success" && firstFail && typeof firstFail === "object" && "value" in firstFail
                ? firstFail.value
                : undefined
            if (failValue instanceof Error) {
              return Effect.die(failValue)
            }
            if (typeof failValue === "string" && failValue.trim().length > 0) {
              return Effect.die(new Error(failValue))
            }
            const nullFail =
              !!failValue &&
              typeof failValue === "object" &&
              "_tag" in failValue &&
              failValue["_tag"] === "Fail" &&
              "error" in failValue &&
              (failValue["error"] === null || failValue["error"] === undefined)
            const dieDetail = firstDie._tag === "Success" ? ` first_defect=${JSON.stringify(firstDie)}` : ""
            const failDetail = firstFail._tag === "Success" ? ` first_fail=${JSON.stringify(firstFail)}` : ""
            const nullHint = nullFail
              ? " null_fail_hint=Cause contains Fail(null/undefined); likely missing/unexpected agent mock response."
              : ""
            return Effect.die(
              new Error(pretty || `TaskTool.execute failed with unknown cause.${dieDetail}${failDetail}${nullHint}`),
            )
          }),
        ),
    }
  }),
)
