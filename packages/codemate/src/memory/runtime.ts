import { ulid } from "ulid"
import { LegacySupermemoryAdapter } from "@/memory/adapters/legacy-supermemory"
import { formatMemoryReminder } from "@/memory/formatter"
import { rankMemoryRecords } from "@/memory/retrieval"
import { CompositeMemoryStore, JsonlMemoryStore } from "@/memory/store"
import {
  createMemoryFingerprint,
  inferMemoryKind,
  normalizeMemoryText,
  tokenizeMemoryText,
  type MemoryAttribution,
  type MemoryPack,
  type MemoryRecord,
  type MemoryRecordScope,
} from "@/memory/types"

export class MemoryRuntime {
  private readonly store: CompositeMemoryStore | JsonlMemoryStore
  private readonly projectRoot?: string

  constructor(input?: { projectRoot?: string; dataDir?: string; store?: CompositeMemoryStore | JsonlMemoryStore }) {
    this.projectRoot = input?.projectRoot
    this.store =
      input?.store ??
      new CompositeMemoryStore({
        primary: new JsonlMemoryStore({
          projectRoot: input?.projectRoot,
          dataDir: input?.dataDir,
        }),
        legacy: new LegacySupermemoryAdapter({ dataDir: input?.dataDir }),
      })
  }

  async beforeAgentCall(input: { agent: string; attribution: MemoryAttribution; query: string; topK?: number }): Promise<MemoryPack> {
    const records = await this.store.list()
    const top = rankMemoryRecords({
      records,
      query: input.query,
      attribution: {
        ...input.attribution,
        agent: input.attribution.agent ?? input.agent,
      },
    })
      .slice(0, input.topK ?? 5)
      .map((item) => item.record)
    return {
      records: top,
      reminder: formatMemoryReminder(top),
    }
  }

  async rememberUserInstruction(input: {
    text: string
    attribution: MemoryAttribution
    scope?: MemoryRecordScope
    tags?: string[]
  }) {
    const summary = normalizeMemoryText(input.text)
    if (!summary) throw new Error("text is required")
    const scope = input.scope ?? "user"
    const now = Date.now()
    const attribution: MemoryAttribution = {
      ...input.attribution,
      project_root: input.attribution.project_root ?? this.projectRoot,
    }
    const record: MemoryRecord = {
      id: `memory:${ulid()}`,
      kind: inferMemoryKind(summary),
      scope,
      content: { summary },
      tags: [...new Set([...(input.tags ?? []), ...tokenizeMemoryText(summary)])].slice(0, 8),
      attribution,
      quality: {
        confidence: 0.9,
        source: "user_stated",
      },
      lifecycle: {
        status: "active",
        created_at: now,
        updated_at: now,
        use_count: 0,
      },
      fingerprint: createMemoryFingerprint({
        scope,
        project_id: attribution.project_id,
        content: summary,
      }),
    }
    await this.store.write(record)
    return record
  }

  async search(input: { query: string; attribution: MemoryAttribution; topK?: number }) {
    return rankMemoryRecords({
      records: await this.store.list(),
      query: input.query,
      attribution: input.attribution,
    })
      .slice(0, input.topK ?? 10)
      .map((item) => item.record)
  }

  async list(input?: { scope?: MemoryRecordScope; attribution?: MemoryAttribution }) {
    const records = await this.store.list()
    return records.filter((record) => {
      if (input?.scope && record.scope !== input.scope) return false
      if (!input?.attribution) return true
      if (record.scope === "project") {
        if (!record.attribution.project_id) return true
        return record.attribution.project_id === input.attribution.project_id
      }
      if (record.scope === "session") {
        return record.attribution.session_id === input.attribution.session_id
      }
      return true
    })
  }

  async profile() {
    const records = await this.store.list()
    const byScope = records.reduce<Record<MemoryRecordScope, number>>(
      (acc, record) => {
        acc[record.scope] += 1
        return acc
      },
      { user: 0, project: 0, session: 0, global: 0 },
    )
    const byKind = records.reduce<Record<string, number>>((acc, record) => {
      acc[record.kind] = (acc[record.kind] ?? 0) + 1
      return acc
    }, {})
    const topTags = Object.entries(
      records.reduce<Record<string, number>>((acc, record) => {
        for (const tag of record.tags) acc[tag] = (acc[tag] ?? 0) + 1
        return acc
      }, {}),
    )
      .toSorted((left, right) => right[1] - left[1])
      .slice(0, 10)
      .map(([tag, count]) => ({ tag, count }))
    return {
      total: records.length,
      by_scope: byScope,
      by_kind: byKind,
      top_tags: topTags,
    }
  }

  async forget(input: { id?: string; query?: string }) {
    if (!input.id?.trim() && !input.query?.trim()) {
      return {
        removed: 0,
        no_op: true,
        reason: "id_or_query_required",
      }
    }
    return {
      removed: await this.store.forget({ id: input.id?.trim(), query: input.query?.trim() }),
      no_op: false,
    }
  }
}
