import { ulid } from "ulid"
import { appendFile, mkdir } from "fs/promises"
import path from "path"
import os from "os"
import { AGENT_ROLE_QUALITY_SIGNAL_ALLOWLIST, agentRoleFromName, type QualitySignalKey } from "@/agent/role-capability"
import { parsePathContextBlock } from "@/session/path-context"

export type TrajectoryAgent =
  | "planner"
  | "research"
  | "coder"
  | "tester"
  | "reviewer"
  | "writer"
  | "orchestrator"
  | "selfcheck"

export type TrajectoryOutcome = "success" | "failure" | "recovered" | "cancelled" | "skipped"

export type TrajectoryRecord = {
  id: string
  run_id: string
  task_id?: string
  task_graph_id?: string
  source_user_message_id?: string
  intent_anchor_hash?: string

  agent: TrajectoryAgent
  action_summary: string

  expected_outputs: string[]
  actual_outputs: string[]

  artifact_paths: string[]
  commands_run: string[]
  verification_results: string[]
  tool_results: string[]

  outcome: TrajectoryOutcome

  quality_signals: {
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

  evidence_refs?: string[]
  created_at: string
}

export type PersistedTrajectoryRecord = TrajectoryRecord & {
  version: 1
  project_root?: string
}

export type TrajectoryReadOptions = {
  limit?: number
  run_id?: string
  agent?: TrajectoryAgent
  outcome?: TrajectoryOutcome
  since?: string
  task_id?: string
}

export type TrajectoryReadResult = {
  records: PersistedTrajectoryRecord[]
  warnings: string[]
}

export type TrajectorySearchInput = TrajectoryReadOptions & {
  query?: string
}

export type TrajectoryAppendResult = {
  written: boolean
  path: string
  record?: PersistedTrajectoryRecord
  warning?: string
}

type TrajectorySubtaskLike = {
  id?: string
  task_id?: string
  task_role?: string
  agent?: string
  description?: string
  prompt?: string
}

type ExtractTrajectoryInput = {
  run_id: string
  task_graph_id?: string
  source_user_message_id?: string
  intent_anchor_hash?: string
  task: TrajectorySubtaskLike
  output?: string
  metadata?: Record<string, unknown>
  outcome: TrajectoryOutcome
  quality_signals?: TrajectoryRecord["quality_signals"]
  failure?: TrajectoryRecord["failure"]
  recovery?: TrajectoryRecord["recovery"]
  evidence_refs?: string[]
}

export type ArtifactPathSanitizeResult = {
  accepted_paths: string[]
  rejected_paths: string[]
  warnings: string[]
}

function compactText(input: string, max = 220) {
  const normalized = input.replace(/\s+/g, " ").trim()
  if (!normalized) return ""
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, Math.max(0, max - 15)).trimEnd()}...[truncated]`
}

const PRIVATE_KEY_BLOCK_PATTERN = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/gi
const CERTIFICATE_PEM_BLOCK_PATTERN = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gi
const TOKEN_ASSIGNMENT_PATTERN =
  /(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|bearer|token|secret|password)\b\s*[:=]\s*)([^\s,;]+)/gi
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._-]{8,}\b/gi
const OPENAI_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{10,}\b/g
const BINARY_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/

function redactSensitiveText(input: string, maxChars = 240) {
  if (!input) return ""
  if (BINARY_PATTERN.test(input)) return "[REDACTED_BINARY_CONTENT]"
  const redacted = input
    .replace(PRIVATE_KEY_BLOCK_PATTERN, "[REDACTED_PRIVATE_KEY_BLOCK]")
    .replace(CERTIFICATE_PEM_BLOCK_PATTERN, "[REDACTED_CERTIFICATE_PEM_BLOCK]")
    .replace(TOKEN_ASSIGNMENT_PATTERN, (_m, prefix: string) => `${prefix}[REDACTED]`)
    .replace(BEARER_TOKEN_PATTERN, "Bearer [REDACTED]")
    .replace(OPENAI_KEY_PATTERN, "[REDACTED_API_KEY]")
  return compactText(redacted, maxChars)
}

function sanitizeToolResults(toolResults: string[]) {
  return normalizeList(toolResults, { maxItems: 10, maxChars: 260 }).flatMap((entry) => {
    const normalized = redactSensitiveText(entry, 260)
    if (!normalized) return []
    const lower = normalized.toLowerCase()
    if (
      lower.includes("full transcript") ||
      lower.includes("full tool log") ||
      lower.includes("stdout dump") ||
      lower.includes("stderr dump")
    ) {
      return []
    }
    return [normalized]
  })
}

export function toPersistedTrajectoryRecord(
  record: TrajectoryRecord | PersistedTrajectoryRecord,
  input?: { projectRoot?: string },
): PersistedTrajectoryRecord {
  const recordProjectRoot =
    "project_root" in record && typeof record.project_root === "string" ? record.project_root : undefined
  return {
    ...record,
    version: 1,
    project_root: input?.projectRoot ?? recordProjectRoot,
    action_summary: redactSensitiveText(record.action_summary, 220),
    expected_outputs: normalizeList(record.expected_outputs.map((item) => redactSensitiveText(item, 220)), {
      maxItems: 12,
      maxChars: 220,
    }),
    actual_outputs: normalizeList(record.actual_outputs.map((item) => redactSensitiveText(item, 260)), {
      maxItems: 14,
      maxChars: 260,
    }),
    artifact_paths: normalizeList(record.artifact_paths.map((item) => redactSensitiveText(item, 200)), {
      maxItems: 16,
      maxChars: 200,
    }),
    commands_run: normalizeList(record.commands_run.map((item) => redactSensitiveText(item, 220)), {
      maxItems: 12,
      maxChars: 220,
    }),
    verification_results: normalizeList(record.verification_results.map((item) => redactSensitiveText(item, 240)), {
      maxItems: 12,
      maxChars: 240,
    }),
    tool_results: sanitizeToolResults(record.tool_results),
    failure: record.failure
      ? {
          signal: redactSensitiveText(record.failure.signal, 220),
          failed_behavior: record.failure.failed_behavior
            ? redactSensitiveText(record.failure.failed_behavior, 220)
            : undefined,
          wrong_artifacts: normalizeList(
            (record.failure.wrong_artifacts ?? []).map((item) => redactSensitiveText(item, 200)),
            { maxItems: 8, maxChars: 200 },
          ),
          root_cause: record.failure.root_cause ? redactSensitiveText(record.failure.root_cause, 220) : undefined,
        }
      : undefined,
    recovery: record.recovery
      ? {
          repair_action: redactSensitiveText(record.recovery.repair_action, 220),
          corrected_artifacts: normalizeList(
            (record.recovery.corrected_artifacts ?? []).map((item) => redactSensitiveText(item, 200)),
            { maxItems: 8, maxChars: 200 },
          ),
          success_signal: redactSensitiveText(record.recovery.success_signal, 220),
        }
      : undefined,
    evidence_refs: normalizeList((record.evidence_refs ?? []).map((item) => redactSensitiveText(item, 220)), {
      maxItems: 10,
      maxChars: 220,
    }),
  } satisfies PersistedTrajectoryRecord
}

export function pathProjectTrajectories(projectRoot: string) {
  return path.join(projectRoot, ".codemate", "trajectories.jsonl")
}

export async function appendTrajectoryRecord(projectRoot: string, record: TrajectoryRecord): Promise<TrajectoryAppendResult> {
  const file = pathProjectTrajectories(projectRoot)
  const persisted = toPersistedTrajectoryRecord(record, { projectRoot })
  try {
    await mkdir(path.dirname(file), { recursive: true })
    await appendFile(file, `${JSON.stringify(persisted)}\n`, "utf8")
    return {
      written: true,
      path: file,
      record: persisted,
    }
  } catch (error) {
    return {
      written: false,
      path: file,
      warning: `append trajectory failed: ${error instanceof Error ? error.message : String(error)}`,
      record: persisted,
    }
  }
}

function parseSince(input: string | undefined) {
  if (!input?.trim()) return
  const parsed = Date.parse(input)
  if (Number.isNaN(parsed)) return
  return parsed
}

export async function readTrajectoryRecords(projectRoot: string, options: TrajectoryReadOptions = {}): Promise<TrajectoryReadResult> {
  const file = pathProjectTrajectories(projectRoot)
  const source = Bun.file(file)
  if (!(await source.exists())) {
    return { records: [], warnings: [] }
  }
  const warnings: string[] = []
  const lines = (await source.text())
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const parsed = lines.flatMap((line, index) => {
    try {
      const value = JSON.parse(line) as Record<string, unknown>
      if (!value || typeof value !== "object") {
        warnings.push(`invalid trajectory line ${index + 1}: not an object`)
        return []
      }
      const base = value as Partial<PersistedTrajectoryRecord>
      const merged = toPersistedTrajectoryRecord(
        createTrajectoryRecord({
          id: typeof base.id === "string" ? base.id : undefined,
          created_at: typeof base.created_at === "string" ? base.created_at : undefined,
          run_id: typeof base.run_id === "string" ? base.run_id : "unknown",
          task_id: typeof base.task_id === "string" ? base.task_id : undefined,
          task_graph_id: typeof base.task_graph_id === "string" ? base.task_graph_id : undefined,
          source_user_message_id: typeof base.source_user_message_id === "string" ? base.source_user_message_id : undefined,
          intent_anchor_hash: typeof base.intent_anchor_hash === "string" ? base.intent_anchor_hash : undefined,
          agent: typeof base.agent === "string" ? asTrajectoryAgent(base.agent) : "orchestrator",
          action_summary: typeof base.action_summary === "string" ? base.action_summary : "trajectory record",
          expected_outputs: Array.isArray(base.expected_outputs) ? base.expected_outputs.filter((item): item is string => typeof item === "string") : [],
          actual_outputs: Array.isArray(base.actual_outputs) ? base.actual_outputs.filter((item): item is string => typeof item === "string") : [],
          artifact_paths: Array.isArray(base.artifact_paths) ? base.artifact_paths.filter((item): item is string => typeof item === "string") : [],
          commands_run: Array.isArray(base.commands_run) ? base.commands_run.filter((item): item is string => typeof item === "string") : [],
          verification_results: Array.isArray(base.verification_results)
            ? base.verification_results.filter((item): item is string => typeof item === "string")
            : [],
          tool_results: Array.isArray(base.tool_results) ? base.tool_results.filter((item): item is string => typeof item === "string") : [],
          outcome: base.outcome === "success" || base.outcome === "failure" || base.outcome === "recovered" || base.outcome === "cancelled" || base.outcome === "skipped" ? base.outcome : "success",
          quality_signals: typeof base.quality_signals === "object" && base.quality_signals
            ? (base.quality_signals as TrajectoryRecord["quality_signals"])
            : {},
          failure:
            base.failure && typeof base.failure === "object"
              ? {
                  signal: typeof (base.failure as Record<string, unknown>).signal === "string"
                    ? ((base.failure as Record<string, unknown>).signal as string)
                    : "failure",
                  failed_behavior:
                    typeof (base.failure as Record<string, unknown>).failed_behavior === "string"
                      ? ((base.failure as Record<string, unknown>).failed_behavior as string)
                      : undefined,
                  wrong_artifacts:
                    Array.isArray((base.failure as Record<string, unknown>).wrong_artifacts)
                      ? ((base.failure as Record<string, unknown>).wrong_artifacts as unknown[]).filter(
                          (item): item is string => typeof item === "string",
                        )
                      : undefined,
                  root_cause:
                    typeof (base.failure as Record<string, unknown>).root_cause === "string"
                      ? ((base.failure as Record<string, unknown>).root_cause as string)
                      : undefined,
                }
              : undefined,
          recovery:
            base.recovery && typeof base.recovery === "object"
              ? {
                  repair_action:
                    typeof (base.recovery as Record<string, unknown>).repair_action === "string"
                      ? ((base.recovery as Record<string, unknown>).repair_action as string)
                      : "recovery",
                  corrected_artifacts:
                    Array.isArray((base.recovery as Record<string, unknown>).corrected_artifacts)
                      ? ((base.recovery as Record<string, unknown>).corrected_artifacts as unknown[]).filter(
                          (item): item is string => typeof item === "string",
                        )
                      : undefined,
                  success_signal:
                    typeof (base.recovery as Record<string, unknown>).success_signal === "string"
                      ? ((base.recovery as Record<string, unknown>).success_signal as string)
                      : "recovered",
                }
              : undefined,
          evidence_refs: Array.isArray(base.evidence_refs) ? base.evidence_refs.filter((item): item is string => typeof item === "string") : [],
        }),
        { projectRoot: typeof base.project_root === "string" ? base.project_root : projectRoot },
      )
      return [merged]
    } catch {
      warnings.push(`invalid trajectory line ${index + 1}: JSON parse failed`)
      return []
    }
  })
  const since = parseSince(options.since)
  const filtered = parsed.filter((record) => {
    if (options.run_id && record.run_id !== options.run_id) return false
    if (options.agent && record.agent !== options.agent) return false
    if (options.outcome && record.outcome !== options.outcome) return false
    if (options.task_id && record.task_id !== options.task_id) return false
    if (since !== undefined) {
      const createdAt = Date.parse(record.created_at)
      if (Number.isNaN(createdAt) || createdAt < since) return false
    }
    return true
  })
  const ordered = filtered.toSorted((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))
  const limit = options.limit && options.limit > 0 ? Math.floor(options.limit) : undefined
  return {
    records: limit ? ordered.slice(0, limit) : ordered,
    warnings,
  }
}

export async function searchRecentTrajectories(projectRoot: string, input: TrajectorySearchInput): Promise<TrajectoryReadResult> {
  const base = await readTrajectoryRecords(projectRoot, input)
  const query = input.query?.trim().toLowerCase()
  if (!query) return base
  const scored = base.records
    .map((record) => {
      const corpus = [
        record.action_summary,
        ...record.expected_outputs,
        ...record.actual_outputs,
        ...record.artifact_paths,
        ...record.commands_run,
        ...record.verification_results,
        ...(record.failure ? [record.failure.signal, record.failure.failed_behavior ?? "", record.failure.root_cause ?? ""] : []),
        ...(record.recovery ? [record.recovery.repair_action, record.recovery.success_signal] : []),
      ]
        .join(" ")
        .toLowerCase()
      const matches = corpus.includes(query)
      return { record, score: matches ? 1 : 0 }
    })
    .filter((entry) => entry.score > 0)
    .map((entry) => entry.record)
  const limit = input.limit && input.limit > 0 ? Math.floor(input.limit) : undefined
  return {
    records: limit ? scored.slice(0, limit) : scored,
    warnings: base.warnings,
  }
}

function normalizeList(input: string[] | undefined, options?: { maxItems?: number; maxChars?: number }) {
  if (!input || input.length === 0) return []
  const maxItems = options?.maxItems ?? 10
  const maxChars = options?.maxChars ?? 240
  const deduped = [...new Set(input.map((item) => compactText(item, maxChars)).filter(Boolean))]
  return deduped.slice(0, Math.max(1, maxItems))
}

function isThinkingLine(input: string) {
  const trimmed = input.trim()
  return /^_Thinking:_\b/i.test(trimmed) || /^Thinking:\b/i.test(trimmed)
}

function stripThinkingEntries(input: string[] | undefined) {
  if (!input || input.length === 0) return []
  return input.filter((item) => !isThinkingLine(item))
}

const NON_PATH_SEGMENTS = new Set([
  "coder",
  "tester",
  "research",
  "reviewer",
  "writer",
  "shell",
  "file",
  "adapter",
  "script",
  "task",
  "task_result",
])

const HOME_DIR = (() => {
  const raw = (process.env.HOME?.trim() || os.homedir()).trim()
  if (!raw) return
  const normalized = raw.replaceAll("\\", "/").replace(/\/+/g, "/").replace(/\/$/, "")
  return normalized || undefined
})()

function isNonPathToken(input: string) {
  const normalized = input.trim().toLowerCase()
  if (!normalized) return true
  if (/^\d+\/\d+$/.test(normalized)) return true
  if (/[\u3400-\u9fff]/.test(normalized)) return true
  if (normalized === "/task" || normalized === "/task_result") return true
  const segments = normalized.split("/").filter(Boolean)
  if (segments.length > 0 && segments.every((segment) => NON_PATH_SEGMENTS.has(segment))) return true
  return false
}

function normalizePathCandidate(raw: string) {
  const trimmed = raw.trim().replace(/^["'`]+|["'`]+$/g, "")
  if (!trimmed) return
  const cleaned = trimmed.replace(/[),.;:!?]+$/g, "").replaceAll("\\", "/").replace(/\/+/g, "/").replace(/\/$/, "")
  if (!cleaned) return
  const homeAware = cleaned === "~" ? HOME_DIR ?? cleaned : cleaned.startsWith("~/") && HOME_DIR ? `${HOME_DIR}/${cleaned.slice(2)}` : cleaned
  const absoluteHomeAware =
    HOME_DIR && (homeAware === HOME_DIR || homeAware.startsWith(`${HOME_DIR}/`))
      ? homeAware
      : homeAware.startsWith("~/") && HOME_DIR
        ? `${HOME_DIR}/${homeAware.slice(2)}`
        : homeAware
  if (isNonPathToken(absoluteHomeAware)) return
  if (
    absoluteHomeAware.startsWith("/") ||
    absoluteHomeAware.startsWith("./") ||
    absoluteHomeAware.startsWith("../") ||
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./~-]+$/.test(absoluteHomeAware)
  ) {
    return absoluteHomeAware
  }
}

function extractPathCandidates(text: string) {
  const sanitized = text.replace(/<\/?task_result>/gi, " ")
  const tokens = sanitized.match(/(?:~\/|\/|\.\/|\.\.\/)[^\s"'`<>]+|[A-Za-z0-9_.-]+\/[A-Za-z0-9_./~-]+/g) ?? []
  return normalizeList(tokens.flatMap((token) => {
    const normalized = normalizePathCandidate(token)
    if (!normalized) return []
    if (normalized.toLowerCase().includes("task_result")) return []
    if (normalized === "/task_result" || normalized === "task_result") return []
    if (isNonPathToken(normalized)) return []
    return [normalized]
  }), { maxItems: 20, maxChars: 180 })
}

function extractCommandCandidates(text: string) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !isThinkingLine(line))
  const commands = lines.flatMap((line) => {
    const shell = line.startsWith("$ ") ? line.slice(2).trim() : line
    if (
      /^(bun|npm|pnpm|yarn|node|python|python3|pytest|go|cargo|git|chmod|chown|cp|mv|rm|mkdir|openssl|bash|sh)\b/.test(
        shell,
      )
    ) {
      return [shell]
    }
    const ran = line.match(/\b(?:ran|run|executed)\s+`([^`]+)`/i)
    if (ran && ran[1]) return [ran[1]]
    return []
  })
  return normalizeList(commands, { maxItems: 10, maxChars: 180 })
}

function extractVerificationCandidates(text: string) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !isThinkingLine(line))
  return normalizeList(
    lines.filter((line) =>
      /\b(pass|passed|fail|failed|verify|verified|verification|success|succeeded|exit\s*code|approved|rejected)\b/i.test(
        line,
      ),
    ),
    { maxItems: 10, maxChars: 180 },
  )
}

function extractActualOutputLines(text: string) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s+/, ""))
    .filter((line) => line.length > 0 && !isThinkingLine(line))
  return normalizeList(
    lines.filter((line) =>
      /\b(create|created|write|wrote|generate|generated|save|saved|modify|modified|update|updated|add|added|chmod|verify|verified|run|ran)\b/i.test(
        line,
      ),
    ),
    { maxItems: 12, maxChars: 200 },
  )
}

function inferFailureRecoveryFromText(text: string) {
  const normalized = text.toLowerCase()
  const paths = extractPathCandidates(text)
  const wrongArtifacts =
    /\bwrong path|incorrect path|mistaken path|误路径|路径错误\b/.test(normalized) && paths.length > 0
      ? paths.slice(0, 4)
      : undefined
  const correctedArtifacts =
    /\b(corrected|fixed path|moved to|fallback|rerun|retry|recovered|修复|改到)\b/.test(normalized) && paths.length > 0
      ? paths.slice(-4)
      : undefined
  const failure =
    wrongArtifacts && wrongArtifacts.length > 0
      ? ({
          signal: "wrong artifact path detected",
          wrong_artifacts: wrongArtifacts,
        } satisfies TrajectoryRecord["failure"])
      : undefined
  const recovery =
    correctedArtifacts && correctedArtifacts.length > 0
      ? ({
          repair_action: "corrected artifact path and reran validation",
          corrected_artifacts: correctedArtifacts,
          success_signal: "path corrected",
        } satisfies TrajectoryRecord["recovery"])
      : undefined
  return { failure, recovery }
}

function asTrajectoryAgent(input: string | undefined): TrajectoryAgent {
  if (input === "planner") return "planner"
  if (input === "research") return "research"
  if (input === "coder") return "coder"
  if (input === "tester") return "tester"
  if (input === "reviewer") return "reviewer"
  if (input === "writer") return "writer"
  if (input === "selfcheck") return "selfcheck"
  return "orchestrator"
}

function sanitizeQualitySignalsByRole(agent: TrajectoryAgent, signals: TrajectoryRecord["quality_signals"]) {
  const role = agentRoleFromName(agent)
  if (!role) return {}
  const allowed = new Set<QualitySignalKey>(AGENT_ROLE_QUALITY_SIGNAL_ALLOWLIST[role])
  const next: TrajectoryRecord["quality_signals"] = {}
  for (const [key, value] of Object.entries(signals) as [keyof TrajectoryRecord["quality_signals"], boolean | undefined][]) {
    if (value === undefined) continue
    if (!allowed.has(key as QualitySignalKey)) continue
    next[key] = value
  }
  return next
}

function formatSignals(signals: TrajectoryRecord["quality_signals"]) {
  const entries = Object.entries(signals).flatMap(([key, value]) => (value === undefined ? [] : [`${key}=${value ? "true" : "false"}`]))
  return entries.length > 0 ? entries.join(", ") : "none"
}

export function createTrajectoryRecord(input: Omit<TrajectoryRecord, "id" | "created_at"> & Partial<Pick<TrajectoryRecord, "id" | "created_at">>) {
  const qualitySignals = sanitizeQualitySignalsByRole(input.agent, input.quality_signals)
  return {
    id: input.id ?? ulid(),
    run_id: input.run_id,
    task_id: input.task_id?.trim() ? input.task_id.trim() : undefined,
    task_graph_id: input.task_graph_id?.trim() ? input.task_graph_id.trim() : undefined,
    source_user_message_id: input.source_user_message_id?.trim() ? input.source_user_message_id.trim() : undefined,
    intent_anchor_hash: input.intent_anchor_hash?.trim() ? input.intent_anchor_hash.trim() : undefined,
    agent: input.agent,
    action_summary: compactText(input.action_summary, 200),
    expected_outputs: normalizeList(input.expected_outputs, { maxItems: 12, maxChars: 200 }),
    actual_outputs: normalizeList(stripThinkingEntries(input.actual_outputs), { maxItems: 14, maxChars: 220 }),
    artifact_paths: normalizeList(input.artifact_paths, { maxItems: 16, maxChars: 180 }),
    commands_run: normalizeList(input.commands_run, { maxItems: 12, maxChars: 180 }),
    verification_results: normalizeList(stripThinkingEntries(input.verification_results), { maxItems: 12, maxChars: 180 }),
    tool_results: normalizeList(input.tool_results, { maxItems: 10, maxChars: 200 }),
    outcome: input.outcome,
    quality_signals: {
      tester_passed: qualitySignals.tester_passed,
      reviewer_approved: qualitySignals.reviewer_approved,
      selfcheck_passed: qualitySignals.selfcheck_passed,
      artifact_paths_verified: qualitySignals.artifact_paths_verified,
      command_success: qualitySignals.command_success,
      local_sanity_check: qualitySignals.local_sanity_check,
      drift_detected: qualitySignals.drift_detected,
    },
    failure: input.failure
      ? {
          signal: compactText(input.failure.signal, 180),
          failed_behavior: input.failure.failed_behavior ? compactText(input.failure.failed_behavior, 180) : undefined,
          wrong_artifacts: normalizeList(input.failure.wrong_artifacts, { maxItems: 8, maxChars: 180 }),
          root_cause: input.failure.root_cause ? compactText(input.failure.root_cause, 200) : undefined,
        }
      : undefined,
    recovery: input.recovery
      ? {
          repair_action: compactText(input.recovery.repair_action, 180),
          corrected_artifacts: normalizeList(input.recovery.corrected_artifacts, { maxItems: 8, maxChars: 180 }),
          success_signal: compactText(input.recovery.success_signal, 180),
        }
      : undefined,
    evidence_refs: normalizeList(stripThinkingEntries(input.evidence_refs), { maxItems: 10, maxChars: 180 }),
    created_at: input.created_at ?? new Date().toISOString(),
  } satisfies TrajectoryRecord
}

export function extractTrajectoryEvidenceFromSubtask(input: ExtractTrajectoryInput) {
  const output = (input.output ?? "").trim()
  const promptPathContext = parsePathContextBlock(input.task.prompt ?? "")
  const expectedOutputsFromContext = promptPathContext
    ? promptPathContext.target_paths.length > 0
      ? promptPathContext.target_paths
      : promptPathContext.required_paths
    : []
  const expectedOutputs =
    expectedOutputsFromContext.length > 0
      ? normalizeList(
          expectedOutputsFromContext.flatMap((item) => {
            const normalized = normalizePathCandidate(item)
            return normalized ? [normalized] : []
          }),
          { maxItems: 20, maxChars: 180 },
        )
      : extractPathCandidates([input.task.description ?? "", input.task.prompt ?? ""].join("\n"))
  const actualOutputs = extractActualOutputLines(output)
  const applyResultActualOutputPaths = (() => {
    const applyResult = input.metadata?.apply_result
    if (!applyResult || typeof applyResult !== "object") return [] as string[]
    const paths = (applyResult as { actual_output_paths?: unknown }).actual_output_paths
    if (!Array.isArray(paths)) return [] as string[]
    return paths.filter((item): item is string => typeof item === "string")
  })()
  const metadataActualOutputs = normalizeList(
    [
      ...((Array.isArray(input.metadata?.actual_output_paths)
        ? input.metadata.actual_output_paths.filter((item): item is string => typeof item === "string")
        : []) ?? []),
      ...applyResultActualOutputPaths,
    ].flatMap((item) => {
      const normalized = normalizePathCandidate(item)
      return normalized ? [normalized] : []
    }),
    { maxItems: 16, maxChars: 180 },
  )
  const fileWriteEvidence = Array.isArray(input.metadata?.file_write_evidence)
    ? input.metadata?.file_write_evidence
        .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
        .map((entry) => ({
          file_path: typeof entry.file_path === "string" ? entry.file_path : undefined,
          tool: entry.tool === "edit" || entry.tool === "write" ? entry.tool : undefined,
          mtime_ms: typeof entry.mtime_ms === "number" ? entry.mtime_ms : undefined,
          sha256: typeof entry.sha256 === "string" ? entry.sha256 : undefined,
          readback_fragment: typeof entry.readback_fragment === "string" ? entry.readback_fragment : undefined,
          existed_before: typeof entry.existed_before === "boolean" ? entry.existed_before : undefined,
        }))
    : []
  const verifiedArtifactPaths = normalizeList(
    fileWriteEvidence.flatMap((entry) => (entry.file_path ? [entry.file_path] : [])),
    { maxItems: 16, maxChars: 180 },
  )
  const evidenceVerificationResults = fileWriteEvidence.flatMap((entry) => {
    if (!entry.file_path) return []
    const details: string[] = []
    if (entry.tool) details.push(`tool=${entry.tool}`)
    if (typeof entry.sha256 === "string") details.push(`sha256=${entry.sha256.slice(0, 12)}`)
    if (typeof entry.mtime_ms === "number") details.push(`mtime_ms=${Math.round(entry.mtime_ms)}`)
    if (typeof entry.existed_before === "boolean")
      details.push(`existed_before=${entry.existed_before ? "true" : "false"}`)
    if (typeof entry.readback_fragment === "string" && entry.readback_fragment.trim().length > 0) {
      details.push(`readback_fragment=${compactText(entry.readback_fragment, 80)}`)
    }
    const suffix = details.length > 0 ? ` (${details.join(", ")})` : ""
    return [`write_verified:${entry.file_path}${suffix}`]
  })
  const artifactPathsFromOutput = extractPathCandidates(output)
  const artifactPathsFromTask = extractPathCandidates([input.task.description ?? "", input.task.prompt ?? ""].join("\n"))
  const artifactPaths =
    metadataActualOutputs.length > 0
      ? metadataActualOutputs
      : verifiedArtifactPaths.length > 0
      ? verifiedArtifactPaths
      : artifactPathsFromOutput.length > 0
        ? artifactPathsFromOutput
        : artifactPathsFromTask
  const commandsRun = extractCommandCandidates(output)
  const verificationResults = [...evidenceVerificationResults, ...extractVerificationCandidates(output)]
  const toolResults =
    typeof input.metadata?.sessionId === "string"
      ? normalizeList([`subagent_session:${input.metadata.sessionId}`], { maxItems: 4, maxChars: 120 })
      : []
  const inferredFailureRecovery = inferFailureRecoveryFromText(output)
  return createTrajectoryRecord({
    run_id: input.run_id,
    task_id: input.task.task_id?.trim() ? input.task.task_id : input.task.id,
    task_graph_id: input.task_graph_id,
    source_user_message_id: input.source_user_message_id,
    intent_anchor_hash: input.intent_anchor_hash,
    agent: asTrajectoryAgent(input.task.task_role ?? input.task.agent),
    action_summary: input.task.description?.trim() || "subtask execution",
    expected_outputs: expectedOutputs,
    actual_outputs: actualOutputs,
    artifact_paths: artifactPaths,
    commands_run: commandsRun,
    verification_results: verificationResults,
    tool_results: toolResults,
    outcome: input.outcome,
    quality_signals: {
      ...input.quality_signals,
      ...(verifiedArtifactPaths.length > 0 ? { artifact_paths_verified: true } : {}),
    },
    failure: input.failure ?? inferredFailureRecovery.failure,
    recovery: input.recovery ?? inferredFailureRecovery.recovery,
    evidence_refs: input.evidence_refs,
  })
}

export function sanitizeArtifactPathsForCurrentRun(
  paths: string[],
  intent: string,
  allowedPaths: string[],
): ArtifactPathSanitizeResult {
  const normalizedAllowed = new Set(allowedPaths.flatMap((path) => {
    const normalized = normalizePathCandidate(path)
    return normalized ? [normalized] : []
  }))
  const intentLower = intent.toLowerCase()
  const tlsLikeIntent = /\b(tls|ssl|cert|certificate|server\.crt|server\.key|check_cert\.py|verification\.txt)\b/.test(intentLower)
  const accepted = new Set<string>()
  const rejected = new Set<string>()
  const warnings: string[] = []
  const staleTlsPattern =
    /(^|\/)(ssl(?:\/|$)|test\/certs(?:\/|$)|packages\/codemate\/ssl(?:\/|$)|ssl\/keys\/server\.key|ssl\/certs\/server\.crt|ssl\/check_cert\.py|verification\.txt$)/i
  const strictTlsAllowed = tlsLikeIntent && normalizedAllowed.size > 0

  for (const raw of paths) {
    const normalized = normalizePathCandidate(raw)
    if (!normalized || isNonPathToken(normalized)) {
      rejected.add(raw)
      continue
    }
    if (strictTlsAllowed && !normalizedAllowed.has(normalized)) {
      rejected.add(normalized)
      warnings.push(`rejected_path_outside_current_run: ${normalized}`)
      continue
    }
    if (tlsLikeIntent && normalizedAllowed.size === 0 && staleTlsPattern.test(normalized)) {
      rejected.add(normalized)
      warnings.push(`rejected_stale_tls_path: ${normalized}`)
      continue
    }
    accepted.add(normalized)
  }

  return {
    accepted_paths: [...accepted],
    rejected_paths: [...rejected],
    warnings: normalizeList(warnings, { maxItems: 20, maxChars: 200 }),
  }
}

export function filterTrajectoryByRun(records: TrajectoryRecord[], run_id: string) {
  return records.filter((record) => record.run_id === run_id)
}

export function formatTrajectoryEvidenceForWriter(records: TrajectoryRecord[]) {
  const section = ["Execution evidence from this run:"]
  if (records.length === 0) {
    section.push("- evidence missing for this run.")
    return section.join("\n")
  }
  for (const record of records) {
    section.push(`- Task: ${record.task_id ?? "n/a"}`)
    section.push(`  Agent: ${record.agent}`)
    section.push(`  Outcome: ${record.outcome}`)
    section.push(
      `  Actual outputs: ${record.actual_outputs.length > 0 ? record.actual_outputs.slice(0, 6).join(" | ") : "n/a"}`,
    )
    section.push(
      `  Artifact paths: ${record.artifact_paths.length > 0 ? record.artifact_paths.slice(0, 8).join(" | ") : "n/a"}`,
    )
    section.push(`  Commands: ${record.commands_run.length > 0 ? record.commands_run.slice(0, 6).join(" | ") : "n/a"}`)
    section.push(
      `  Verification: ${record.verification_results.length > 0 ? record.verification_results.slice(0, 6).join(" | ") : "n/a"}`,
    )
    section.push(`  Quality signals: ${formatSignals(record.quality_signals)}`)
  }
  return section.join("\n")
}
