import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import type { FailureRecoveryCandidate } from "@/session/closed-loop"
import type { LessonRecord } from "@/session/lesson-schema"
import {
  InMemoryAgentMemoryIndex,
  JsonlAgentMemoryIndex,
  failureRecoveryCandidateToAgentMemory,
  lessonRecordToAgentMemory,
  pathProjectAgentMemoryIndex,
  trajectoryRecordToAgentMemory,
} from "@/session/agent-memory-index"
import { HybridAgentMemoryIndex } from "@/session/agent-memory-hybrid-index"
import { HnswAgentMemoryIndex } from "@/session/agent-memory-hnsw-index"
import { DeterministicEmbeddingProvider } from "@/session/embedding"
import { runAgentMemoryIndexContract } from "./agent-memory-index.contract"
import {
  syncProjectLessonsToMemoryIndex,
  syncProjectMemorySources,
  syncProjectTrajectoriesToMemoryIndex,
} from "@/session/agent-memory-sync"
import { appendTrajectoryRecord, createTrajectoryRecord, pathProjectTrajectories } from "@/session/trajectory"

const tmpDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    tmpDirs.splice(0, tmpDirs.length).map((dir) =>
      fs.rm(dir, { recursive: true, force: true }).catch(() => undefined),
    ),
  )
})

async function createProjectRoot() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codemate-agent-memory-"))
  tmpDirs.push(dir)
  return dir
}

async function writeProjectLessonsFile(projectRoot: string, lines: string[]) {
  const filePath = path.join(projectRoot, ".codemate", "lessons.jsonl")
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, `${lines.join("\n")}\n`, "utf8")
  return filePath
}

runAgentMemoryIndexContract("in-memory", async () => ({
  index: new InMemoryAgentMemoryIndex(),
}))

runAgentMemoryIndexContract("jsonl", async () => {
  const projectRoot = await createProjectRoot()
  return {
    index: new JsonlAgentMemoryIndex({ projectRoot }),
    filePath: pathProjectAgentMemoryIndex(projectRoot),
  }
})

runAgentMemoryIndexContract("hybrid+in-memory", async () => ({
  index: new HybridAgentMemoryIndex(new InMemoryAgentMemoryIndex(), new DeterministicEmbeddingProvider({ dimensions: 24 })),
}))

runAgentMemoryIndexContract("hybrid+jsonl", async () => {
  const projectRoot = await createProjectRoot()
  return {
    index: new HybridAgentMemoryIndex(
      new JsonlAgentMemoryIndex({ projectRoot }),
      new DeterministicEmbeddingProvider({ dimensions: 24 }),
    ),
    filePath: pathProjectAgentMemoryIndex(projectRoot),
  }
})

runAgentMemoryIndexContract("hnsw+in-memory", async () => ({
  index: new HnswAgentMemoryIndex(
    new InMemoryAgentMemoryIndex(),
    new DeterministicEmbeddingProvider({ dimensions: 24 }),
    { hnswEnabled: true },
  ),
}))

runAgentMemoryIndexContract("hnsw+jsonl", async () => {
  const projectRoot = await createProjectRoot()
  return {
    index: new HnswAgentMemoryIndex(
      new JsonlAgentMemoryIndex({ projectRoot }),
      new DeterministicEmbeddingProvider({ dimensions: 24 }),
      { hnswEnabled: true },
    ),
    filePath: pathProjectAgentMemoryIndex(projectRoot),
  }
})

const now = new Date().toISOString()

function makeLesson(input?: Partial<LessonRecord>): LessonRecord {
  return {
    id: input?.id ?? "lesson-1",
    version: 2,
    scope: input?.scope ?? "project",
    type: input?.type ?? "workflow_rule",
    status: input?.status ?? "active",
    summary: input?.summary ?? "Use deterministic release verification",
    tags: input?.tags ?? ["release", "verification"],
    applies_when: input?.applies_when ?? ["when release flow modifies lockfile"],
    do: input?.do ?? ["run bun typecheck"],
    dont: input?.dont ?? ["do not skip verification"],
    quality: input?.quality ?? { source: "tester_confirmed", confidence: 0.84, evidence: ["fixture"] },
    source: input?.source ?? { run_id: "run-lesson", task_id: "writer_lesson", agent: "writer", tool: "lesson_write" },
    created_at: input?.created_at ?? now,
    updated_at: input?.updated_at ?? now,
    fingerprint: input?.fingerprint ?? "lesson|workflow|release",
    avoid_when: input?.avoid_when,
    trajectory: input?.trajectory,
    conflicts_with: input?.conflicts_with,
    supersedes: input?.supersedes,
  }
}

describe("session.agent-memory-index", () => {
  test("lesson converter maps LessonRecord to AgentMemoryRecord", () => {
    const lesson = makeLesson({
      id: "lesson-workflow-1",
      type: "workflow_rule",
      scope: "project",
      status: "active",
    })
    const memory = lessonRecordToAgentMemory(lesson)

    expect(memory.id).toBe("memory:lesson-workflow-1")
    expect(memory.kind).toBe("workflow_rule")
    expect(memory.scope).toBe("project")
    expect(memory.status).toBe("active")
    expect(memory.source_path).toBe(".codemate/lessons.jsonl")
    expect(memory.run_id).toBe("run-lesson")
    expect(memory.task_id).toBe("writer_lesson")
    expect(memory.agent).toBe("writer")
    expect(memory.text).toContain("Use deterministic release verification")
  })

  test("trajectory converter maps and redacts sensitive trajectory content", () => {
    const trajectory = createTrajectoryRecord({
      run_id: "run-traj",
      task_id: "coder_tls",
      agent: "coder",
      action_summary: "handle TLS failure and recovery",
      expected_outputs: ["~/app/ssl/server.crt"],
      actual_outputs: [
        "-----BEGIN PRIVATE KEY-----\\nMIIEvwIBADANBgkqhkiG9w0BAQEFAASCB...\\n-----END PRIVATE KEY-----",
        "Authorization: Bearer sk-very-secret-token",
      ],
      artifact_paths: ["~/app/ssl/server.key", "~/app/ssl/server.crt"],
      commands_run: ["openssl req -x509 -newkey rsa:2048 -keyout ~/app/ssl/server.key"],
      verification_results: ["subject=CN=dev.local", "fingerprint=AA:BB:CC"],
      tool_results: [],
      outcome: "recovered",
      quality_signals: { tester_passed: true, command_success: true },
      failure: { signal: "wrong path first" },
      recovery: { repair_action: "fix path and retry", success_signal: "tester passed" },
    })

    const memory = trajectoryRecordToAgentMemory(trajectory)
    expect(memory.kind).toBe("failure_recovery")
    expect(memory.source_path).toBe(".codemate/trajectories.jsonl")
    expect(memory.text).not.toContain("BEGIN PRIVATE KEY")
    expect(memory.text).not.toContain("sk-very-secret-token")
    expect(JSON.stringify(memory.metadata)).not.toContain("BEGIN PRIVATE KEY")
    expect(JSON.stringify(memory.metadata)).toContain("subject=CN=dev.local")
  })

  test("failure recovery converter maps candidate", () => {
    const candidate: FailureRecoveryCandidate = {
      id: "fr-1",
      run_id: "run-fr",
      task_id: "tester_tls",
      failed_stage: "tester",
      failed_agent: "tester",
      failure_signal: "tls path mismatch",
      repair_action: "correct path",
      success_signal: "tests passed",
      evidence_refs: ["wrong path -> corrected path"],
      created_at: now,
      intent_anchor: "fix tls flow",
    }
    const memory = failureRecoveryCandidateToAgentMemory(candidate)
    expect(memory.kind).toBe("failure_recovery")
    expect(memory.scope).toBe("project")
    expect(memory.run_id).toBe("run-fr")
    expect(memory.agent).toBe("tester")
    expect(memory.text).toContain("Failure signal")
  })

  test("in-memory index supports upsert/list/search/delete/stats", async () => {
    const index = new InMemoryAgentMemoryIndex()
    const lesson = lessonRecordToAgentMemory(makeLesson({ id: "lesson-a", summary: "release verification" }))
    const trajectory = trajectoryRecordToAgentMemory(
      createTrajectoryRecord({
        run_id: "run-a",
        task_id: "coder-a",
        agent: "coder",
        action_summary: "fix release script",
        expected_outputs: [],
        actual_outputs: ["release script fixed"],
        artifact_paths: ["scripts/release.ts"],
        commands_run: ["bun typecheck"],
        verification_results: ["passed"],
        tool_results: [],
        outcome: "success",
        quality_signals: { command_success: true },
      }),
    )
    await index.upsert(lesson)
    await index.upsert(trajectory)

    const listed = await index.list()
    expect(listed.length).toBe(2)

    const searched = await index.search("release verification")
    expect(searched.length).toBeGreaterThan(0)
    expect(searched.some((item) => item.id === lesson.id)).toBe(true)

    const stats = await index.stats()
    expect(stats.total).toBe(2)
    expect(stats.by_kind.workflow_rule + stats.by_kind.trajectory + stats.by_kind.failure_recovery).toBeGreaterThan(0)

    const removed = await index.delete(trajectory.id)
    expect(removed).toBe(true)
    const afterDelete = await index.list()
    expect(afterDelete.length).toBe(1)
  })

  test("project/global scope filtering and global confidence threshold", async () => {
    const index = new InMemoryAgentMemoryIndex()
    await index.upsert({
      id: "project-active",
      kind: "lesson",
      scope: "project",
      text: "project tls rule",
      tags: ["tls", "project"],
      confidence: 0.6,
      status: "active",
      source_path: ".codemate/lessons.jsonl",
      created_at: now,
      updated_at: now,
      metadata: {},
    })
    await index.upsert({
      id: "global-low",
      kind: "lesson",
      scope: "global",
      text: "global tls low confidence rule",
      tags: ["tls", "global"],
      confidence: 0.79,
      status: "active",
      created_at: now,
      updated_at: now,
      metadata: {},
    })
    await index.upsert({
      id: "global-high",
      kind: "lesson",
      scope: "global",
      text: "global tls high confidence rule",
      tags: ["tls", "global"],
      confidence: 0.9,
      status: "active",
      created_at: now,
      updated_at: now,
      metadata: {},
    })

    const searchAll = await index.search("tls")
    expect(searchAll.map((item) => item.id)).toContain("project-active")
    expect(searchAll.map((item) => item.id)).toContain("global-high")
    expect(searchAll.map((item) => item.id)).not.toContain("global-low")

    const searchGlobalOnly = await index.search("tls", { scope: "global" })
    expect(searchGlobalOnly.length).toBe(1)
    expect(searchGlobalOnly[0]?.id).toBe("global-high")
  })

  test("search is active-only by default and includeInactive can override", async () => {
    const index = new InMemoryAgentMemoryIndex()
    await index.upsert({
      id: "active-1",
      kind: "lesson",
      scope: "project",
      text: "tls active guidance",
      tags: ["tls"],
      confidence: 0.9,
      status: "active",
      created_at: now,
      updated_at: now,
      metadata: {},
    })
    await index.upsert({
      id: "quarantine-1",
      kind: "lesson",
      scope: "project",
      text: "tls quarantined guidance",
      tags: ["tls"],
      confidence: 0.95,
      status: "quarantined",
      created_at: now,
      updated_at: now,
      metadata: {},
    })

    const defaultSearch = await index.search("tls")
    expect(defaultSearch.map((item) => item.id)).toContain("active-1")
    expect(defaultSearch.map((item) => item.id)).not.toContain("quarantine-1")

    const includeInactiveSearch = await index.search("tls", { includeInactive: true })
    expect(includeInactiveSearch.map((item) => item.id)).toContain("quarantine-1")
  })

  test("jsonl backend persists upsert/list/search/delete/stats", async () => {
    const projectRoot = await createProjectRoot()
    const index = new JsonlAgentMemoryIndex({ projectRoot })

    await index.upsert({
      id: "jsonl-1",
      kind: "workflow_rule",
      scope: "project",
      text: "verify lockfile in release",
      tags: ["release", "lockfile"],
      confidence: 0.88,
      status: "active",
      source_path: ".codemate/lessons.jsonl",
      created_at: now,
      updated_at: now,
      metadata: { source: "test" },
    })

    const file = Bun.file(pathProjectAgentMemoryIndex(projectRoot))
    expect(await file.exists()).toBe(true)

    const listed = await index.list()
    expect(listed.length).toBe(1)

    const searched = await index.search("lockfile")
    expect(searched.length).toBe(1)
    expect(searched[0]?.id).toBe("jsonl-1")

    const stats = await index.stats()
    expect(stats.total).toBe(1)
    expect(stats.by_kind.workflow_rule).toBe(1)

    const removed = await index.delete("jsonl-1")
    expect(removed).toBe(true)
    expect((await index.list()).length).toBe(0)
  })

  test("sync lessons -> index searchable", async () => {
    const projectRoot = await createProjectRoot()
    const v2 = makeLesson({
      id: "sync-lesson-v2",
      summary: "Project TLS path verification rule",
      scope: "project",
      type: "workflow_rule",
      status: "active",
      tags: ["tls", "path", "verification"],
    })
    const v1 = {
      id: "sync-lesson-v1",
      scope: "project",
      tags: ["legacy", "tls"],
      stack: [],
      fingerprint: "legacy|tls",
      lesson: "Legacy TLS rule",
      detail: "legacy detail",
      fix: "legacy fix",
      created_at: Date.now(),
    }
    await writeProjectLessonsFile(projectRoot, [JSON.stringify(v2), JSON.stringify(v1)])

    const index = new InMemoryAgentMemoryIndex()
    const synced = await syncProjectLessonsToMemoryIndex(projectRoot, index)
    expect(synced.read).toBe(2)
    expect(synced.upserted).toBe(2)
    expect(synced.warnings.length).toBe(0)

    const search = await index.search("TLS verification")
    expect(search.length).toBeGreaterThan(0)
    expect(search.some((item) => item.source_id === "sync-lesson-v2")).toBe(true)
    expect(search.some((item) => item.source_id === "sync-lesson-v1")).toBe(true)
  })

  test("sync trajectories -> index searchable", async () => {
    const projectRoot = await createProjectRoot()
    await appendTrajectoryRecord(
      projectRoot,
      createTrajectoryRecord({
        run_id: "run-sync-traj",
        task_id: "coder_tls_path",
        agent: "coder",
        action_summary: "Fix TLS path and rerun verification",
        expected_outputs: ["~/app/ssl/server.crt"],
        actual_outputs: ["corrected tls path and reran checks"],
        artifact_paths: ["~/app/ssl/server.crt"],
        commands_run: ["python ~/app/check_cert.py"],
        verification_results: ["verification passed"],
        tool_results: [],
        outcome: "recovered",
        quality_signals: { tester_passed: true, command_success: true },
      }),
    )

    const index = new InMemoryAgentMemoryIndex()
    const synced = await syncProjectTrajectoriesToMemoryIndex(projectRoot, index)
    expect(synced.read).toBe(1)
    expect(synced.upserted).toBe(1)

    const search = await index.search("TLS path verification")
    expect(search.length).toBe(1)
    expect(search[0]?.source_path).toBe(".codemate/trajectories.jsonl")
  })

  test("duplicate sync does not duplicate records and keeps newer updated_at", async () => {
    const projectRoot = await createProjectRoot()
    const older = "2026-01-01T00:00:00.000Z"
    const newer = "2026-03-01T00:00:00.000Z"
    await writeProjectLessonsFile(projectRoot, [
      JSON.stringify(
        makeLesson({
          id: "dup-lesson",
          summary: "new lesson text",
          updated_at: newer,
          created_at: older,
        }),
      ),
    ])
    const index = new InMemoryAgentMemoryIndex()
    const first = await syncProjectLessonsToMemoryIndex(projectRoot, index)
    expect(first.upserted).toBe(1)
    expect((await index.list({ includeInactive: true })).length).toBe(1)

    await writeProjectLessonsFile(projectRoot, [
      JSON.stringify(
        makeLesson({
          id: "dup-lesson",
          summary: "older lesson text should not override",
          updated_at: older,
          created_at: older,
        }),
      ),
    ])
    const second = await syncProjectLessonsToMemoryIndex(projectRoot, index)
    expect((await index.list({ includeInactive: true })).length).toBe(1)
    expect(second.skipped).toBeGreaterThan(0)
    const stored = (await index.list({ includeInactive: true }))[0]
    expect(stored?.updated_at).toBe(newer)
    expect(stored?.text).toContain("new lesson text")
    expect(stored?.text).not.toContain("older lesson text should not override")
  })

  test("quarantined lesson indexed but not returned by default search", async () => {
    const projectRoot = await createProjectRoot()
    await writeProjectLessonsFile(projectRoot, [
      JSON.stringify(
        makeLesson({
          id: "lesson-quarantine-sync",
          summary: "TLS quarantine sync",
          status: "quarantined",
          tags: ["tls", "quarantine"],
        }),
      ),
    ])
    const index = new InMemoryAgentMemoryIndex()
    await syncProjectLessonsToMemoryIndex(projectRoot, index)

    const all = await index.list({ includeInactive: true })
    expect(all.some((item) => item.source_id === "lesson-quarantine-sync")).toBe(true)

    const defaultSearch = await index.search("TLS quarantine sync")
    expect(defaultSearch.some((item) => item.source_id === "lesson-quarantine-sync")).toBe(false)

    const includeInactive = await index.search("TLS quarantine sync", { includeInactive: true })
    expect(includeInactive.some((item) => item.source_id === "lesson-quarantine-sync")).toBe(true)
  })

  test("corrupt lessons/trajectories lines do not crash sync", async () => {
    const projectRoot = await createProjectRoot()
    await writeProjectLessonsFile(projectRoot, [
      JSON.stringify(makeLesson({ id: "ok-lesson", summary: "ok lesson" })),
      "{bad lesson json line",
    ])
    const trajectoryFile = pathProjectTrajectories(projectRoot)
    await fs.mkdir(path.dirname(trajectoryFile), { recursive: true })
    await fs.writeFile(
      trajectoryFile,
      [
        JSON.stringify(
          createTrajectoryRecord({
            run_id: "run-ok",
            task_id: "task-ok",
            agent: "coder",
            action_summary: "ok trajectory",
            expected_outputs: [],
            actual_outputs: ["ok"],
            artifact_paths: [],
            commands_run: [],
            verification_results: [],
            tool_results: [],
            outcome: "success",
            quality_signals: {},
          }),
        ),
        "{bad trajectory json line",
      ].join("\n"),
      "utf8",
    )

    const index = new InMemoryAgentMemoryIndex()
    const result = await syncProjectMemorySources(projectRoot, index)
    expect(result.warnings.length).toBeGreaterThan(0)
    expect(result.upserted).toBeGreaterThan(0)
  })

  test("stats reflect kind/scope counts after sync", async () => {
    const projectRoot = await createProjectRoot()
    await writeProjectLessonsFile(projectRoot, [
      JSON.stringify(makeLesson({ id: "stats-workflow", type: "workflow_rule", scope: "project" })),
      JSON.stringify(makeLesson({ id: "stats-convention", type: "project_convention", scope: "project" })),
    ])
    await appendTrajectoryRecord(
      projectRoot,
      createTrajectoryRecord({
        run_id: "run-stats",
        task_id: "task-stats",
        agent: "tester",
        action_summary: "trajectory stats",
        expected_outputs: [],
        actual_outputs: ["stats output"],
        artifact_paths: [],
        commands_run: [],
        verification_results: ["passed"],
        tool_results: [],
        outcome: "success",
        quality_signals: { tester_passed: true },
      }),
    )

    const index = new InMemoryAgentMemoryIndex()
    const result = await syncProjectMemorySources(projectRoot, index)
    expect(result.upserted).toBe(3)
    const stats = await index.stats()
    expect(stats.total).toBe(3)
    expect(stats.by_scope.project).toBe(3)
    expect(stats.by_kind.workflow_rule).toBeGreaterThan(0)
    expect(stats.by_kind.project_convention).toBeGreaterThan(0)
    expect(stats.by_kind.trajectory + stats.by_kind.failure_recovery).toBeGreaterThan(0)
  })

  test("hybrid index upsert writes embedding metadata", async () => {
    const base = new InMemoryAgentMemoryIndex()
    const hybrid = new HybridAgentMemoryIndex(base, new DeterministicEmbeddingProvider({ dimensions: 32 }))
    await hybrid.upsert({
      id: "hybrid-upsert-1",
      kind: "workflow_rule",
      scope: "project",
      text: "Use deterministic lockfile checks for release",
      tags: ["release", "lockfile"],
      confidence: 0.86,
      status: "active",
      created_at: now,
      updated_at: now,
      metadata: { summary: "release lockfile checks" },
    })
    const stored = (await base.list({ includeInactive: true }))[0]
    expect(stored?.embedding?.vector.length).toBe(32)
    expect(stored?.embedding?.provider).toBe("deterministic-test")
    expect(stored?.embedding?.dimensions).toBe(32)
  })

  test("hybrid search reranks with semantic similarity over keyword tie", async () => {
    const base = new InMemoryAgentMemoryIndex()
    const provider = new DeterministicEmbeddingProvider({ dimensions: 32 })
    const hybrid = new HybridAgentMemoryIndex(base, provider, {
      keywordWeight: 0.25,
      semanticWeight: 0.75,
    })
    await hybrid.upsert({
      id: "hybrid-semantic-1",
      kind: "workflow_rule",
      scope: "project",
      text: "Fix TLS certificate path mismatch and rerun verification script",
      tags: ["tls", "cert"],
      confidence: 0.82,
      status: "active",
      created_at: now,
      updated_at: "2026-01-01T00:00:00.000Z",
      metadata: { summary: "TLS path recovery workflow" },
    })
    await hybrid.upsert({
      id: "hybrid-semantic-2",
      kind: "workflow_rule",
      scope: "project",
      text: "Optimize database query planner and tune index hint usage",
      tags: ["tls", "cert"],
      confidence: 0.82,
      status: "active",
      created_at: now,
      updated_at: "2026-01-02T00:00:00.000Z",
      metadata: { summary: "DB optimization workflow" },
    })
    const search = await hybrid.search("TLS certificate verification path", { limit: 2 })
    expect(search.length).toBe(2)
    expect(search[0]?.id).toBe("hybrid-semantic-1")
  })

  test("hybrid search gracefully falls back when embedding provider fails", async () => {
    const base = new InMemoryAgentMemoryIndex()
    await base.upsert({
      id: "hybrid-fallback-1",
      kind: "workflow_rule",
      scope: "project",
      text: "release check guidance",
      tags: ["release"],
      confidence: 0.9,
      status: "active",
      created_at: now,
      updated_at: "2026-02-01T00:00:00.000Z",
      metadata: {},
    })
    await base.upsert({
      id: "hybrid-fallback-2",
      kind: "workflow_rule",
      scope: "project",
      text: "release check guidance",
      tags: ["release"],
      confidence: 0.8,
      status: "active",
      created_at: now,
      updated_at: "2026-03-01T00:00:00.000Z",
      metadata: {},
    })
    const failingProvider = {
      providerName: "failing-test",
      dimensions: 16,
      embedText: async () => Promise.reject(new Error("failed")),
      embedBatch: async () => Promise.reject(new Error("failed")),
    }
    const hybrid = new HybridAgentMemoryIndex(base, failingProvider)
    const keywordOnly = await base.search("release check guidance", { limit: 2 })
    const hybridSearch = await hybrid.search("release check guidance", { limit: 2 })
    expect(hybridSearch.map((item) => item.id)).toEqual(keywordOnly.map((item) => item.id))
  })
})
