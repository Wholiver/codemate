import { Hash } from "@codemate-ai/core/util/hash"

export const MEMORY_PROCESS_ID = [
  "task-orchestrator",
  "planner",
  "coder",
  "tester",
  "reviewer",
  "selfcheck",
  "writer",
  "recovery",
  "tool",
] as const

export type MemoryProcessID = (typeof MEMORY_PROCESS_ID)[number]
export type MemoryRecordKind = "fact" | "preference" | "rule" | "project_state" | "tool_fact" | "agent_state" | "relationship"
export type MemoryRecordScope = "user" | "project" | "session" | "global"
export type MemoryRecordSource = "user_stated" | "observed" | "derived" | "imported"
export type MemoryLifecycleStatus = "active" | "tentative" | "deprecated"
export type MemoryEventType =
  | "agent_input"
  | "agent_output"
  | "tool_call"
  | "tool_result"
  | "user_memory_instruction"
  | "project_observation"
  | "selfcheck_observation"

export type MemoryAttribution = {
  run_id?: string
  project_id?: string
  project_root?: string
  session_id?: string
  message_id?: string
  agent?: string
  process_id?: MemoryProcessID
  tool_name?: string
  tool_call_id?: string
  workflow_task_id?: string
  workflow_task_key?: string
  subagent_session_id?: string
}

export type MemoryRecord = {
  id: string
  kind: MemoryRecordKind
  scope: MemoryRecordScope
  content: {
    summary: string
    details?: string
    applies_when?: string
    do?: string
    dont?: string
  }
  tags: string[]
  attribution: MemoryAttribution
  quality: {
    confidence: number
    source: MemoryRecordSource
  }
  lifecycle: {
    status: MemoryLifecycleStatus
    created_at: number
    updated_at: number
    last_used_at?: number
    use_count: number
  }
  fingerprint: string
}

export type MemoryEvent = {
  id: string
  type: MemoryEventType
  attribution: MemoryAttribution
  content: string
  metadata: Record<string, unknown>
  created_at: number
}

export type MemoryPack = {
  records: MemoryRecord[]
  reminder: string
}

export function normalizeMemoryText(text: string) {
  return text.replace(/\s+/g, " ").trim()
}

export function tokenizeMemoryText(text: string) {
  return normalizeMemoryText(text)
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/g)
    .map((item) => item.trim())
    .filter((item) => item.length > 1)
}

export function inferMemoryKind(text: string): MemoryRecordKind {
  const normalized = normalizeMemoryText(text).toLowerCase()
  if (!normalized) return "fact"
  if (/\bprefer(?:ence)?\b|\b偏好\b|\b喜欢\b|\b习惯\b/.test(normalized)) return "preference"
  if (/\bmust\b|\balways\b|\bnever\b|\b不要\b|\b必须\b|\b需要\b|\b应该\b/.test(normalized)) return "rule"
  return "fact"
}

export function createMemoryFingerprint(input: { scope: MemoryRecordScope; project_id?: string; content: string }) {
  return Hash.fast(`${input.scope}|${input.project_id ?? "none"}|${normalizeMemoryText(input.content).toLowerCase()}`)
}

