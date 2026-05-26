import { Global } from "@codemate-ai/core/global"
import path from "path"
import { createMemoryFingerprint, inferMemoryKind } from "@/memory/types"
import type { MemoryRecord } from "@/memory/types"
import type { MemoryStore } from "@/memory/store"

type LegacySupermemoryRecord = {
  id?: string
  content?: string
  scope?: "user" | "project"
  tags?: string[]
  created_at?: number
  user?: string
  project_id?: string
}

function asStringArray(input: unknown) {
  if (!Array.isArray(input)) return []
  return [...new Set(input.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))]
}

function toMemoryRecord(item: LegacySupermemoryRecord): MemoryRecord | undefined {
  const id = typeof item.id === "string" ? item.id.trim() : ""
  const content = typeof item.content === "string" ? item.content.trim() : ""
  const scope = item.scope === "project" ? "project" : item.scope === "user" ? "user" : undefined
  if (!id || !content || !scope) return
  const createdAt = typeof item.created_at === "number" && Number.isFinite(item.created_at) ? item.created_at : Date.now()
  return {
    id: `legacy-supermemory:${id}`,
    kind: inferMemoryKind(content),
    scope,
    content: {
      summary: content,
    },
    tags: asStringArray(item.tags),
    attribution: {
      project_id: typeof item.project_id === "string" ? item.project_id : undefined,
    },
    quality: {
      confidence: 0.7,
      source: "imported",
    },
    lifecycle: {
      status: "active",
      created_at: createdAt,
      updated_at: createdAt,
      use_count: 0,
    },
    fingerprint: createMemoryFingerprint({
      scope,
      project_id: typeof item.project_id === "string" ? item.project_id : undefined,
      content,
    }),
  }
}

export class LegacySupermemoryAdapter implements Pick<MemoryStore, "list"> {
  private readonly filePath: string

  constructor(input?: { dataDir?: string; filePath?: string }) {
    this.filePath =
      input?.filePath ?? path.join(input?.dataDir ?? Global.Path.data, "storage", "supermemory", "records.json")
  }

  async list() {
    const file = Bun.file(this.filePath)
    if (!(await file.exists())) return []
    const parsed = JSON.parse(await file.text()) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .flatMap((item) => {
        const record = toMemoryRecord(item as LegacySupermemoryRecord)
        return record ? [record] : []
      })
      .toSorted((left, right) => right.lifecycle.updated_at - left.lifecycle.updated_at)
  }
}
