import path from "path"
import type { FailureRecoveryCandidate } from "@/session/closed-loop"
import {
  type AgentMemoryIndex,
  type AgentMemoryRecord,
  failureRecoveryCandidateToAgentMemory,
  lessonRecordToAgentMemory,
  trajectoryRecordToAgentMemory,
} from "@/session/agent-memory-index"
import { parseLessonRecord } from "@/session/lesson-schema"
import { readTrajectoryRecords } from "@/session/trajectory"

export type AgentMemorySyncResult = {
  read: number
  upserted: number
  skipped: number
  warnings: string[]
}

export type SyncProjectLessonsOptions = {
  includeGlobal?: boolean
  sourcePath?: string
}

export type SyncProjectMemorySourcesOptions = {
  includeGlobalLessons?: boolean
  lessonSourcePath?: string
  failureRecoveryCandidates?: FailureRecoveryCandidate[]
}

function parseTime(value: string | undefined) {
  if (!value?.trim()) return
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) return
  return parsed
}

function mergeSyncResult(base: AgentMemorySyncResult, next: AgentMemorySyncResult): AgentMemorySyncResult {
  return {
    read: base.read + next.read,
    upserted: base.upserted + next.upserted,
    skipped: base.skipped + next.skipped,
    warnings: [...base.warnings, ...next.warnings],
  }
}

async function upsertDedup(index: AgentMemoryIndex, records: AgentMemoryRecord[]) {
  const existing = await index.list({ includeInactive: true })
  const byId = new Map(existing.map((record) => [record.id, record]))
  const bySourceId = new Map(existing.flatMap((record) => (record.source_id ? [[record.source_id, record] as const] : [])))
  const result: AgentMemorySyncResult = {
    read: records.length,
    upserted: 0,
    skipped: 0,
    warnings: [],
  }

  for (const candidate of records) {
    const matched = byId.get(candidate.id) ?? (candidate.source_id ? bySourceId.get(candidate.source_id) : undefined)
    if (matched) {
      const currentTime = parseTime(matched.updated_at) ?? Number.NEGATIVE_INFINITY
      const incomingTime = parseTime(candidate.updated_at) ?? Number.NEGATIVE_INFINITY
      if (currentTime > incomingTime) {
        result.skipped += 1
        continue
      }
      const nextRecord = {
        ...candidate,
        id: matched.id,
        created_at: matched.created_at,
      }
      try {
        const saved = await index.upsert(nextRecord)
        result.upserted += 1
        byId.set(saved.id, saved)
        if (saved.source_id) bySourceId.set(saved.source_id, saved)
      } catch (error) {
        result.warnings.push(
          `index upsert failed for ${candidate.id}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      continue
    }

    try {
      const saved = await index.upsert(candidate)
      result.upserted += 1
      byId.set(saved.id, saved)
      if (saved.source_id) bySourceId.set(saved.source_id, saved)
    } catch (error) {
      result.warnings.push(`index upsert failed for ${candidate.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return result
}

export async function syncProjectLessonsToMemoryIndex(
  projectRoot: string,
  index: AgentMemoryIndex,
  options: SyncProjectLessonsOptions = {},
): Promise<AgentMemorySyncResult> {
  const sourcePath = options.sourcePath ?? path.join(projectRoot, ".codemate", "lessons.jsonl")
  const file = Bun.file(sourcePath)
  if (!(await file.exists())) {
    return { read: 0, upserted: 0, skipped: 0, warnings: [] }
  }

  const warnings: string[] = []
  const candidates = (await file.text())
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line, indexOfLine) => {
      let raw: unknown
      try {
        raw = JSON.parse(line)
      } catch {
        warnings.push(`invalid lesson line ${indexOfLine + 1}: JSON parse failed`)
        return []
      }
      const parsed = parseLessonRecord(raw)
      if (!parsed) {
        warnings.push(`invalid lesson line ${indexOfLine + 1}: parse lesson failed`)
        return []
      }
      if (!options.includeGlobal && parsed.scope === "global") return []
      return [lessonRecordToAgentMemory(parsed)]
    })

  const synced = await upsertDedup(index, candidates)
  return {
    ...synced,
    warnings: [...warnings, ...synced.warnings],
  }
}

export async function syncProjectTrajectoriesToMemoryIndex(
  projectRoot: string,
  index: AgentMemoryIndex,
): Promise<AgentMemorySyncResult> {
  const trajectories = await readTrajectoryRecords(projectRoot)
  const candidates = trajectories.records.map((record) =>
    trajectoryRecordToAgentMemory(record, {
      scope: "project",
      projectRoot,
    }),
  )
  const synced = await upsertDedup(index, candidates)
  return {
    ...synced,
    warnings: [...trajectories.warnings, ...synced.warnings],
  }
}

export async function syncProjectMemorySources(
  projectRoot: string,
  index: AgentMemoryIndex,
  options: SyncProjectMemorySourcesOptions = {},
): Promise<AgentMemorySyncResult> {
  const lessons = await syncProjectLessonsToMemoryIndex(projectRoot, index, {
    includeGlobal: options.includeGlobalLessons,
    sourcePath: options.lessonSourcePath,
  })
  const trajectories = await syncProjectTrajectoriesToMemoryIndex(projectRoot, index)
  let combined = mergeSyncResult(lessons, trajectories)

  if (!options.failureRecoveryCandidates || options.failureRecoveryCandidates.length === 0) {
    return combined
  }

  const failureRecords = options.failureRecoveryCandidates.map((item) =>
    failureRecoveryCandidateToAgentMemory(item, {
      scope: "project",
    }),
  )
  const failures = await upsertDedup(index, failureRecords)
  combined = mergeSyncResult(combined, failures)
  return combined
}
