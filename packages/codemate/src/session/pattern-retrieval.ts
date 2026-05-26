import type { LessonRecord } from "@/session/lesson-schema"
import type { AgentMemoryIndex, AgentMemoryRecord } from "@/session/agent-memory-index"

type PatternKind =
  | "lesson"
  | "trajectory_proposal"
  | "failure_recovery"
  | "workflow_rule"
  | "project_convention"

type PatternRecord = {
  id: string
  kind: PatternKind
  scope: "project" | "global"
  status: "active" | "quarantined" | "deprecated"

  summary: string
  applies_when: string[]
  do: string[]
  dont: string[]
  tags: string[]

  confidence: number
  source_ref?: string
  created_at?: string
  updated_at?: string

  score?: number
  score_reasons?: string[]
}

type PatternRetrievalInput = {
  patterns: PatternRecord[]
  userText: string
  intentAnchor?: string
  agentName: string
  taskRole?: string
  projectRoot?: string
  maxPatterns?: number
}

type ScoredPattern = PatternRecord & {
  score: number
  score_reasons: string[]
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

function parseTime(value: string | undefined) {
  if (!value) return
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return
  return ms
}

function recencyBoost(updatedAt: string | undefined, createdAt: string | undefined) {
  const now = Date.now()
  const ts = parseTime(updatedAt) ?? parseTime(createdAt)
  if (!ts) return 0
  const days = Math.max(0, (now - ts) / (1000 * 60 * 60 * 24))
  if (days <= 7) return 0.5
  if (days <= 30) return 0.35
  if (days <= 90) return 0.2
  return 0
}

function kindPriority(kind: PatternKind) {
  if (kind === "failure_recovery") return 2
  if (kind === "workflow_rule") return 1.5
  if (kind === "project_convention") return 1.5
  if (kind === "lesson") return 1
  return 1
}

function matchesAnyToken(text: string, tokens: string[]) {
  const haystack = text.toLowerCase()
  return tokens.some((token) => haystack.includes(token))
}

function hasRelevanceOverlap(pattern: PatternRecord, queryTokens: string[]) {
  if (queryTokens.length === 0) return false
  const tagHit = pattern.tags.some((tag) => queryTokens.includes(tag.toLowerCase()))
  if (tagHit) return true
  const appliesHit = matchesAnyToken(pattern.applies_when.join(" "), queryTokens)
  if (appliesHit) return true
  return matchesAnyToken(pattern.summary, queryTokens)
}

function shouldDropAggressiveNoOp(pattern: PatternRecord) {
  if (pattern.scope !== "global") return false
  const tags = pattern.tags.map((tag) => tag.toLowerCase())
  if (!tags.includes("persistence") || !tags.includes("no-op")) return false
  const text = [pattern.summary, ...pattern.applies_when, ...pattern.do, ...pattern.dont].join("\n").toLowerCase()
  if (!text.includes("changed files")) return false
  if (!(text.includes("no-op") || text.includes("no op"))) return false
  return true
}

function kindFromLesson(record: LessonRecord): PatternKind {
  if (record.type === "failure_pattern") return "failure_recovery"
  if (record.type === "workflow_rule") return "workflow_rule"
  if (record.type === "project_convention") return "project_convention"
  return "lesson"
}

export function buildPatternRecordsFromLessons(lessons: LessonRecord[]): PatternRecord[] {
  return lessons.map((record) => ({
    id: record.id,
    kind: kindFromLesson(record),
    scope: record.scope,
    status: record.status,
    summary: record.summary,
    applies_when: record.applies_when,
    do: record.do,
    dont: record.dont,
    tags: record.tags,
    confidence: record.quality.confidence,
    source_ref: record.fingerprint,
    created_at: record.created_at,
    updated_at: record.updated_at,
  }))
}

function asMetadataString(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function asMetadataStringArray(value: unknown) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))]
}

function reusableTrajectoryPatternFromMetadata(record: AgentMemoryRecord) {
  const metadata = record.metadata
  if (!metadata || typeof metadata !== "object") return
  const summary = asMetadataString((metadata as Record<string, unknown>)["reusable_pattern_summary"])
  const appliesWhen = asMetadataStringArray((metadata as Record<string, unknown>)["reusable_applies_when"])
  const doList = asMetadataStringArray((metadata as Record<string, unknown>)["reusable_do"])
  const dontList = asMetadataStringArray((metadata as Record<string, unknown>)["reusable_dont"])
  const evidence = asMetadataStringArray((metadata as Record<string, unknown>)["reusable_evidence"])
  const hasEvidence = evidence.length > 0 || doList.length > 0 || appliesWhen.length > 0
  if (!summary || !hasEvidence) return
  return {
    summary,
    applies_when: appliesWhen,
    do: doList,
    dont: dontList,
  }
}

function patternFromCommonMetadata(record: AgentMemoryRecord) {
  const metadata = record.metadata
  if (!metadata || typeof metadata !== "object") return
  const summary = asMetadataString((metadata as Record<string, unknown>)["summary"])
  const appliesWhen = asMetadataStringArray((metadata as Record<string, unknown>)["applies_when"])
  const doList = asMetadataStringArray((metadata as Record<string, unknown>)["do"])
  const dontList = asMetadataStringArray((metadata as Record<string, unknown>)["dont"])
  if (!summary && appliesWhen.length === 0 && doList.length === 0 && dontList.length === 0) return
  return {
    summary: summary || record.text,
    applies_when: appliesWhen,
    do: doList,
    dont: dontList,
  }
}

export function agentMemoryRecordToPatternRecord(record: AgentMemoryRecord): PatternRecord | undefined {
  if (record.status !== "active") return
  if (record.scope === "global" && record.confidence < 0.8) return
  if (record.scope === "project" && record.confidence < 0.5) return

  const base = {
    id: record.id,
    scope: record.scope,
    status: record.status,
    tags: record.tags,
    confidence: record.confidence,
    source_ref: record.source_id ?? record.id,
    created_at: record.created_at,
    updated_at: record.updated_at,
  } satisfies Omit<PatternRecord, "kind" | "summary" | "applies_when" | "do" | "dont">

  if (record.kind === "lesson" || record.kind === "workflow_rule" || record.kind === "project_convention") {
    const metadataPattern = patternFromCommonMetadata(record)
    return {
      ...base,
      kind: record.kind === "lesson" ? "lesson" : record.kind,
      summary: metadataPattern?.summary ?? record.text,
      applies_when: metadataPattern?.applies_when ?? [],
      do: metadataPattern?.do ?? [],
      dont: metadataPattern?.dont ?? [],
    } satisfies PatternRecord
  }
  if (record.kind === "failure_recovery") {
    const metadataPattern = patternFromCommonMetadata(record)
    return {
      ...base,
      kind: "failure_recovery",
      summary: metadataPattern?.summary ?? record.text,
      applies_when: metadataPattern?.applies_when ?? [],
      do: metadataPattern?.do ?? [],
      dont: metadataPattern?.dont ?? [],
    } satisfies PatternRecord
  }
  if (record.kind === "trajectory") {
    const reusable = reusableTrajectoryPatternFromMetadata(record)
    if (!reusable) return
    return {
      ...base,
      kind: "trajectory_proposal",
      summary: reusable.summary,
      applies_when: reusable.applies_when,
      do: reusable.do,
      dont: reusable.dont,
    } satisfies PatternRecord
  }
}

type MemoryPatternSearchInput = Omit<PatternRetrievalInput, "patterns">

export async function searchRelevantPatternsFromMemoryIndex(index: AgentMemoryIndex, input: MemoryPatternSearchInput) {
  const maxPatterns = Math.max(1, input.maxPatterns ?? 5)
  const query = [input.userText, input.intentAnchor ?? "", input.taskRole ?? "", input.agentName].join("\n").trim()
  const isWriter = input.agentName === "writer"
  const memoryRecords = await index.search(query, {
    scope: isWriter ? "project" : undefined,
    includeInactive: false,
    minConfidenceGlobal: 0.8,
    limit: Math.max(20, maxPatterns * 4),
  })
  const patterns = memoryRecords.flatMap((record) => {
    const pattern = agentMemoryRecordToPatternRecord(record)
    return pattern ? [pattern] : []
  })
  if (patterns.length === 0) return []
  return searchRelevantPatterns({
    patterns,
    userText: input.userText,
    intentAnchor: input.intentAnchor,
    agentName: input.agentName,
    taskRole: input.taskRole,
    projectRoot: input.projectRoot,
    maxPatterns,
  })
}

export function scorePatternForRequest(pattern: PatternRecord, input: PatternRetrievalInput): ScoredPattern {
  const reasons: string[] = []
  const queryText = [input.userText, input.intentAnchor ?? "", input.taskRole ?? "", input.agentName].join("\n")
  const queryTokens = tokenize(queryText)
  const tagTokens = pattern.tags.map((tag) => tag.toLowerCase())
  const matchingTags = [...new Set(tagTokens.filter((tag) => queryTokens.includes(tag)))]
  const agentTagHit = tagTokens.includes(input.agentName.toLowerCase())
  const taskRoleHit = !!input.taskRole && tagTokens.includes(input.taskRole.toLowerCase())
  const appliesText = pattern.applies_when.join(" ").toLowerCase()
  const summaryText = pattern.summary.toLowerCase()

  const scopeScore = pattern.scope === "project" ? 2 : 1
  const tagScore = matchingTags.length + (agentTagHit ? 2 : 0) + (taskRoleHit ? 1 : 0)
  const appliesScore = matchesAnyToken(appliesText, queryTokens) ? 2 : 0
  const summaryScore = matchesAnyToken(summaryText, queryTokens) ? 1 : 0
  const typeScore = kindPriority(pattern.kind)
  const confidenceScore = pattern.confidence
  const recencyScore = recencyBoost(pattern.updated_at, pattern.created_at)

  if (scopeScore > 0) reasons.push(`scope:${pattern.scope}+${scopeScore}`)
  if (tagScore > 0) reasons.push(`tags+${tagScore}`)
  if (appliesScore > 0) reasons.push("applies_when+2")
  if (summaryScore > 0) reasons.push("summary+1")
  reasons.push(`kind:${pattern.kind}+${typeScore}`)
  reasons.push(`confidence+${confidenceScore.toFixed(2)}`)
  if (recencyScore > 0) reasons.push(`recency+${recencyScore.toFixed(2)}`)

  const score = Number((scopeScore + tagScore + appliesScore + summaryScore + typeScore + confidenceScore + recencyScore).toFixed(3))
  return {
    ...pattern,
    score,
    score_reasons: reasons,
  }
}

export function searchRelevantPatterns(input: PatternRetrievalInput): PatternRecord[] {
  const maxPatterns = Math.max(1, input.maxPatterns ?? 5)
  const isWriter = input.agentName === "writer"
  const queryTokens = tokenize([input.userText, input.intentAnchor ?? "", input.taskRole ?? "", input.agentName].join("\n"))
  return input.patterns
    .filter((pattern) => pattern.status === "active")
    .filter((pattern) => !shouldDropAggressiveNoOp(pattern))
    .filter((pattern) => (isWriter ? pattern.scope === "project" : true))
    .filter((pattern) => (pattern.scope === "project" ? pattern.confidence >= 0.5 : pattern.confidence >= 0.8))
    .filter((pattern) => hasRelevanceOverlap(pattern, queryTokens))
    .map((pattern) => scorePatternForRequest(pattern, input))
    .filter((pattern) => (pattern.score ?? 0) > 0)
    .toSorted((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, maxPatterns)
    .map((pattern) => ({
      ...pattern,
      score: pattern.score,
      score_reasons: pattern.score_reasons,
    }))
}

export function formatPatternsForPrompt(patterns: PatternRecord[]) {
  const lines = ["Relevant patterns for this task:"]
  if (patterns.length === 0) {
    lines.push("- none.")
    return lines.join("\n")
  }
  return [
    ...lines,
    ...patterns.flatMap((pattern) => [
      `- Summary: ${pattern.summary}`,
      `  When: ${pattern.applies_when.length > 0 ? pattern.applies_when.join("; ") : "general"}`,
      `  Do: ${pattern.do.length > 0 ? pattern.do.join("; ") : "none"}`,
      `  Don't: ${pattern.dont.length > 0 ? pattern.dont.join("; ") : "none"}`,
      `  Scope: ${pattern.scope}`,
      `  Confidence: ${pattern.confidence.toFixed(2)}`,
      `  Why relevant: ${(pattern.score_reasons ?? []).join(", ") || "scored by relevance rules"}`,
    ]),
  ].join("\n")
}

export type { PatternKind, PatternRecord, PatternRetrievalInput, ScoredPattern, MemoryPatternSearchInput }
