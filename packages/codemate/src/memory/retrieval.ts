import { tokenizeMemoryText } from "@/memory/types"
import type { MemoryAttribution, MemoryRecord } from "@/memory/types"

type RankedMemory = {
  record: MemoryRecord
  score: number
}

function isProjectScopedMatch(record: MemoryRecord, attribution: MemoryAttribution) {
  const targetProjectID = attribution.project_id
  const recordProjectID = record.attribution.project_id
  if (record.scope !== "project") return true
  if (targetProjectID && recordProjectID) return targetProjectID === recordProjectID
  if (!recordProjectID) return true
  return false
}

function isSessionScopedMatch(record: MemoryRecord, attribution: MemoryAttribution) {
  if (record.scope !== "session") return true
  if (!attribution.session_id) return false
  return record.attribution.session_id === attribution.session_id
}

function scopeBoost(record: MemoryRecord) {
  if (record.scope === "project") return 2.8
  if (record.scope === "session") return 2.5
  if (record.scope === "user") return 1.1
  return 0.8
}

function projectBoost(record: MemoryRecord, attribution: MemoryAttribution) {
  if (record.scope !== "project") {
    if (record.attribution.project_id && record.attribution.project_id === attribution.project_id) return 0.4
    return 0
  }
  if (!record.attribution.project_id) return 0.5
  if (record.attribution.project_id === attribution.project_id) return 4.2
  return -100
}

function recencyBoost(record: MemoryRecord, now = Date.now()) {
  const ageMs = Math.max(0, now - (record.lifecycle.updated_at || record.lifecycle.created_at))
  const ageDays = ageMs / (24 * 60 * 60 * 1000)
  return 1 / (1 + ageDays / 30)
}

function lexicalScore(record: MemoryRecord, query: string) {
  const queryTokens = tokenizeMemoryText(query)
  if (queryTokens.length === 0) return 0
  const haystack = [
    record.content.summary,
    record.content.details ?? "",
    record.content.applies_when ?? "",
    record.content.do ?? "",
    record.content.dont ?? "",
    record.tags.join(" "),
  ]
    .join(" ")
    .toLowerCase()
  const tokenMatch = queryTokens.reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0)
  const exactPhraseBoost = haystack.includes(query.trim().toLowerCase()) ? 3.2 : 0
  const tagBoost = queryTokens.reduce(
    (sum, token) => sum + (record.tags.some((tag) => tag.toLowerCase().includes(token)) ? 1 : 0),
    0,
  )
  return tokenMatch * 1.6 + exactPhraseBoost + tagBoost * 1.1
}

export function rankMemoryRecords(input: {
  records: MemoryRecord[]
  query: string
  attribution: MemoryAttribution
}): RankedMemory[] {
  return input.records
    .flatMap((record) => {
      if (!isProjectScopedMatch(record, input.attribution)) return []
      if (!isSessionScopedMatch(record, input.attribution)) return []
      const lexical = lexicalScore(record, input.query)
      if (lexical <= 0) return []
      const confidenceBoost = Math.max(0, Math.min(1, record.quality.confidence)) * 1.3
      const score =
        lexical + scopeBoost(record) + projectBoost(record, input.attribution) + confidenceBoost + recencyBoost(record)
      if (score <= 0) return []
      return [{ record, score }]
    })
    .toSorted(
      (left, right) =>
        right.score - left.score || right.record.lifecycle.updated_at - left.record.lifecycle.updated_at,
    )
}

