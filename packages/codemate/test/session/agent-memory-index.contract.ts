import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import type { AgentMemoryIndex, AgentMemoryRecord } from "@/session/agent-memory-index"

export type AgentMemoryIndexContractContext = {
  index: AgentMemoryIndex
  filePath?: string
}

export type AgentMemoryIndexFactory = () => Promise<AgentMemoryIndexContractContext> | AgentMemoryIndexContractContext

const baseTime = Date.parse("2026-01-01T00:00:00.000Z")

function iso(offsetMs = 0) {
  return new Date(baseTime + offsetMs).toISOString()
}

function makeRecord(input?: Partial<AgentMemoryRecord>): AgentMemoryRecord {
  return {
    id: input?.id ?? "memory:r1",
    kind: input?.kind ?? "lesson",
    scope: input?.scope ?? "project",
    text: input?.text ?? "release verification memory",
    tags: input?.tags ?? ["release", "verification"],
    confidence: input?.confidence ?? 0.82,
    status: input?.status ?? "active",
    source_id: input?.source_id,
    source_path: input?.source_path,
    run_id: input?.run_id,
    task_id: input?.task_id,
    agent: input?.agent,
    created_at: input?.created_at ?? iso(0),
    updated_at: input?.updated_at ?? iso(0),
    metadata: input?.metadata ?? {},
  }
}

export function runAgentMemoryIndexContract(name: string, createIndex: AgentMemoryIndexFactory) {
  describe(`session.agent-memory-index contract (${name})`, () => {
    test("upsert creates record", async () => {
      const { index } = await createIndex()
      await index.upsert(makeRecord({ id: "memory:create-1", source_id: "src:create-1" }))
      const listed = await index.list({ includeInactive: true })
      expect(listed.length).toBe(1)
      expect(listed[0]?.id).toBe("memory:create-1")
    })

    test("upsert same id/source_id does not duplicate", async () => {
      const { index } = await createIndex()
      await index.upsert(makeRecord({ id: "memory:dup-a", source_id: "src:dup" }))
      await index.upsert(makeRecord({ id: "memory:dup-a", source_id: "src:dup", text: "updated text same id" }))
      await index.upsert(makeRecord({ id: "memory:dup-b", source_id: "src:dup", text: "updated text same source" }))
      const listed = await index.list({ includeInactive: true })
      expect(listed.length).toBe(1)
      expect(listed[0]?.source_id).toBe("src:dup")
    })

    test("newer updated_at replaces older", async () => {
      const { index } = await createIndex()
      await index.upsert(
        makeRecord({
          id: "memory:newer-a",
          source_id: "src:newer",
          text: "older text",
          updated_at: iso(1000),
          created_at: iso(1000),
        }),
      )
      await index.upsert(
        makeRecord({
          id: "memory:newer-b",
          source_id: "src:newer",
          text: "newer text",
          updated_at: iso(3000),
          created_at: iso(3000),
        }),
      )
      const listed = await index.list({ includeInactive: true })
      expect(listed.length).toBe(1)
      expect(listed[0]?.text).toContain("newer text")
      expect(listed[0]?.updated_at).toBe(iso(3000))
    })

    test("older updated_at does not overwrite newer", async () => {
      const { index } = await createIndex()
      await index.upsert(
        makeRecord({
          id: "memory:older-a",
          source_id: "src:older",
          text: "newer text persists",
          updated_at: iso(4000),
          created_at: iso(4000),
        }),
      )
      await index.upsert(
        makeRecord({
          id: "memory:older-b",
          source_id: "src:older",
          text: "older text should not win",
          updated_at: iso(2000),
          created_at: iso(2000),
        }),
      )
      const listed = await index.list({ includeInactive: true })
      expect(listed.length).toBe(1)
      expect(listed[0]?.text).toContain("newer text persists")
      expect(listed[0]?.updated_at).toBe(iso(4000))
    })

    test("search default active-only", async () => {
      const { index } = await createIndex()
      await index.upsert(makeRecord({ id: "memory:active", text: "tls rule", status: "active" }))
      await index.upsert(makeRecord({ id: "memory:quarantine", text: "tls rule", status: "quarantined" }))
      await index.upsert(makeRecord({ id: "memory:deprecated", text: "tls rule", status: "deprecated" }))
      const search = await index.search("tls rule")
      expect(search.map((item) => item.id)).toContain("memory:active")
      expect(search.map((item) => item.id)).not.toContain("memory:quarantine")
      expect(search.map((item) => item.id)).not.toContain("memory:deprecated")
    })

    test("includeInactive returns quarantined/deprecated", async () => {
      const { index } = await createIndex()
      await index.upsert(makeRecord({ id: "memory:active-inactive", text: "inactive rule", status: "active" }))
      await index.upsert(makeRecord({ id: "memory:quarantined-inactive", text: "inactive rule", status: "quarantined" }))
      await index.upsert(makeRecord({ id: "memory:deprecated-inactive", text: "inactive rule", status: "deprecated" }))
      const search = await index.search("inactive rule", { includeInactive: true })
      expect(search.map((item) => item.id)).toContain("memory:active-inactive")
      expect(search.map((item) => item.id)).toContain("memory:quarantined-inactive")
      expect(search.map((item) => item.id)).toContain("memory:deprecated-inactive")
    })

    test("global confidence < 0.8 not returned by default", async () => {
      const { index } = await createIndex()
      await index.upsert(
        makeRecord({
          id: "memory:global-low",
          scope: "global",
          text: "dependency guidance",
          tags: ["dependency"],
          confidence: 0.79,
        }),
      )
      await index.upsert(
        makeRecord({
          id: "memory:global-high",
          scope: "global",
          text: "dependency guidance",
          tags: ["dependency"],
          confidence: 0.85,
        }),
      )
      const search = await index.search("dependency guidance")
      expect(search.map((item) => item.id)).not.toContain("memory:global-low")
      expect(search.map((item) => item.id)).toContain("memory:global-high")
    })

    test("scope filtering project/global", async () => {
      const { index } = await createIndex()
      await index.upsert(makeRecord({ id: "memory:scope-project", scope: "project", text: "scope check" }))
      await index.upsert(makeRecord({ id: "memory:scope-global", scope: "global", text: "scope check", confidence: 0.9 }))
      const project = await index.search("scope check", { scope: "project" })
      const global = await index.search("scope check", { scope: "global" })
      expect(project.length).toBe(1)
      expect(project[0]?.id).toBe("memory:scope-project")
      expect(global.length).toBe(1)
      expect(global[0]?.id).toBe("memory:scope-global")
    })

    test("kind filtering", async () => {
      const { index } = await createIndex()
      await index.upsert(makeRecord({ id: "memory:kind-workflow", kind: "workflow_rule", text: "kind filter" }))
      await index.upsert(makeRecord({ id: "memory:kind-decision", kind: "decision", text: "kind filter" }))
      const onlyWorkflow = await index.search("kind filter", { kind: "workflow_rule" })
      const both = await index.search("kind filter", { kind: ["workflow_rule", "decision"] })
      expect(onlyWorkflow.length).toBe(1)
      expect(onlyWorkflow[0]?.kind).toBe("workflow_rule")
      expect(both.length).toBe(2)
    })

    test("delete removes record", async () => {
      const { index } = await createIndex()
      await index.upsert(makeRecord({ id: "memory:delete-1", source_id: "src:delete-1" }))
      const removed = await index.delete("memory:delete-1")
      expect(removed).toBe(true)
      const listed = await index.list({ includeInactive: true })
      expect(listed.length).toBe(0)
    })

    test("stats returns counts by kind/scope/status", async () => {
      const { index } = await createIndex()
      await index.upsert(makeRecord({ id: "memory:stats-1", kind: "workflow_rule", scope: "project", status: "active" }))
      await index.upsert(makeRecord({ id: "memory:stats-2", kind: "decision", scope: "global", status: "active", confidence: 0.9 }))
      await index.upsert(makeRecord({ id: "memory:stats-3", kind: "lesson", scope: "project", status: "quarantined" }))
      const stats = await index.stats()
      expect(stats.total).toBe(3)
      expect(stats.active).toBe(2)
      expect(stats.by_scope.project).toBe(2)
      expect(stats.by_scope.global).toBe(1)
      expect(stats.by_kind.workflow_rule).toBe(1)
      expect(stats.by_kind.decision).toBe(1)
      expect(stats.by_status.quarantined).toBe(1)
    })

    test("corrupt JSONL does not crash if applicable", async () => {
      const { index, filePath } = await createIndex()
      if (!filePath) return
      const valid = makeRecord({ id: "memory:jsonl-valid", source_id: "src:jsonl-valid" })
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      await fs.writeFile(filePath, `${JSON.stringify(valid)}\n{bad json line\n`, "utf8")
      const listed = await index.list({ includeInactive: true })
      expect(listed.some((item) => item.id === "memory:jsonl-valid")).toBe(true)
    })

    test("search result ordering stable by score/confidence/updated_at", async () => {
      const { index } = await createIndex()
      await index.upsert(
        makeRecord({
          id: "memory:order-a",
          text: "alpha rule",
          tags: ["alpha"],
          confidence: 0.8,
          updated_at: iso(1000),
          created_at: iso(1000),
        }),
      )
      await index.upsert(
        makeRecord({
          id: "memory:order-b",
          text: "alpha rule",
          tags: ["alpha"],
          confidence: 0.9,
          updated_at: iso(500),
          created_at: iso(500),
        }),
      )
      await index.upsert(
        makeRecord({
          id: "memory:order-c",
          text: "alpha rule",
          tags: ["alpha"],
          confidence: 0.8,
          updated_at: iso(3000),
          created_at: iso(3000),
        }),
      )
      const search = await index.search("alpha rule", { includeInactive: true, limit: 10 })
      expect(search.map((item) => item.id).slice(0, 3)).toEqual(["memory:order-b", "memory:order-c", "memory:order-a"])
    })

    test("max results respected", async () => {
      const { index } = await createIndex()
      for (let i = 0; i < 8; i += 1) {
        await index.upsert(
          makeRecord({
            id: `memory:max-${i}`,
            text: `release verification ${i}`,
            tags: ["release", "verification"],
            confidence: 0.82,
            updated_at: iso(i * 1000),
            created_at: iso(i * 1000),
          }),
        )
      }
      const search = await index.search("release verification", { limit: 5 })
      expect(search.length).toBe(5)
    })
  })
}
