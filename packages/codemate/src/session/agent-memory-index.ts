import { ulid } from "ulid"
import { mkdir } from "fs/promises"
import path from "path"
import type { FailureRecoveryCandidate } from "@/session/closed-loop"
import type { LessonRecord } from "@/session/lesson-schema"
import type { EmbeddingVector } from "@/session/embedding"
import {
  type PersistedTrajectoryRecord,
  type TrajectoryRecord,
  type TrajectoryOutcome,
  toPersistedTrajectoryRecord,
} from "@/session/trajectory"

export type AgentMemoryKind =
  | "lesson"
  | "trajectory"
  | "failure_recovery"
  | "project_convention"
  | "workflow_rule"
  | "decision"

export type AgentMemoryScope = "project" | "global"
export type AgentMemoryStatus = "active" | "quarantined" | "deprecated"

export type AgentMemoryRecord = {
  id: string
  kind: AgentMemoryKind
  scope: AgentMemoryScope
  text: string
  tags: string[]
  confidence: number
  status: AgentMemoryStatus
  source_id?: string
  source_path?: string
  run_id?: string
  task_id?: string
  agent?: string
  created_at: string
  updated_at: string
  embedding?: {
    vector: EmbeddingVector
    provider?: string
    dimensions?: number
    updated_at?: string
  }
  metadata: Record<string, unknown>
}

export type AgentMemoryListOptions = {
  scope?: AgentMemoryScope
  kind?: AgentMemoryKind | AgentMemoryKind[]
  status?: AgentMemoryStatus | AgentMemoryStatus[]
  includeInactive?: boolean
  limit?: number
}

export type AgentMemorySearchOptions = AgentMemoryListOptions & {
  tags?: string[]
  agent?: string
  run_id?: string
  task_id?: string
  minConfidenceGlobal?: number
  minConfidenceProject?: number
}

export type AgentMemoryStats = {
  total: number
  active: number
  by_scope: Record<AgentMemoryScope, number>
  by_kind: Record<AgentMemoryKind, number>
  by_status: Record<AgentMemoryStatus, number>
}

export interface AgentMemoryIndex {
  upsert(record: AgentMemoryRecord): Promise<AgentMemoryRecord>
  search(query: string, options?: AgentMemorySearchOptions): Promise<AgentMemoryRecord[]>
  delete(id: string): Promise<boolean>
  stats(): Promise<AgentMemoryStats>
  list(options?: AgentMemoryListOptions): Promise<AgentMemoryRecord[]>
}

const AGENT_MEMORY_KINDS: AgentMemoryKind[] = [
  "lesson",
  "trajectory",
  "failure_recovery",
  "project_convention",
  "workflow_rule",
  "decision",
]
const AGENT_MEMORY_SCOPES: AgentMemoryScope[] = ["project", "global"]
const AGENT_MEMORY_STATUS: AgentMemoryStatus[] = ["active", "quarantined", "deprecated"]

function compactText(input: string, max = 420) {
  const normalized = input.replace(/\s+/g, " ").trim()
  if (!normalized) return ""
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, Math.max(0, max - 15)).trimEnd()}...[truncated]`
}

function clampConfidence(value: number | undefined, fallback = 0.5) {
  if (typeof value !== "number" || Number.isNaN(value)) return fallback
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

function isKind(value: string): value is AgentMemoryKind {
  return AGENT_MEMORY_KINDS.includes(value as AgentMemoryKind)
}

function isScope(value: string): value is AgentMemoryScope {
  return AGENT_MEMORY_SCOPES.includes(value as AgentMemoryScope)
}

function isStatus(value: string): value is AgentMemoryStatus {
  return AGENT_MEMORY_STATUS.includes(value as AgentMemoryStatus)
}

function asDateString(value: string | undefined, fallback: string) {
  if (!value?.trim()) return fallback
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) return fallback
  return new Date(parsed).toISOString()
}

function asOptionalDateString(value: string | undefined) {
  if (!value?.trim()) return
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) return
  return new Date(parsed).toISOString()
}

function parseEmbedding(input: unknown) {
  if (!input || typeof input !== "object") return
  const source = input as Record<string, unknown>
  const vector = Array.isArray(source.vector)
    ? source.vector.filter((item): item is number => typeof item === "number" && Number.isFinite(item))
    : []
  if (vector.length === 0) return
  const dimensions =
    typeof source.dimensions === "number" && Number.isFinite(source.dimensions)
      ? Math.max(1, Math.floor(source.dimensions))
      : undefined
  return {
    vector,
    provider: typeof source.provider === "string" ? source.provider.trim() : undefined,
    dimensions: dimensions ?? vector.length,
    updated_at: typeof source.updated_at === "string" ? asOptionalDateString(source.updated_at) : undefined,
  } satisfies NonNullable<AgentMemoryRecord["embedding"]>
}

function uniqueStrings(values: string[], maxItems = 20, maxChars = 80) {
  return [...new Set(values.map((item) => compactText(item, maxChars)).filter(Boolean))].slice(0, maxItems)
}

function asArray<T>(value: T | T[] | undefined) {
  if (!value) return [] as T[]
  return Array.isArray(value) ? value : [value]
}

function tokenize(text: string) {
  return [
    ...new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fff\s]+/g, " ")
        .split(/\s+/)
        .map((item) => item.trim())
        .filter((item) => item.length > 1),
    ),
  ]
}

function normalizeRecord(input: AgentMemoryRecord) {
  const now = new Date().toISOString()
  const kind = isKind(input.kind) ? input.kind : "lesson"
  const scope = isScope(input.scope) ? input.scope : "project"
  const status = isStatus(input.status) ? input.status : "active"
  const text = compactText(input.text, 420)
  return {
    id: input.id?.trim() ? input.id.trim() : `memory:${ulid()}`,
    kind,
    scope,
    text,
    tags: uniqueStrings(input.tags ?? [], 16, 60),
    confidence: clampConfidence(input.confidence, 0.5),
    status,
    source_id: input.source_id?.trim() || undefined,
    source_path: input.source_path?.trim() || undefined,
    run_id: input.run_id?.trim() || undefined,
    task_id: input.task_id?.trim() || undefined,
    agent: input.agent?.trim() || undefined,
    created_at: asDateString(input.created_at, now),
    updated_at: asDateString(input.updated_at, input.created_at || now),
    embedding: parseEmbedding(input.embedding),
    metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : {},
  } satisfies AgentMemoryRecord
}

function includeByBaseFilters(record: AgentMemoryRecord, options: AgentMemoryListOptions = {}, defaults?: { includeInactive?: boolean }) {
  const includeInactive = options.includeInactive ?? defaults?.includeInactive ?? true
  if (!includeInactive && record.status !== "active") return false
  if (options.scope && record.scope !== options.scope) return false
  const kinds = asArray(options.kind)
  if (kinds.length > 0 && !kinds.includes(record.kind)) return false
  const statuses = asArray(options.status)
  if (statuses.length > 0 && !statuses.includes(record.status)) return false
  return true
}

function applyListOrdering(records: AgentMemoryRecord[], limit?: number) {
  const ordered = records.toSorted((left, right) => {
    const updatedDelta = Date.parse(right.updated_at) - Date.parse(left.updated_at)
    if (updatedDelta !== 0) return updatedDelta
    return left.id.localeCompare(right.id)
  })
  const max = limit && limit > 0 ? Math.floor(limit) : undefined
  return max ? ordered.slice(0, max) : ordered
}

function searchScore(record: AgentMemoryRecord, query: string, options: AgentMemorySearchOptions = {}) {
  const tokens = tokenize(query)
  const text = record.text.toLowerCase()
  const tags = record.tags.map((tag) => tag.toLowerCase())
  const tagHits = tokens.filter((token) => tags.includes(token)).length
  const textHits = tokens.filter((token) => text.includes(token)).length
  const sourceHits = tokens.filter((token) => (record.source_path ?? "").toLowerCase().includes(token)).length
  const matchesFilterTags =
    !options.tags ||
    options.tags.length === 0 ||
    options.tags.some((tag) => tags.includes(tag.toLowerCase()) || text.includes(tag.toLowerCase()))
  if (!matchesFilterTags) return -1
  if (options.agent && record.agent !== options.agent) return -1
  if (options.run_id && record.run_id !== options.run_id) return -1
  if (options.task_id && record.task_id !== options.task_id) return -1
  const minGlobal = options.minConfidenceGlobal ?? 0.8
  const minProject = options.minConfidenceProject ?? 0
  if (record.scope === "global" && record.confidence < minGlobal) return -1
  if (record.scope === "project" && record.confidence < minProject) return -1
  const rawScore = record.confidence + (record.scope === "project" ? 0.2 : 0.1) + tagHits * 1.2 + textHits + sourceHits * 0.3
  if (!query.trim()) return rawScore
  return tagHits + textHits + sourceHits === 0 ? -1 : rawScore
}

function statsFromRecords(records: AgentMemoryRecord[]): AgentMemoryStats {
  return records.reduce<AgentMemoryStats>(
    (acc, record) => {
      acc.total += 1
      if (record.status === "active") acc.active += 1
      acc.by_scope[record.scope] += 1
      acc.by_kind[record.kind] += 1
      acc.by_status[record.status] += 1
      return acc
    },
    {
      total: 0,
      active: 0,
      by_scope: { project: 0, global: 0 },
      by_kind: {
        lesson: 0,
        trajectory: 0,
        failure_recovery: 0,
        project_convention: 0,
        workflow_rule: 0,
        decision: 0,
      },
      by_status: { active: 0, quarantined: 0, deprecated: 0 },
    },
  )
}

export function pathProjectAgentMemoryIndex(projectRoot: string) {
  return path.join(projectRoot, ".codemate", "agent-memory-index.jsonl")
}

function parseMemoryJsonl(text: string) {
  const warnings: string[] = []
  const records = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line, index) => {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>
        if (!parsed || typeof parsed !== "object") {
          warnings.push(`invalid memory line ${index + 1}: not an object`)
          return []
        }
        return [
          normalizeRecord({
            id: typeof parsed.id === "string" ? parsed.id : `memory:${ulid()}`,
            kind: isKind(String(parsed.kind ?? "")) ? (parsed.kind as AgentMemoryKind) : "lesson",
            scope: isScope(String(parsed.scope ?? "")) ? (parsed.scope as AgentMemoryScope) : "project",
            text: typeof parsed.text === "string" ? parsed.text : "",
            tags: Array.isArray(parsed.tags) ? parsed.tags.filter((item): item is string => typeof item === "string") : [],
            confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
            status: isStatus(String(parsed.status ?? "")) ? (parsed.status as AgentMemoryStatus) : "active",
            source_id: typeof parsed.source_id === "string" ? parsed.source_id : undefined,
            source_path: typeof parsed.source_path === "string" ? parsed.source_path : undefined,
            run_id: typeof parsed.run_id === "string" ? parsed.run_id : undefined,
            task_id: typeof parsed.task_id === "string" ? parsed.task_id : undefined,
            agent: typeof parsed.agent === "string" ? parsed.agent : undefined,
            created_at: typeof parsed.created_at === "string" ? parsed.created_at : new Date().toISOString(),
            updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : new Date().toISOString(),
            embedding: parseEmbedding(parsed.embedding),
            metadata: parsed.metadata && typeof parsed.metadata === "object" ? (parsed.metadata as Record<string, unknown>) : {},
          }),
        ]
      } catch {
        warnings.push(`invalid memory line ${index + 1}: JSON parse failed`)
        return []
      }
    })
  return { records, warnings }
}

export class InMemoryAgentMemoryIndex implements AgentMemoryIndex {
  private readonly map = new Map<string, AgentMemoryRecord>()

  constructor(input?: { records?: AgentMemoryRecord[] }) {
    for (const record of input?.records ?? []) {
      const normalized = normalizeRecord(record)
      this.map.set(normalized.id, normalized)
    }
  }

  async upsert(record: AgentMemoryRecord) {
    const normalized = normalizeRecord(record)
    const existing = [...this.map.values()].find(
      (item) => item.id === normalized.id || (!!normalized.source_id && item.source_id === normalized.source_id),
    )
    if (existing) {
      const currentTs = Date.parse(existing.updated_at)
      const incomingTs = Date.parse(normalized.updated_at)
      if (currentTs > incomingTs) return existing
      const merged = {
        ...normalized,
        id: existing.id,
        created_at: existing.created_at,
      } satisfies AgentMemoryRecord
      if (normalized.id !== existing.id) this.map.delete(normalized.id)
      this.map.set(existing.id, merged)
      return merged
    }
    this.map.set(normalized.id, normalized)
    return normalized
  }

  async list(options: AgentMemoryListOptions = {}) {
    const records = [...this.map.values()].filter((record) => includeByBaseFilters(record, options))
    return applyListOrdering(records, options.limit)
  }

  async search(query: string, options: AgentMemorySearchOptions = {}) {
    const base = [...this.map.values()].filter((record) => includeByBaseFilters(record, options, { includeInactive: false }))
    return base
      .map((record) => ({ record, score: searchScore(record, query, options) }))
      .filter((item) => item.score >= 0)
      .toSorted((left, right) => {
        if (right.score !== left.score) return right.score - left.score
        if (right.record.confidence !== left.record.confidence) return right.record.confidence - left.record.confidence
        const updatedDelta = Date.parse(right.record.updated_at) - Date.parse(left.record.updated_at)
        if (updatedDelta !== 0) return updatedDelta
        return left.record.id.localeCompare(right.record.id)
      })
      .map((item) => item.record)
      .slice(0, Math.max(1, options.limit ?? 10))
  }

  async delete(id: string) {
    return this.map.delete(id)
  }

  async stats() {
    return statsFromRecords([...this.map.values()])
  }
}

export class JsonlAgentMemoryIndex implements AgentMemoryIndex {
  private readonly filePath: string

  constructor(input: { projectRoot: string; filePath?: string }) {
    this.filePath = input.filePath ?? pathProjectAgentMemoryIndex(input.projectRoot)
  }

  private async readAll() {
    const file = Bun.file(this.filePath)
    if (!(await file.exists())) return { records: [] as AgentMemoryRecord[], warnings: [] as string[] }
    return parseMemoryJsonl(await file.text())
  }

  private async writeAll(records: AgentMemoryRecord[]) {
    const text = records.map((record) => JSON.stringify(record)).join("\n")
    await mkdir(path.dirname(this.filePath), { recursive: true })
    await Bun.write(this.filePath, text ? `${text}\n` : "")
  }

  async upsert(record: AgentMemoryRecord) {
    const normalized = normalizeRecord(record)
    const current = await this.readAll()
    const existing = current.records.find(
      (item) => item.id === normalized.id || (!!normalized.source_id && item.source_id === normalized.source_id),
    )
    if (existing) {
      const currentTs = Date.parse(existing.updated_at)
      const incomingTs = Date.parse(normalized.updated_at)
      if (currentTs > incomingTs) return existing
      const merged = {
        ...normalized,
        id: existing.id,
        created_at: existing.created_at,
      } satisfies AgentMemoryRecord
      const next = current.records.filter(
        (item) =>
          item.id !== existing.id &&
          item.id !== normalized.id &&
          (!normalized.source_id || item.source_id !== normalized.source_id),
      )
      await this.writeAll([...next, merged])
      return merged
    }
    const next = current.records.filter((item) => item.id !== normalized.id)
    await this.writeAll([...next, normalized])
    return normalized
  }

  async list(options: AgentMemoryListOptions = {}) {
    const current = await this.readAll()
    const records = current.records.filter((record) => includeByBaseFilters(record, options))
    return applyListOrdering(records, options.limit)
  }

  async search(query: string, options: AgentMemorySearchOptions = {}) {
    const current = await this.readAll()
    const base = current.records.filter((record) => includeByBaseFilters(record, options, { includeInactive: false }))
    return base
      .map((record) => ({ record, score: searchScore(record, query, options) }))
      .filter((item) => item.score >= 0)
      .toSorted((left, right) => {
        if (right.score !== left.score) return right.score - left.score
        if (right.record.confidence !== left.record.confidence) return right.record.confidence - left.record.confidence
        const updatedDelta = Date.parse(right.record.updated_at) - Date.parse(left.record.updated_at)
        if (updatedDelta !== 0) return updatedDelta
        return left.record.id.localeCompare(right.record.id)
      })
      .map((item) => item.record)
      .slice(0, Math.max(1, options.limit ?? 10))
  }

  async delete(id: string) {
    const current = await this.readAll()
    const next = current.records.filter((record) => record.id !== id)
    if (next.length === current.records.length) return false
    await this.writeAll(next)
    return true
  }

  async stats() {
    const current = await this.readAll()
    return statsFromRecords(current.records)
  }
}

function lessonKind(record: LessonRecord): AgentMemoryKind {
  if (record.type === "failure_pattern") return "failure_recovery"
  if (record.type === "project_convention") return "project_convention"
  if (record.type === "workflow_rule") return "workflow_rule"
  if (record.type === "research_insight") return "decision"
  return "lesson"
}

export function lessonRecordToAgentMemory(record: LessonRecord): AgentMemoryRecord {
  const kind = lessonKind(record)
  const text = compactText(
    [
      record.summary,
      record.applies_when.length > 0 ? `When: ${record.applies_when.join("; ")}` : "",
      record.do.length > 0 ? `Do: ${record.do.join("; ")}` : "",
      record.dont.length > 0 ? `Don't: ${record.dont.join("; ")}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    480,
  )
  return normalizeRecord({
    id: `memory:${record.id}`,
    kind,
    scope: record.scope,
    text,
    tags: uniqueStrings([...record.tags, record.type, "lesson"], 16, 60),
    confidence: clampConfidence(record.quality.confidence, 0.5),
    status: record.status,
    source_id: record.id,
    source_path: ".codemate/lessons.jsonl",
    run_id: record.source.run_id,
    task_id: record.source.task_id,
    agent: record.source.agent,
    created_at: record.created_at,
    updated_at: record.updated_at,
    metadata: {
      summary: record.summary,
      lesson_type: record.type,
      applies_when: record.applies_when,
      do: record.do,
      dont: record.dont,
      trajectory: record.trajectory,
      conflicts_with: record.conflicts_with,
      supersedes: record.supersedes,
    },
  })
}

function trajectoryConfidence(outcome: TrajectoryOutcome, input: PersistedTrajectoryRecord) {
  const base =
    outcome === "recovered"
      ? 0.82
      : outcome === "success"
        ? 0.74
        : outcome === "failure"
          ? 0.64
          : outcome === "cancelled"
            ? 0.4
            : 0.35
  const testerBoost = input.quality_signals.tester_passed ? 0.06 : 0
  const reviewerBoost = input.quality_signals.reviewer_approved ? 0.06 : 0
  const selfcheckBoost = input.quality_signals.selfcheck_passed ? 0.04 : 0
  return clampConfidence(base + testerBoost + reviewerBoost + selfcheckBoost, 0.5)
}

function trajectoryKind(input: PersistedTrajectoryRecord): AgentMemoryKind {
  if (input.failure || input.recovery || input.outcome === "recovered") return "failure_recovery"
  if (input.agent === "planner") return "decision"
  return "trajectory"
}

export function trajectoryRecordToAgentMemory(
  record: TrajectoryRecord | PersistedTrajectoryRecord,
  input?: { scope?: AgentMemoryScope; projectRoot?: string },
): AgentMemoryRecord {
  const persisted = toPersistedTrajectoryRecord(record, { projectRoot: input?.projectRoot })
  const kind = trajectoryKind(persisted)
  const text = compactText(
    [
      persisted.action_summary,
      persisted.actual_outputs.length > 0 ? `Outputs: ${persisted.actual_outputs.join("; ")}` : "",
      persisted.verification_results.length > 0 ? `Verification: ${persisted.verification_results.join("; ")}` : "",
      persisted.failure?.signal ? `Failure: ${persisted.failure.signal}` : "",
      persisted.recovery?.repair_action ? `Recovery: ${persisted.recovery.repair_action}` : "",
      persisted.recovery?.success_signal ? `Recovered by: ${persisted.recovery.success_signal}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    520,
  )
  return normalizeRecord({
    id: `memory:${persisted.id}`,
    kind,
    scope: input?.scope ?? "project",
    text,
    tags: uniqueStrings([
      "trajectory",
      persisted.agent,
      persisted.outcome,
      ...(persisted.failure ? ["failure"] : []),
      ...(persisted.recovery ? ["recovery"] : []),
    ]),
    confidence: trajectoryConfidence(persisted.outcome, persisted),
    status: "active",
    source_id: persisted.id,
    source_path: ".codemate/trajectories.jsonl",
    run_id: persisted.run_id,
    task_id: persisted.task_id,
    agent: persisted.agent,
    created_at: persisted.created_at,
    updated_at: persisted.created_at,
    metadata: {
      task_graph_id: persisted.task_graph_id,
      source_user_message_id: persisted.source_user_message_id,
      intent_anchor_hash: persisted.intent_anchor_hash,
      outcome: persisted.outcome,
      artifact_paths: persisted.artifact_paths,
      commands_run: persisted.commands_run,
      verification_results: persisted.verification_results,
      quality_signals: persisted.quality_signals,
      failure: persisted.failure,
      recovery: persisted.recovery,
      evidence_refs: persisted.evidence_refs,
    },
  })
}

export function failureRecoveryCandidateToAgentMemory(
  record: FailureRecoveryCandidate,
  input?: { scope?: AgentMemoryScope },
): AgentMemoryRecord {
  const confidence =
    record.success_signal?.trim() && record.repair_action?.trim()
      ? 0.86
      : record.repair_action?.trim()
        ? 0.74
        : 0.62
  const text = compactText(
    [
      `Failure signal: ${record.failure_signal}`,
      record.repair_action ? `Repair action: ${record.repair_action}` : "",
      record.success_signal ? `Success signal: ${record.success_signal}` : "",
      record.intent_anchor ? `Intent anchor: ${record.intent_anchor}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    460,
  )
  return normalizeRecord({
    id: `memory:${record.id}`,
    kind: "failure_recovery",
    scope: input?.scope ?? "project",
    text,
    tags: uniqueStrings([
      "failure_recovery",
      record.failed_stage,
      record.failed_agent ?? "unknown",
      ...(record.evidence_refs ?? []).slice(0, 4),
    ]),
    confidence,
    status: "active",
    source_id: record.id,
    source_path: "session:failure_recovery",
    run_id: record.run_id,
    task_id: record.task_id,
    agent: record.failed_agent,
    created_at: asDateString(record.created_at, new Date().toISOString()),
    updated_at: asDateString(record.created_at, new Date().toISOString()),
    metadata: {
      failed_stage: record.failed_stage,
      failure_signal: record.failure_signal,
      repair_action: record.repair_action,
      success_signal: record.success_signal,
      intent_anchor: record.intent_anchor,
      evidence_refs: record.evidence_refs,
    },
  })
}

export { HybridAgentMemoryIndex, VectorAgentMemoryIndex } from "@/session/agent-memory-hybrid-index"
export { HnswAgentMemoryIndex, detectHnswAvailability } from "@/session/agent-memory-hnsw-index"
