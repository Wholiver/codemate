import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "fs/promises"
import path from "path"
import { formatMemoryReminder } from "@/memory/formatter"
import { LegacySupermemoryAdapter } from "@/memory/adapters/legacy-supermemory"
import { MemoryRuntime } from "@/memory/runtime"
import type { MemoryRecord } from "@/memory/types"
import { tmpdir } from "../fixture/fixture"

async function readJsonl(filePath: string) {
  const file = Bun.file(filePath)
  if (!(await file.exists())) return [] as MemoryRecord[]
  return (await file.text())
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as MemoryRecord)
}

describe("memory runtime basics", () => {
  test("LegacySupermemoryAdapter converts legacy supermemory records", async () => {
    await using tmp = await tmpdir()
    const dataDir = path.join(tmp.path, "data")
    const legacyPath = path.join(dataDir, "storage", "supermemory", "records.json")
    await mkdir(path.dirname(legacyPath), { recursive: true })
    await writeFile(
      legacyPath,
      JSON.stringify([
        {
          id: "m1",
          content: "I prefer JSON output",
          scope: "user",
          tags: ["format"],
          created_at: 1000,
        },
        {
          id: "m2",
          content: "You must never change lockfile by default",
          scope: "project",
          tags: ["safety"],
          created_at: 2000,
          project_id: "proj-a",
        },
      ]),
    )

    const adapter = new LegacySupermemoryAdapter({ dataDir })
    const records = await adapter.list()
    expect(records).toHaveLength(2)
    expect(records[0]?.id.startsWith("legacy-supermemory:")).toBe(true)
    expect(records[0]?.quality.source).toBe("imported")
    expect(records.find((item) => item.id === "legacy-supermemory:m1")?.kind).toBe("preference")
    expect(records.find((item) => item.id === "legacy-supermemory:m2")?.kind).toBe("rule")
  })

  test("MemoryRuntime.beforeAgentCall recalls legacy supermemory records", async () => {
    await using tmp = await tmpdir()
    const projectRoot = path.join(tmp.path, "project")
    const dataDir = path.join(tmp.path, "data")
    const legacyPath = path.join(dataDir, "storage", "supermemory", "records.json")
    await mkdir(path.dirname(legacyPath), { recursive: true })
    await mkdir(projectRoot, { recursive: true })
    await writeFile(
      legacyPath,
      JSON.stringify([
        {
          id: "m1",
          content: "Remember to default to JSON output format",
          scope: "user",
          tags: ["json"],
          created_at: Date.now(),
        },
      ]),
    )

    const runtime = new MemoryRuntime({ projectRoot, dataDir })
    const pack = await runtime.beforeAgentCall({
      agent: "orchestrator",
      attribution: { project_id: "proj-a", project_root: projectRoot, session_id: "ses-1" },
      query: "default to JSON output format",
    })

    expect(pack.records).toHaveLength(1)
    expect(pack.records[0]?.id.startsWith("legacy-supermemory:")).toBe(true)
    expect(pack.reminder).toContain("Relevant memory:")
  })

  test("rememberUserInstruction writes new MemoryRecord JSONL", async () => {
    await using tmp = await tmpdir()
    const projectRoot = path.join(tmp.path, "project")
    const dataDir = path.join(tmp.path, "data")
    await mkdir(projectRoot, { recursive: true })

    const runtime = new MemoryRuntime({ projectRoot, dataDir })
    const record = await runtime.rememberUserInstruction({
      text: "Please remember: prefer deterministic JSON output.",
      scope: "project",
      attribution: { project_id: "proj-a", project_root: projectRoot, session_id: "ses-1" },
    })

    const stored = await readJsonl(path.join(projectRoot, ".codemate", "memory", "records.jsonl"))
    expect(stored).toHaveLength(1)
    expect(stored[0]?.id).toBe(record.id)
    expect(stored[0]?.quality.source).toBe("user_stated")
    expect(stored[0]?.kind).toBe("preference")
  })

  test("project memory with different project_id is not recalled", async () => {
    await using tmp = await tmpdir()
    const projectRoot = path.join(tmp.path, "project")
    const dataDir = path.join(tmp.path, "data")
    await mkdir(projectRoot, { recursive: true })
    const runtime = new MemoryRuntime({ projectRoot, dataDir })

    await runtime.rememberUserInstruction({
      text: "Must keep CI deterministic",
      scope: "project",
      attribution: { project_id: "proj-a", project_root: projectRoot, session_id: "ses-1" },
    })

    const recalled = await runtime.beforeAgentCall({
      agent: "coder",
      attribution: { project_id: "proj-b", project_root: projectRoot, session_id: "ses-2" },
      query: "deterministic CI",
    })
    expect(recalled.records).toEqual([])
  })

  test("formatMemoryReminder only outputs memory reminder text", () => {
    const output = formatMemoryReminder([
      {
        id: "m1",
        kind: "fact",
        scope: "project",
        content: { summary: "Keep output deterministic" },
        tags: ["deterministic"],
        attribution: { project_id: "proj-a" },
        quality: { confidence: 0.9, source: "user_stated" },
        lifecycle: { status: "active", created_at: 1, updated_at: 1, use_count: 0 },
        fingerprint: "fp",
      },
    ])
    expect(output).toContain("<system-reminder>")
    expect(output).toContain("- [fact][project] Keep output deterministic")
    expect(output.toLowerCase()).not.toContain("lessons")
    expect(output.toLowerCase()).not.toContain("changelog")
  })

  test("forget without id/query does not clear all memory", async () => {
    await using tmp = await tmpdir()
    const projectRoot = path.join(tmp.path, "project")
    const dataDir = path.join(tmp.path, "data")
    await mkdir(projectRoot, { recursive: true })
    const runtime = new MemoryRuntime({ projectRoot, dataDir })

    await runtime.rememberUserInstruction({
      text: "Remember this instruction",
      scope: "user",
      attribution: { session_id: "ses-1" },
    })
    const before = await runtime.list()
    const result = await runtime.forget({})
    const after = await runtime.list()

    expect(result.removed).toBe(0)
    expect(result.no_op).toBe(true)
    expect(before.length).toBe(1)
    expect(after.length).toBe(1)
  })
})

