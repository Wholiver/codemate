import { describe, expect, test } from "bun:test"
import { InMemoryAgentMemoryIndex } from "@/session/agent-memory-index"
import type { LessonRecord } from "@/session/lesson-schema"
import {
  agentMemoryRecordToPatternRecord,
  buildPatternRecordsFromLessons,
  formatPatternsForPrompt,
  searchRelevantPatternsFromMemoryIndex,
  searchRelevantPatterns,
} from "@/session/pattern-retrieval"

const now = new Date().toISOString()

function makeLesson(input: Partial<LessonRecord> & Pick<LessonRecord, "id" | "summary">): LessonRecord {
  return {
    id: input.id,
    version: 2,
    scope: input.scope ?? "project",
    type: input.type ?? "workflow_rule",
    status: input.status ?? "active",
    summary: input.summary,
    tags: input.tags ?? ["workflow"],
    applies_when: input.applies_when ?? ["when task matches request"],
    do: input.do ?? [input.summary],
    dont: input.dont ?? ["do not skip verification"],
    quality: input.quality ?? { source: "tester_confirmed", confidence: 0.75, evidence: ["fixture"] },
    source: input.source ?? { tool: "legacy" },
    created_at: input.created_at ?? now,
    updated_at: input.updated_at ?? now,
    fingerprint: input.fingerprint ?? `${input.id}|fp`,
  }
}

describe("session.pattern-retrieval", () => {
  test("active project lesson relevant to request ranks high", () => {
    const records = buildPatternRecordsFromLessons([
      makeLesson({
        id: "p1",
        summary: "Use deterministic lockfile checks for release",
        tags: ["release", "lockfile", "coder"],
        applies_when: ["when release flow updates lockfile"],
        do: ["run bun typecheck and lockfile verification"],
      }),
    ])
    const patterns = searchRelevantPatterns({
      patterns: records,
      userText: "apply release lockfile update and verify",
      intentAnchor: "release lockfile policy",
      agentName: "coder",
    })
    expect(patterns.length).toBe(1)
    const text = formatPatternsForPrompt(patterns)
    expect(text).toContain("Relevant patterns for this task:")
    expect(text).toContain("Use deterministic lockfile checks for release")
  })

  test("quarantined and deprecated lessons are not injected", () => {
    const records = buildPatternRecordsFromLessons([
      makeLesson({
        id: "q1",
        status: "quarantined",
        summary: "quarantined lesson",
        tags: ["release"],
        applies_when: ["when release"],
      }),
      makeLesson({
        id: "d1",
        status: "deprecated",
        summary: "deprecated lesson",
        tags: ["release"],
        applies_when: ["when release"],
      }),
    ])
    const patterns = searchRelevantPatterns({
      patterns: records,
      userText: "release",
      agentName: "coder",
    })
    expect(patterns.length).toBe(0)
  })

  test("writer only receives project patterns while non-writer can receive global", () => {
    const records = buildPatternRecordsFromLessons([
      makeLesson({
        id: "p2",
        scope: "project",
        summary: "project rule for phase1",
        tags: ["phase1"],
        applies_when: ["when phase1 task"],
      }),
      makeLesson({
        id: "g2",
        scope: "global",
        summary: "global rule for phase1",
        tags: ["phase1"],
        applies_when: ["when phase1 task"],
        quality: { source: "reviewer_confirmed", confidence: 0.91, evidence: ["fixture"] },
      }),
    ])
    const writerPatterns = searchRelevantPatterns({
      patterns: records,
      userText: "run phase1 flow",
      agentName: "writer",
    })
    expect(writerPatterns.some((item) => item.scope === "global")).toBe(false)
    const coderPatterns = searchRelevantPatterns({
      patterns: records,
      userText: "run phase1 flow",
      agentName: "coder",
    })
    expect(coderPatterns.some((item) => item.scope === "global")).toBe(true)
  })

  test("global threshold filters low-confidence global and allows high-confidence global", () => {
    const records = buildPatternRecordsFromLessons([
      makeLesson({
        id: "g-low",
        scope: "global",
        summary: "low confidence global rule",
        tags: ["dependency"],
        applies_when: ["when dependency update"],
        quality: { source: "legacy_migration", confidence: 0.79, evidence: ["fixture"] },
      }),
      makeLesson({
        id: "g-high",
        scope: "global",
        summary: "high confidence global rule",
        tags: ["dependency"],
        applies_when: ["when dependency update"],
        quality: { source: "reviewer_confirmed", confidence: 0.85, evidence: ["fixture"] },
      }),
    ])
    const patterns = searchRelevantPatterns({
      patterns: records,
      userText: "dependency update",
      agentName: "coder",
    })
    expect(patterns.some((item) => item.id === "g-low")).toBe(false)
    expect(patterns.some((item) => item.id === "g-high")).toBe(true)
  })

  test("ranking favors project plus tag and applies overlap over generic lesson", () => {
    const records = buildPatternRecordsFromLessons([
      makeLesson({
        id: "generic",
        summary: "General workflow guidance",
        tags: ["workflow"],
        applies_when: ["when task exists"],
        quality: { source: "legacy_migration", confidence: 0.55, evidence: ["fixture"] },
      }),
      makeLesson({
        id: "specific",
        summary: "Use deterministic release verification",
        tags: ["release", "coder", "verification"],
        applies_when: ["when release verification is required"],
        do: ["run release verification command"],
        quality: { source: "tester_confirmed", confidence: 0.76, evidence: ["fixture"] },
      }),
    ])
    const patterns = searchRelevantPatterns({
      patterns: records,
      userText: "please perform release verification",
      intentAnchor: "release verification",
      agentName: "coder",
    })
    expect(patterns.at(0)?.id).toBe("specific")
  })

  test("no relevant pattern returns empty list", () => {
    const records = buildPatternRecordsFromLessons([
      makeLesson({
        id: "x1",
        summary: "certificate generation policy",
        tags: ["tls", "certificate"],
        applies_when: ["when generating tls cert"],
      }),
    ])
    const patterns = searchRelevantPatterns({
      patterns: records,
      userText: "database migration and query planner",
      agentName: "coder",
    })
    expect(patterns.length).toBe(0)
  })

  test("bad global no-op filter remains effective", () => {
    const records = buildPatternRecordsFromLessons([
      makeLesson({
        id: "g-noop",
        scope: "global",
        summary: "changed files no-op should not be injected",
        tags: ["persistence", "no-op"],
        applies_when: ["when changed files check runs"],
        do: ["changed files no-op"],
        quality: { source: "reviewer_confirmed", confidence: 0.9, evidence: ["fixture"] },
      }),
    ])
    const patterns = searchRelevantPatterns({
      patterns: records,
      userText: "changed files",
      agentName: "coder",
    })
    expect(patterns.length).toBe(0)
  })

  test("maxPatterns default is 5", () => {
    const records = buildPatternRecordsFromLessons(
      Array.from({ length: 8 }).map((_, index) =>
        makeLesson({
          id: `m${index}`,
          summary: `release verification rule ${index}`,
          tags: ["release", "verification"],
          applies_when: ["when release verification is required"],
          quality: { source: "tester_confirmed", confidence: 0.8, evidence: ["fixture"] },
        }),
      ),
    )
    const patterns = searchRelevantPatterns({
      patterns: records,
      userText: "release verification",
      agentName: "coder",
    })
    expect(patterns.length).toBe(5)
  })

  test("memory index lesson record converts to PatternRecord and injects", async () => {
    const index = new InMemoryAgentMemoryIndex({
      records: [
        {
          id: "memory:lesson-1",
          kind: "workflow_rule",
          scope: "project",
          text: "release lockfile verification memory",
          tags: ["release", "lockfile", "coder"],
          confidence: 0.9,
          status: "active",
          source_id: "lesson-1",
          source_path: ".codemate/lessons.jsonl",
          created_at: now,
          updated_at: now,
          metadata: {
            summary: "Use deterministic lockfile checks for release",
            applies_when: ["when release flow updates lockfile"],
            do: ["run bun typecheck and lockfile verification"],
            dont: ["do not skip lockfile validation"],
          },
        },
      ],
    })
    const patterns = await searchRelevantPatternsFromMemoryIndex(index, {
      userText: "apply release lockfile update and verify",
      intentAnchor: "release lockfile policy",
      agentName: "coder",
      maxPatterns: 5,
    })
    expect(patterns.length).toBe(1)
    const text = formatPatternsForPrompt(patterns)
    expect(text).toContain("Relevant patterns for this task:")
    expect(text).toContain("Use deterministic lockfile checks for release")
  })

  test("trajectory memory without reusable summary does not inject raw trajectory", async () => {
    const index = new InMemoryAgentMemoryIndex({
      records: [
        {
          id: "memory:trajectory-1",
          kind: "trajectory",
          scope: "project",
          text: "raw trajectory output details should not be injected",
          tags: ["trajectory", "tls", "coder"],
          confidence: 0.9,
          status: "active",
          source_path: ".codemate/trajectories.jsonl",
          created_at: now,
          updated_at: now,
          metadata: {
            outcome: "success",
            artifact_paths: ["~/app/ssl/server.crt"],
          },
        },
      ],
    })
    const patterns = await searchRelevantPatternsFromMemoryIndex(index, {
      userText: "tls certificate path verification",
      agentName: "coder",
      maxPatterns: 5,
    })
    expect(patterns.length).toBe(0)
  })

  test("failure_recovery memory with reusable summary injects as pattern", async () => {
    const index = new InMemoryAgentMemoryIndex({
      records: [
        {
          id: "memory:fr-1",
          kind: "failure_recovery",
          scope: "project",
          text: "failure recovery memory fallback",
          tags: ["failure_recovery", "tls", "tester"],
          confidence: 0.88,
          status: "active",
          source_id: "fr-1",
          created_at: now,
          updated_at: now,
          metadata: {
            summary: "Correct TLS path before rerunning tester checks",
            applies_when: ["when tester fails due to wrong TLS path"],
            do: ["fix path", "rerun tester"],
            dont: ["do not trust stale output paths"],
          },
        },
      ],
    })
    const patterns = await searchRelevantPatternsFromMemoryIndex(index, {
      userText: "tester failed because tls path mismatch",
      agentName: "coder",
      maxPatterns: 5,
    })
    expect(patterns.length).toBe(1)
    expect(patterns[0]?.kind).toBe("failure_recovery")
    expect(patterns[0]?.summary).toContain("Correct TLS path")
  })

  test("writer sees only project memory patterns", async () => {
    const index = new InMemoryAgentMemoryIndex({
      records: [
        {
          id: "memory:project-1",
          kind: "workflow_rule",
          scope: "project",
          text: "project writer rule",
          tags: ["phase1"],
          confidence: 0.82,
          status: "active",
          created_at: now,
          updated_at: now,
          metadata: { summary: "project writer rule", applies_when: ["when phase1 task"] },
        },
        {
          id: "memory:global-1",
          kind: "workflow_rule",
          scope: "global",
          text: "global writer rule",
          tags: ["phase1"],
          confidence: 0.92,
          status: "active",
          created_at: now,
          updated_at: now,
          metadata: { summary: "global writer rule", applies_when: ["when phase1 task"] },
        },
      ],
    })
    const writerPatterns = await searchRelevantPatternsFromMemoryIndex(index, {
      userText: "run phase1 flow",
      agentName: "writer",
      maxPatterns: 5,
    })
    expect(writerPatterns.some((item) => item.scope === "global")).toBe(false)
    const coderPatterns = await searchRelevantPatternsFromMemoryIndex(index, {
      userText: "run phase1 flow",
      agentName: "coder",
      maxPatterns: 5,
    })
    expect(coderPatterns.some((item) => item.scope === "global")).toBe(true)
  })

  test("memory index global confidence < 0.8 is filtered", async () => {
    const index = new InMemoryAgentMemoryIndex({
      records: [
        {
          id: "memory:g-low",
          kind: "workflow_rule",
          scope: "global",
          text: "low confidence global memory",
          tags: ["dependency"],
          confidence: 0.79,
          status: "active",
          created_at: now,
          updated_at: now,
          metadata: { summary: "low confidence global memory", applies_when: ["when dependency update"] },
        },
        {
          id: "memory:g-high",
          kind: "workflow_rule",
          scope: "global",
          text: "high confidence global memory",
          tags: ["dependency"],
          confidence: 0.86,
          status: "active",
          created_at: now,
          updated_at: now,
          metadata: { summary: "high confidence global memory", applies_when: ["when dependency update"] },
        },
      ],
    })
    const patterns = await searchRelevantPatternsFromMemoryIndex(index, {
      userText: "dependency update",
      agentName: "coder",
      maxPatterns: 5,
    })
    expect(patterns.some((item) => item.id === "memory:g-low")).toBe(false)
    expect(patterns.some((item) => item.id === "memory:g-high")).toBe(true)
  })

  test("fallback works when index has no relevant results", async () => {
    const index = new InMemoryAgentMemoryIndex({
      records: [
        {
          id: "memory:irrelevant",
          kind: "workflow_rule",
          scope: "project",
          text: "unrelated database migration rule",
          tags: ["database"],
          confidence: 0.9,
          status: "active",
          created_at: now,
          updated_at: now,
          metadata: { summary: "unrelated database migration rule", applies_when: ["when database migration"] },
        },
      ],
    })
    const fromIndex = await searchRelevantPatternsFromMemoryIndex(index, {
      userText: "release lockfile verification",
      agentName: "coder",
      maxPatterns: 5,
    })
    expect(fromIndex.length).toBe(0)

    const fallback = searchRelevantPatterns({
      patterns: buildPatternRecordsFromLessons([
        makeLesson({
          id: "fallback-lesson",
          summary: "Use deterministic lockfile checks for release",
          tags: ["release", "lockfile", "coder"],
          applies_when: ["when release flow updates lockfile"],
        }),
      ]),
      userText: "release lockfile verification",
      agentName: "coder",
      maxPatterns: 5,
    })
    expect(fallback.length).toBe(1)
  })

  test("memory behavior matches direct lessons retrieval for same lesson", async () => {
    const lesson = makeLesson({
      id: "parity-lesson",
      summary: "Use deterministic release verification",
      tags: ["release", "coder", "verification"],
      applies_when: ["when release verification is required"],
      do: ["run release verification command"],
      dont: ["do not skip verification"],
      quality: { source: "tester_confirmed", confidence: 0.84, evidence: ["fixture"] },
    })
    const direct = searchRelevantPatterns({
      patterns: buildPatternRecordsFromLessons([lesson]),
      userText: "please perform release verification",
      intentAnchor: "release verification",
      agentName: "coder",
      maxPatterns: 5,
    })
    const memoryRecord = {
      id: "memory:parity-lesson",
      kind: "workflow_rule" as const,
      scope: "project" as const,
      text: "memory text fallback",
      tags: lesson.tags,
      confidence: lesson.quality.confidence,
      status: lesson.status,
      source_id: lesson.id,
      source_path: ".codemate/lessons.jsonl",
      run_id: lesson.source.run_id,
      task_id: lesson.source.task_id,
      agent: lesson.source.agent,
      created_at: lesson.created_at,
      updated_at: lesson.updated_at,
      metadata: {
        summary: lesson.summary,
        applies_when: lesson.applies_when,
        do: lesson.do,
        dont: lesson.dont,
      },
    }
    const converted = agentMemoryRecordToPatternRecord(memoryRecord)
    expect(converted).toBeDefined()
    const index = new InMemoryAgentMemoryIndex({ records: [memoryRecord] })
    const fromMemory = await searchRelevantPatternsFromMemoryIndex(index, {
      userText: "please perform release verification",
      intentAnchor: "release verification",
      agentName: "coder",
      maxPatterns: 5,
    })
    expect(direct.length).toBe(1)
    expect(fromMemory.length).toBe(1)
    expect(fromMemory[0]?.summary).toBe(direct[0]?.summary)
  })

  test("memory index maxPatterns still works", async () => {
    const index = new InMemoryAgentMemoryIndex({
      records: Array.from({ length: 8 }).map((_, i) => ({
        id: `memory:max-${i}`,
        kind: "workflow_rule" as const,
        scope: "project" as const,
        text: `release verification memory ${i}`,
        tags: ["release", "verification"],
        confidence: 0.82,
        status: "active" as const,
        created_at: now,
        updated_at: now,
        metadata: {
          summary: `release verification memory ${i}`,
          applies_when: ["when release verification is required"],
        },
      })),
    })
    const patterns = await searchRelevantPatternsFromMemoryIndex(index, {
      userText: "release verification",
      agentName: "coder",
      maxPatterns: 5,
    })
    expect(patterns.length).toBe(5)
  })
})
