const LESSON_SCOPE = ["project", "global"] as const
const LESSON_TYPE = [
  "failure_pattern",
  "workflow_rule",
  "project_convention",
  "research_insight",
  "user_preference",
] as const
const LESSON_STATUS = ["active", "quarantined", "deprecated"] as const
const LESSON_STAGE = ["planner", "scheduler", "coder", "tester", "reviewer", "writer", "selfcheck", "memory", "unknown"] as const
const LESSON_QUALITY_SOURCE = [
  "fixed_after_failure",
  "tester_confirmed",
  "reviewer_confirmed",
  "selfcheck_confirmed",
  "research_quality_gate",
  "manual_user_instruction",
  "writer_summary",
  "legacy_migration",
] as const

export type LessonScope = (typeof LESSON_SCOPE)[number]
export type LessonType = (typeof LESSON_TYPE)[number]
export type LessonStatus = (typeof LESSON_STATUS)[number]

export type LessonTrajectory = {
  intent_anchor?: string
  failed_stage?: (typeof LESSON_STAGE)[number]
  failed_agent?: string
  failure_signal?: string
  failed_behavior?: string
  repair_action?: string
  success_signal?: string
  evidence_refs?: string[]
}

export type LessonQuality = {
  source: (typeof LESSON_QUALITY_SOURCE)[number]
  confidence: number
  evidence: string[]
  requires_user_confirmation?: boolean
}

export type LessonSource = {
  run_id?: string
  task_id?: string
  agent?: string
  tool?: "lesson_write" | "writer" | "closed_loop" | "legacy"
}

export type LessonRecord = {
  id: string
  version: 2
  scope: LessonScope
  type: LessonType
  status: LessonStatus
  summary: string
  tags: string[]
  applies_when: string[]
  avoid_when?: string[]
  do: string[]
  dont: string[]
  trajectory?: LessonTrajectory
  quality: LessonQuality
  source: LessonSource
  conflicts_with?: string[]
  supersedes?: string[]
  created_at: string
  updated_at: string
  fingerprint: string
}

export type LessonQualityValidation = {
  status: "active" | "quarantined" | "deprecated" | "rejected"
  reasons: string[]
}

export type LessonDedupeResult = {
  records: LessonRecord[]
  merged: boolean
  mergedWith?: string
}

export type LessonConflictResult = {
  conflicts_with: string[]
  possible_conflicts: string[]
}

export type LessonClassificationScope = "project" | "global" | "reject" | "quarantine"

export type LessonClassification = {
  classification_id: string
  scope: LessonClassificationScope
  type: LessonType
  tags: string[]
  confidence: number
  reasons: string[]
  created_at: string
  expires_at: string
}

function asString(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function asStringArray(value: unknown) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))]
}

function asOptionalStringArray(value: unknown) {
  const items = asStringArray(value)
  return items.length > 0 ? items : undefined
}

function pickOne<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  if (typeof value !== "string") return fallback
  return values.some((item) => item === value) ? (value as T) : fallback
}

function parseDate(value: unknown, fallback: string) {
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString()
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString()
  }
  return fallback
}

function clampConfidence(value: unknown, fallback: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

function extractSummary(raw: Record<string, unknown>) {
  const summary = asString(raw.summary) || asString(raw.lesson) || asString(raw.text)
  if (summary) return summary
  const fromDo = asStringArray(raw.do)[0]
  return fromDo ? fromDo : ""
}

export function computeLessonFingerprint(record: Pick<LessonRecord, "scope" | "type" | "summary" | "tags" | "applies_when" | "do" | "dont">) {
  const text = [
    record.scope,
    record.type,
    record.summary,
    ...record.tags,
    ...record.applies_when,
    ...record.do,
    ...record.dont,
  ]
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff\s]+/g, " ")
  const tokens = [...new Set(text.split(/\s+/).filter((token) => token.length > 1))].slice(0, 20)
  return tokens.join("|")
}

export function migrateLegacyLesson(raw: unknown, input?: { scope?: LessonScope }): LessonRecord {
  const now = new Date().toISOString()
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
  const summary = extractSummary(source) || "legacy lesson"
  const tags = asStringArray(source.tags)
  const scope = pickOne(input?.scope ?? source.scope, LESSON_SCOPE, "project")
  const createdAt = parseDate(source.created_at, now)
  const updatedAt = parseDate(source.updated_at ?? source.created_at, createdAt)
  const migrated = {
    id: asString(source.id) || Date.now().toString(36),
    version: 2 as const,
    scope,
    type: "workflow_rule" as const,
    status: "active" as const,
    summary,
    tags,
    applies_when: [],
    do: [summary],
    dont: [],
    quality: {
      source: "legacy_migration" as const,
      confidence: 0.45,
      evidence: ["legacy lesson migrated"],
    },
    source: {
      agent: asString(source.agent) || undefined,
      tool: "legacy" as const,
    },
    created_at: createdAt,
    updated_at: updatedAt,
    fingerprint: asString(source.fingerprint),
  }
  return {
    ...migrated,
    fingerprint: migrated.fingerprint || computeLessonFingerprint(migrated),
  }
}

function parseTrajectory(value: unknown): LessonTrajectory | undefined {
  if (!value || typeof value !== "object") return
  const source = value as Record<string, unknown>
  const evidenceRefs = asOptionalStringArray(source.evidence_refs)
  const trajectory = {
    intent_anchor: asString(source.intent_anchor) || undefined,
    failed_stage: pickOne(source.failed_stage, LESSON_STAGE, "unknown"),
    failed_agent: asString(source.failed_agent) || undefined,
    failure_signal: asString(source.failure_signal) || undefined,
    failed_behavior: asString(source.failed_behavior) || undefined,
    repair_action: asString(source.repair_action) || undefined,
    success_signal: asString(source.success_signal) || undefined,
    evidence_refs: evidenceRefs,
  }
  const hasContent = Object.values(trajectory).some((entry) => (Array.isArray(entry) ? entry.length > 0 : !!entry))
  return hasContent ? trajectory : undefined
}

export function parseLessonRecord(raw: unknown, input?: { scope?: LessonScope }): LessonRecord | undefined {
  if (!raw || typeof raw !== "object") return
  const source = raw as Record<string, unknown>
  if (source.version !== 2) return migrateLegacyLesson(raw, input)

  const now = new Date().toISOString()
  const scope = pickOne(input?.scope ?? source.scope, LESSON_SCOPE, "project")
  const type = pickOne(source.type, LESSON_TYPE, "workflow_rule")
  const status = pickOne(source.status, LESSON_STATUS, "quarantined")
  const summary = extractSummary(source)
  if (!summary) return

  const tags = asStringArray(source.tags)
  const appliesWhen = asStringArray(source.applies_when)
  const avoidWhen = asOptionalStringArray(source.avoid_when)
  const doItems = asStringArray(source.do)
  const dontItems = asStringArray(source.dont)
  const createdAt = parseDate(source.created_at, now)
  const updatedAt = parseDate(source.updated_at, createdAt)

  const qualityRaw = source.quality && typeof source.quality === "object" ? (source.quality as Record<string, unknown>) : {}
  const quality = {
    source: pickOne(qualityRaw.source, LESSON_QUALITY_SOURCE, "legacy_migration"),
    confidence: clampConfidence(qualityRaw.confidence, 0.5),
    evidence: asStringArray(qualityRaw.evidence),
    requires_user_confirmation:
      typeof qualityRaw.requires_user_confirmation === "boolean" ? qualityRaw.requires_user_confirmation : undefined,
  }

  const sourceRaw = source.source && typeof source.source === "object" ? (source.source as Record<string, unknown>) : {}
  const sourceInfo = {
    run_id: asString(sourceRaw.run_id) || undefined,
    task_id: asString(sourceRaw.task_id) || undefined,
    agent: asString(sourceRaw.agent) || undefined,
    tool: pickOne(sourceRaw.tool, ["lesson_write", "writer", "closed_loop", "legacy"] as const, "legacy"),
  }

  const record = {
    id: asString(source.id) || Date.now().toString(36),
    version: 2 as const,
    scope,
    type,
    status,
    summary,
    tags,
    applies_when: appliesWhen,
    avoid_when: avoidWhen,
    do: doItems.length > 0 ? doItems : [summary],
    dont: dontItems,
    trajectory: parseTrajectory(source.trajectory),
    quality: {
      ...quality,
      evidence: quality.evidence.length > 0 ? quality.evidence : ["v2 lesson parsed"],
    },
    source: sourceInfo,
    conflicts_with: asOptionalStringArray(source.conflicts_with),
    supersedes: asOptionalStringArray(source.supersedes),
    created_at: createdAt,
    updated_at: updatedAt,
    fingerprint: asString(source.fingerprint),
  }

  return {
    ...record,
    fingerprint: record.fingerprint || computeLessonFingerprint(record),
  }
}

export function serializeLessonRecord(record: LessonRecord) {
  return JSON.stringify(record)
}

function recordText(record: Pick<LessonRecord, "summary" | "applies_when" | "do" | "dont">) {
  return [record.summary, ...record.applies_when, ...record.do, ...record.dont].join("\n").toLowerCase()
}

function hasProjectSpecificPath(text: string) {
  return (
    /(?:^|[\s"'`])(?:\/[a-z0-9._/\-]+|[a-zA-Z]:\\[^\s"'`]+|\.\/|\.\.\/)/i.test(text) ||
    /\b(?:packages\/|src\/|test\/|\.codemate\/|readme\.md)\b/i.test(text)
  )
}

function looksGenericAdvice(text: string) {
  return [
    "verify your work",
    "be careful",
    "write tests",
    "remember to test",
  ].some((pattern) => text.includes(pattern))
}

export function looksLikeChangelogFact(input: LessonRecord | string) {
  const text =
    typeof input === "string"
      ? input.toLowerCase()
      : recordText({
          summary: input.summary,
          applies_when: input.applies_when,
          do: input.do,
          dont: input.dont,
        })
  return [
    /\bcreated file\b/i,
    /\bupdated readme\b/i,
    /\bran command\b/i,
    /\bgenerated certificate\b/i,
    /\bimplemented feature\b/i,
  ].some((pattern) => pattern.test(text))
}

export function isLessonClassificationExpired(classification: Pick<LessonClassification, "expires_at">, now = Date.now()) {
  const expires = Date.parse(classification.expires_at)
  if (!Number.isFinite(expires)) return true
  return now >= expires
}

export function validateLessonQuality(record: LessonRecord): LessonQualityValidation {
  if (record.status !== "active") {
    return { status: record.status, reasons: [] }
  }

  const reasons: string[] = []
  const text = recordText(record)
  if (!record.summary.trim()) reasons.push("missing_summary")
  if (record.tags.length === 0) reasons.push("missing_tags")
  if (record.do.length === 0 && record.dont.length === 0) reasons.push("missing_do_or_dont")
  if (record.quality.evidence.length === 0) reasons.push("missing_quality_evidence")
  if (looksGenericAdvice(text)) reasons.push("generic_advice")
  if (looksLikeChangelogFact(record)) reasons.push("changelog_fact")

  if (record.scope === "global") {
    if (record.quality.confidence < 0.8) reasons.push("global_low_confidence")
    if (record.quality.source === "writer_summary") reasons.push("global_writer_summary_only")
    if (record.applies_when.length === 0) reasons.push("global_missing_applies_when")
    if (record.do.length === 0) reasons.push("global_missing_do")
    if (record.dont.length === 0) reasons.push("global_missing_dont")
    if (hasProjectSpecificPath(text)) reasons.push("global_project_specific")
  }

  if (reasons.includes("missing_summary")) {
    return { status: "rejected", reasons }
  }
  if (reasons.length > 0) {
    return { status: "quarantined", reasons }
  }
  return { status: "active", reasons: [] }
}

export function formatLessonForInjection(record: LessonRecord) {
  const whenText = record.applies_when.length > 0 ? record.applies_when.join("; ") : "general"
  const doText = record.do.length > 0 ? record.do.join("; ") : record.summary
  const dontText = record.dont.length > 0 ? record.dont.join("; ") : "none"
  return [
    `- [${record.scope}]`,
    `  Summary: ${record.summary}`,
    `  When: ${whenText}`,
    `  Do: ${doText}`,
    `  Don't: ${dontText}`,
    `  Scope: ${record.scope}`,
    `  Tags: ${record.tags.join(",") || "none"}`,
  ].join("\n")
}

function mergeTextList(left: string[], right: string[]) {
  return [
    ...new Set(
      [...left, ...right]
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ]
}

function normalizedText(value: string) {
  return value
    .toLowerCase()
    .replace(/\b(don't|cant|can't|wont|won't)\b/g, (token) => {
      if (token === "don't") return "do not"
      if (token === "cant" || token === "can't") return "can not"
      if (token === "wont" || token === "won't") return "will not"
      return token
    })
    .replace(/no[\s-]?op/g, "noop")
    .replace(/[^a-z0-9\u4e00-\u9fff\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function semanticTokens(value: string) {
  const stop = new Set([
    "the",
    "a",
    "an",
    "to",
    "of",
    "and",
    "or",
    "for",
    "in",
    "on",
    "when",
    "if",
    "then",
    "must",
    "should",
    "always",
    "never",
    "do",
    "not",
    "avoid",
    "be",
    "is",
    "are",
    "was",
    "were",
    "this",
    "that",
  ])
  return [...new Set(normalizedText(value).split(" ").filter((token) => token.length > 1 && !stop.has(token)))]
}

function jaccard(left: string[], right: string[]) {
  if (left.length === 0 || right.length === 0) return 0
  const leftSet = new Set(left)
  const rightSet = new Set(right)
  const intersection = left.filter((token) => rightSet.has(token)).length
  const union = new Set([...leftSet, ...rightSet]).size
  return union === 0 ? 0 : intersection / union
}

function textSimilar(left: string, right: string) {
  const a = normalizedText(left)
  const b = normalizedText(right)
  if (!a || !b) return false
  if (a === b) return true
  const aTokens = semanticTokens(a)
  const bTokens = semanticTokens(b)
  if (aTokens.length === 0 || bTokens.length === 0) return false
  return jaccard(aTokens, bTokens) >= 0.75 && Math.min(aTokens.length, bTokens.length) >= 2
}

function oppositePatternMatch(left: string, right: string) {
  const a = normalizedText(left)
  const b = normalizedText(right)
  if (!a || !b) return false
  const checkPairs: Array<[string, string]> = [
    ["must ", "must not "],
    ["should ", "should not "],
    ["always ", "never "],
    ["noop", "do not noop"],
  ]
  const directional = checkPairs.some(([positive, negative]) => {
    return (a.includes(positive) && b.includes(negative)) || (b.includes(positive) && a.includes(negative))
  })
  if (!directional) return false
  return jaccard(semanticTokens(a), semanticTokens(b)) >= 0.45
}

function tagsOverlap(left: string[], right: string[]) {
  if (left.length === 0 || right.length === 0) return false
  const a = left.map((item) => item.toLowerCase().trim()).filter(Boolean)
  const b = new Set(right.map((item) => item.toLowerCase().trim()).filter(Boolean))
  const shared = [...new Set(a.filter((item) => b.has(item)))]
  return shared.length >= Math.min(2, Math.min(a.length, b.size))
}

function appliesOverlap(left: string[], right: string[]) {
  if (left.length === 0 || right.length === 0) return false
  const leftNormalized = left.map((item) => normalizedText(item)).filter(Boolean)
  const rightNormalized = right.map((item) => normalizedText(item)).filter(Boolean)
  if (leftNormalized.some((item) => rightNormalized.includes(item))) return true
  return jaccard(
    semanticTokens(leftNormalized.join(" ")),
    semanticTokens(rightNormalized.join(" ")),
  ) >= 0.6
}

function directionalConflict(left: string[], right: string[]) {
  if (left.length === 0 || right.length === 0) return false
  return left.some((a) => right.some((b) => textSimilar(a, b) || oppositePatternMatch(a, b)))
}

export function detectLessonConflicts(existing: LessonRecord[], incoming: LessonRecord): LessonConflictResult {
  const next = existing.reduce(
    (acc, candidate) => {
      if (candidate.fingerprint === incoming.fingerprint) return acc
      const contextAligned = tagsOverlap(candidate.tags, incoming.tags) || appliesOverlap(candidate.applies_when, incoming.applies_when)
      if (!contextAligned) return acc
      const isConflict =
        directionalConflict(incoming.do, candidate.dont) ||
        directionalConflict(incoming.dont, candidate.do) ||
        directionalConflict([incoming.summary], candidate.dont) ||
        directionalConflict([candidate.summary], incoming.dont)
      if (!isConflict) return acc
      if (candidate.status === "active") {
        return {
          ...acc,
          conflicts_with: [...acc.conflicts_with, candidate.id],
        }
      }
      return {
        ...acc,
        possible_conflicts: [...acc.possible_conflicts, candidate.id],
      }
    },
    {
      conflicts_with: [] as string[],
      possible_conflicts: [] as string[],
    },
  )
  return {
    conflicts_with: [...new Set(next.conflicts_with)],
    possible_conflicts: [...new Set(next.possible_conflicts)],
  }
}

function preferSaferStatus(
  existing: LessonStatus,
  incoming: LessonStatus,
  _incomingValidation: LessonQualityValidation,
): LessonStatus {
  if (existing === "deprecated" || incoming === "deprecated") return "deprecated"
  if (existing === "quarantined" || incoming === "quarantined") return "quarantined"
  return "active"
}

function mergeOneLessonRecord(existing: LessonRecord, incoming: LessonRecord): LessonRecord {
  const incomingValidation = validateLessonQuality(incoming)
  return {
    ...existing,
    status: preferSaferStatus(existing.status, incoming.status, incomingValidation),
    tags: mergeTextList(existing.tags, incoming.tags),
    applies_when: mergeTextList(existing.applies_when, incoming.applies_when),
    do: mergeTextList(existing.do, incoming.do),
    dont: mergeTextList(existing.dont, incoming.dont),
    trajectory: existing.trajectory ?? incoming.trajectory,
    quality: {
      ...existing.quality,
      confidence: Math.max(existing.quality.confidence, incoming.quality.confidence),
      evidence: mergeTextList(existing.quality.evidence, incoming.quality.evidence),
    },
    updated_at: incoming.updated_at,
    fingerprint: existing.fingerprint || incoming.fingerprint || computeLessonFingerprint(existing),
  }
}

export function dedupeLessonRecords(existing: LessonRecord[], incoming: LessonRecord): LessonDedupeResult {
  const firstMatchIndex = existing.findIndex((item) => item.fingerprint === incoming.fingerprint)
  if (firstMatchIndex === -1) {
    return {
      records: [...existing, incoming],
      merged: false,
    }
  }

  const canonical = existing
    .filter((item) => item.fingerprint === incoming.fingerprint)
    .reduce((acc, item) => mergeOneLessonRecord(acc, item))
  const merged = mergeOneLessonRecord(canonical, incoming)
  const consumed = new Set(
    existing.flatMap((item, index) => (item.fingerprint === incoming.fingerprint ? [index] : [])),
  )
  const records = existing.flatMap((item, index) => {
    if (!consumed.has(index)) return [item]
    if (index === firstMatchIndex) return [{ ...merged, created_at: item.created_at }]
    return []
  })
  return {
    records,
    merged: true,
    mergedWith: existing[firstMatchIndex]?.id,
  }
}

// Phase 2-5 hooks:
// - validateLessonQuality / changelog-fact quarantine
// - classification_id hard binding
// - failure trajectory event attachment
// - fingerprint dedupe + conflict/status lifecycle
