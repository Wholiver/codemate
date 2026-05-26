import { describe, expect, test } from "bun:test"
import * as LessonSchema from "@/session/lesson-schema"

describe("session.lesson-schema", () => {
  test("migrates legacy lesson to v2 in-memory", () => {
    const legacy = {
      id: "legacy-1",
      scope: "project",
      tags: ["build"],
      lesson: "Run bun typecheck after TypeScript changes.",
      detail: "Observed TS build failures after refactors",
      fix: "Add typecheck before final response",
      created_at: 1700000000000,
    }

    const migrated = LessonSchema.parseLessonRecord(legacy)
    expect(migrated).toBeDefined()
    if (!migrated) return
    expect(migrated.version).toBe(2)
    expect(migrated.summary).toBe("Run bun typecheck after TypeScript changes.")
    expect(migrated.status).toBe("active")
    expect(migrated.type).toBe("workflow_rule")
    expect(migrated.quality.source).toBe("legacy_migration")
    expect(migrated.quality.confidence).toBe(0.45)
  })

  test("parses v2 and keeps invalid status safe", () => {
    const parsed = LessonSchema.parseLessonRecord({
      version: 2,
      id: "v2-1",
      scope: "global",
      type: "research_insight",
      status: "invalid-status",
      summary: "Prefer official docs for SDK behavior.",
      tags: ["research"],
      applies_when: ["When SDK behavior is unclear"],
      do: ["Check official docs first"],
      dont: ["Assume stale behavior"],
      quality: { source: "research_quality_gate", confidence: 0.91, evidence: ["docs review"] },
      source: { tool: "writer" },
      created_at: "2026-05-18T00:00:00.000Z",
      updated_at: "2026-05-18T00:00:00.000Z",
      fingerprint: "",
    })

    expect(parsed).toBeDefined()
    if (!parsed) return
    expect(parsed.status).toBe("quarantined")
    expect(parsed.fingerprint.length).toBeGreaterThan(0)
  })

  test("formats injected lesson as structured reusable rule", () => {
    const record = LessonSchema.migrateLegacyLesson({
      scope: "project",
      lesson: "Use deterministic output formatting.",
      tags: ["format"],
    })
    const formatted = LessonSchema.formatLessonForInjection(record)

    expect(formatted).toContain("Summary:")
    expect(formatted).toContain("When:")
    expect(formatted).toContain("Do:")
    expect(formatted).toContain("Don't:")
    expect(formatted).toContain("Scope:")
  })

  test("quarantines generic advice lessons", () => {
    const record = LessonSchema.migrateLegacyLesson({
      scope: "project",
      lesson: "Be careful and verify your work before final response.",
      tags: ["general"],
    })
    const quality = LessonSchema.validateLessonQuality(record)
    expect(quality.status).toBe("quarantined")
    expect(quality.reasons).toContain("generic_advice")
  })

  test("detects changelog-style facts", () => {
    const record = LessonSchema.migrateLegacyLesson({
      scope: "project",
      lesson: "Created file src/new.ts and updated README.",
      tags: ["docs"],
    })
    expect(LessonSchema.looksLikeChangelogFact(record)).toBe(true)
    const quality = LessonSchema.validateLessonQuality(record)
    expect(quality.status).toBe("quarantined")
    expect(quality.reasons).toContain("changelog_fact")
  })

  test("keeps reusable lesson active when structure and evidence are good", () => {
    const now = "2026-05-18T00:00:00.000Z"
    const record = LessonSchema.parseLessonRecord({
      version: 2,
      id: "active-1",
      scope: "project",
      type: "workflow_rule",
      status: "active",
      summary: "Run package-level typecheck after TypeScript refactors.",
      tags: ["typecheck", "workflow"],
      applies_when: ["When TypeScript files changed"],
      do: ["Run bun typecheck in the package directory"],
      dont: ["Do not skip typecheck after large refactors"],
      quality: { source: "tester_confirmed", confidence: 0.9, evidence: ["tester pass"] },
      source: { tool: "lesson_write" },
      created_at: now,
      updated_at: now,
      fingerprint: "",
    })
    expect(record).toBeDefined()
    if (!record) return
    const quality = LessonSchema.validateLessonQuality(record)
    expect(quality.status).toBe("active")
  })

  test("quarantines global writer-summary low-confidence lesson", () => {
    const now = "2026-05-18T00:00:00.000Z"
    const record = LessonSchema.parseLessonRecord({
      version: 2,
      id: "global-low",
      scope: "global",
      type: "workflow_rule",
      status: "active",
      summary: "Use this project path /app/ssl for all cert tasks.",
      tags: ["workflow"],
      applies_when: [],
      do: ["Use /app/ssl directory"],
      dont: [],
      quality: { source: "writer_summary", confidence: 0.6, evidence: ["writer"] },
      source: { tool: "lesson_write" },
      created_at: now,
      updated_at: now,
      fingerprint: "",
    })
    expect(record).toBeDefined()
    if (!record) return
    const quality = LessonSchema.validateLessonQuality(record)
    expect(quality.status).toBe("quarantined")
    expect(quality.reasons).toContain("global_low_confidence")
    expect(quality.reasons).toContain("global_writer_summary_only")
    expect(quality.reasons).toContain("global_project_specific")
  })

  test("dedupe merges same fingerprint and keeps safer status", () => {
    const now = "2026-05-18T00:00:00.000Z"
    const existing = LessonSchema.parseLessonRecord({
      version: 2,
      id: "q1",
      scope: "project",
      type: "workflow_rule",
      status: "quarantined",
      summary: "Run package checks after edits.",
      tags: ["workflow"],
      applies_when: ["when ts files changed"],
      do: ["run bun typecheck"],
      dont: [],
      quality: { source: "writer_summary", confidence: 0.5, evidence: ["old evidence"] },
      source: { tool: "lesson_write" },
      created_at: now,
      updated_at: now,
      fingerprint: "fp|same|1",
    })
    const incoming = LessonSchema.parseLessonRecord({
      version: 2,
      id: "q2",
      scope: "project",
      type: "workflow_rule",
      status: "active",
      summary: "Run package checks after edits.",
      tags: ["workflow", "verification"],
      applies_when: ["when tests changed"],
      do: ["run bun test"],
      dont: ["skip checks"],
      quality: { source: "tester_confirmed", confidence: 0.9, evidence: ["new evidence"] },
      source: { tool: "lesson_write" },
      created_at: "2026-05-18T00:00:01.000Z",
      updated_at: "2026-05-18T00:00:01.000Z",
      fingerprint: "fp|same|1",
    })
    expect(existing).toBeDefined()
    expect(incoming).toBeDefined()
    if (!existing || !incoming) return
    const deduped = LessonSchema.dedupeLessonRecords([existing], incoming)
    expect(deduped.merged).toBe(true)
    expect(deduped.records.length).toBe(1)
    const merged = deduped.records[0]
    expect(merged.status).toBe("quarantined")
    expect(merged.tags).toContain("verification")
    expect(merged.quality.evidence).toContain("old evidence")
    expect(merged.quality.evidence).toContain("new evidence")
    expect(merged.created_at).toBe(now)
  })

  test("detects obvious do/dont conflict only in aligned context", () => {
    const now = "2026-05-18T00:00:00.000Z"
    const existing = LessonSchema.parseLessonRecord({
      version: 2,
      id: "active-existing",
      scope: "project",
      type: "workflow_rule",
      status: "active",
      summary: "Release workflow baseline.",
      tags: ["release", "workflow"],
      applies_when: ["when release branch is prepared"],
      do: ["use smoke checks only for release"],
      dont: ["must not run integration tests before release"],
      quality: { source: "tester_confirmed", confidence: 0.9, evidence: ["existing"] },
      source: { tool: "lesson_write" },
      created_at: now,
      updated_at: now,
      fingerprint: "conflict|existing",
    })
    const incoming = LessonSchema.parseLessonRecord({
      version: 2,
      id: "incoming",
      scope: "project",
      type: "workflow_rule",
      status: "active",
      summary: "Release workflow variant.",
      tags: ["release", "workflow"],
      applies_when: ["when release branch is prepared"],
      do: ["must run integration tests before release"],
      dont: ["no-op when release checks are pending"],
      quality: { source: "writer_summary", confidence: 0.8, evidence: ["incoming"] },
      source: { tool: "lesson_write" },
      created_at: now,
      updated_at: now,
      fingerprint: "conflict|incoming",
    })
    expect(existing).toBeDefined()
    expect(incoming).toBeDefined()
    if (!existing || !incoming) return
    const conflict = LessonSchema.detectLessonConflicts([existing], incoming)
    expect(conflict.conflicts_with).toContain("active-existing")
  })

  test("does not flag conflict for unrelated tags/applies", () => {
    const now = "2026-05-18T00:00:00.000Z"
    const existing = LessonSchema.parseLessonRecord({
      version: 2,
      id: "existing-docs",
      scope: "project",
      type: "workflow_rule",
      status: "active",
      summary: "Docs update rule.",
      tags: ["docs"],
      applies_when: ["when updating README"],
      do: ["update readme formatting"],
      dont: ["skip docs review"],
      quality: { source: "tester_confirmed", confidence: 0.9, evidence: ["existing"] },
      source: { tool: "lesson_write" },
      created_at: now,
      updated_at: now,
      fingerprint: "conflict|docs",
    })
    const incoming = LessonSchema.parseLessonRecord({
      version: 2,
      id: "incoming-build",
      scope: "project",
      type: "workflow_rule",
      status: "active",
      summary: "Build rule.",
      tags: ["build"],
      applies_when: ["when TypeScript build fails"],
      do: ["run bun typecheck"],
      dont: ["skip typecheck"],
      quality: { source: "writer_summary", confidence: 0.8, evidence: ["incoming"] },
      source: { tool: "lesson_write" },
      created_at: now,
      updated_at: now,
      fingerprint: "conflict|build",
    })
    expect(existing).toBeDefined()
    expect(incoming).toBeDefined()
    if (!existing || !incoming) return
    const conflict = LessonSchema.detectLessonConflicts([existing], incoming)
    expect(conflict.conflicts_with.length).toBe(0)
  })
})
