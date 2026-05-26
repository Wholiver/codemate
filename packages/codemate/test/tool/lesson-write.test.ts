import { afterEach, describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { ToolRegistry } from "@/tool/registry"
import type { Tool } from "@/tool/tool"
import { SessionID, MessageID } from "@/session/schema"
import { TestInstance, disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(ToolRegistry.defaultLayer)

const baseCtx: Omit<Tool.Context, "ask"> = {
  sessionID: SessionID.make("ses_lesson_write"),
  messageID: MessageID.make("msg_lesson_write"),
  callID: "",
  agent: "writer",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
}

const getTool = Effect.fn("LessonWriteTest.getTool")(function* () {
  const registry = yield* ToolRegistry.Service
  const tool = (yield* registry.all()).find((item) => item.id === "lesson_write")
  expect(tool).toBeDefined()
  if (!tool) throw new Error("lesson_write tool not found")
  return tool
})

const getClassifyTool = Effect.fn("LessonWriteTest.getClassifyTool")(function* () {
  const registry = yield* ToolRegistry.Service
  const tool = (yield* registry.all()).find((item) => item.id === "lesson_classify")
  expect(tool).toBeDefined()
  if (!tool) throw new Error("lesson_classify tool not found")
  return tool
})

afterEach(async () => {
  await disposeAllInstances()
})

describe("tool.lesson_write", () => {
  it.instance("writes v2 lesson records to project lessons jsonl", () =>
    Effect.gen(function* () {
      const tool = yield* getTool()
      const instance = yield* TestInstance
      const asks: Array<{ permission: string }> = []
      const ctx: Tool.Context = {
        ...baseCtx,
        ask: (req) =>
          Effect.sync(() => {
            asks.push({ permission: req.permission })
          }),
      }

      const result = yield* tool.execute(
        {
          scope: "project",
          tags: ["build", "typecheck"],
          lesson: "Run bun typecheck before final response.",
          detail: "Type errors escaped earlier rounds.",
          fix: "Always run package-local typecheck after code edits.",
        },
        ctx,
      )

      expect(result.title).toBe("Lesson written")
      const file = path.join(instance.directory, ".codemate", "lessons.jsonl")
      const text = yield* Effect.promise(() => fs.readFile(file, "utf8"))
      const line = text.trim().split("\n").at(-1)
      expect(line).toBeDefined()
      if (!line) return
      const parsed = JSON.parse(line) as Record<string, unknown>

      expect(parsed["version"]).toBe(2)
      expect(parsed["scope"]).toBe("project")
      expect(parsed["summary"]).toBe("Run bun typecheck before final response.")
      expect(parsed["status"]).toBe("active")
      expect(parsed["quality"]).toBeDefined()
      expect((parsed["quality"] as Record<string, unknown>)["source"]).toBe("writer_summary")
      expect(typeof parsed["created_at"]).toBe("string")
      expect(typeof parsed["updated_at"]).toBe("string")
      expect(typeof parsed["fingerprint"]).toBe("string")
      expect(asks.some((item) => item.permission === "lesson_write")).toBe(true)
    }),
  )

  it.instance("quarantines generic low-quality lesson instead of failing write", () =>
    Effect.gen(function* () {
      const tool = yield* getTool()
      const instance = yield* TestInstance
      const ctx: Tool.Context = {
        ...baseCtx,
        ask: () => Effect.void,
      }

      const result = yield* tool.execute(
        {
          scope: "project",
          tags: ["general"],
          lesson: "Be careful and verify your work.",
          detail: "",
          fix: "",
        },
        ctx,
      )

      expect(result.title).toBe("Lesson written")
      const file = path.join(instance.directory, ".codemate", "lessons.jsonl")
      const text = yield* Effect.promise(() => fs.readFile(file, "utf8"))
      const parsed = JSON.parse(text.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>
      expect(parsed["status"]).toBe("quarantined")
      const quality = parsed["quality"] as Record<string, unknown>
      const evidence = Array.isArray(quality["evidence"]) ? quality["evidence"] : []
      expect(evidence.some((item) => typeof item === "string" && item.includes("quality_gate:generic_advice"))).toBe(true)
    }),
  )

  it.instance("quarantines changelog-fact lesson", () =>
    Effect.gen(function* () {
      const tool = yield* getTool()
      const instance = yield* TestInstance
      const ctx: Tool.Context = {
        ...baseCtx,
        ask: () => Effect.void,
      }

      yield* tool.execute(
        {
          scope: "project",
          tags: ["docs"],
          lesson: "Created file src/new.ts and updated README.",
          detail: "",
          fix: "",
        },
        ctx,
      )

      const file = path.join(instance.directory, ".codemate", "lessons.jsonl")
      const text = yield* Effect.promise(() => fs.readFile(file, "utf8"))
      const parsed = JSON.parse(text.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>
      expect(parsed["status"]).toBe("quarantined")
    }),
  )

  it.instance("quarantines global writer-summary lesson when strict gate is unmet", () =>
    Effect.gen(function* () {
      const tool = yield* getTool()
      const ctx: Tool.Context = {
        ...baseCtx,
        ask: () => Effect.void,
      }
      const globalLessonsFile = path.join(process.env["XDG_DATA_HOME"] ?? "", "codemate", "lessons", "global.jsonl")

      yield* tool.execute(
        {
          scope: "global",
          tags: ["workflow"],
          lesson: "Implement feature Y quickly.",
          detail: "",
          fix: "",
        },
        ctx,
      )

      const text = yield* Effect.promise(() => fs.readFile(globalLessonsFile, "utf8"))
      const parsed = JSON.parse(text.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>
      expect(parsed["scope"]).toBe("global")
      expect(parsed["status"]).toBe("quarantined")
    }),
  )

  it.instance("skips low-quality research global writes via existing research quality gate", () =>
    Effect.gen(function* () {
      const tool = yield* getTool()
      const ctx: Tool.Context = {
        ...baseCtx,
        ask: () => Effect.void,
      }

      const result = yield* tool.execute(
        {
          scope: "global",
          tags: ["research"],
          lesson: "short note",
          detail: "",
          fix: "",
        },
        ctx,
      )

      expect(result.title).toBe("Lesson skipped (quality gate)")
      expect(result.output).toContain("Skipped writing low-quality research lesson to global cache.")
    }),
  )

  it.instance("classification project scope prevents active global write", () =>
    Effect.gen(function* () {
      const classify = yield* getClassifyTool()
      const write = yield* getTool()
      const ctx: Tool.Context = {
        ...baseCtx,
        ask: () => Effect.void,
      }
      const classified = yield* classify.execute(
        {
          lesson_text: "Use deterministic JSON serialization in this project build flow.",
          error_context: "Build output flaked due to unordered fields",
          fix: "Use stable key ordering before hashing",
        },
        ctx,
      )
      const metadata = classified.metadata as Record<string, unknown>
      const classificationID = metadata["classification_id"]
      expect(typeof classificationID).toBe("string")
      if (typeof classificationID !== "string") return

      const result = yield* write.execute(
        {
          scope: "global",
          tags: ["build"],
          lesson: "Use deterministic JSON serialization in this project build flow.",
          detail: "Build output flaked due to unordered fields",
          fix: "Use stable key ordering before hashing",
          classification_id: classificationID,
        },
        ctx,
      )
      const payload = (result.metadata as Record<string, unknown>)["payload"] as Record<string, unknown>
      expect((result.metadata as Record<string, unknown>)["enforced_scope"]).toBe("project")
      expect(payload["scope"]).toBe("project")
    }),
  )

  it.instance("classification global scope allows global write", () =>
    Effect.gen(function* () {
      const classify = yield* getClassifyTool()
      const write = yield* getTool()
      const ctx: Tool.Context = {
        ...baseCtx,
        ask: () => Effect.void,
      }
      const classified = yield* classify.execute(
        {
          lesson_text:
            "Dependency policy: when upgrading package versions across repos, enforce deterministic lockfile checks and shared verification commands.",
          error_context: "applies across repos where dependency upgrade scripts diverge",
          fix: "use shared package upgrade verification and lockfile checks in every repo",
        },
        ctx,
      )
      const metadata = classified.metadata as Record<string, unknown>
      expect(metadata["scope"]).toBe("global")
      const classificationID = metadata["classification_id"]
      expect(typeof classificationID).toBe("string")
      if (typeof classificationID !== "string") return

      const result = yield* write.execute(
        {
          scope: "global",
          tags: ["dependency", "research"],
          lesson:
            "Dependency policy: when upgrading package versions across repos, enforce deterministic lockfile checks and shared verification commands.",
          detail: "applies across repos where dependency upgrade scripts diverge",
          fix: "use shared package upgrade verification and lockfile checks in every repo",
          classification_id: classificationID,
        },
        ctx,
      )
      const payload = (result.metadata as Record<string, unknown>)["payload"] as Record<string, unknown>
      expect(payload["scope"]).toBe("global")
    }),
  )

  it.instance("classification reject prevents writes", () =>
    Effect.gen(function* () {
      const classify = yield* getClassifyTool()
      const write = yield* getTool()
      const ctx: Tool.Context = {
        ...baseCtx,
        ask: () => Effect.void,
      }
      const classified = yield* classify.execute(
        {
          lesson_text: "   ",
          error_context: "",
          fix: "",
        },
        ctx,
      )
      const rejectedID = (classified.metadata as Record<string, unknown>)["classification_id"]
      expect(typeof rejectedID).toBe("string")
      if (typeof rejectedID !== "string") return

      const result = yield* write.execute(
        {
          scope: "project",
          tags: ["general"],
          lesson: "Be careful.",
          detail: "",
          fix: "",
          classification_id: rejectedID,
        },
        ctx,
      )
      expect(result.title).toBe("Lesson rejected by classification")
      expect((result.metadata as Record<string, unknown>)["written_count"]).toBe(0)
    }),
  )

  it.instance("classification quarantine writes quarantined status", () =>
    Effect.gen(function* () {
      const classify = yield* getClassifyTool()
      const write = yield* getTool()
      const instance = yield* TestInstance
      const ctx: Tool.Context = {
        ...baseCtx,
        ask: () => Effect.void,
      }
      const classified = yield* classify.execute(
        {
          lesson_text: "Be careful and remember to test.",
          error_context: "",
          fix: "",
        },
        ctx,
      )
      const quarantineID = (classified.metadata as Record<string, unknown>)["classification_id"]
      expect(typeof quarantineID).toBe("string")
      if (typeof quarantineID !== "string") return

      yield* write.execute(
        {
          scope: "project",
          tags: ["workflow"],
          lesson: "Remember to test.",
          detail: "",
          fix: "",
          classification_id: quarantineID,
        },
        ctx,
      )
      const file = path.join(instance.directory, ".codemate", "lessons.jsonl")
      const text = yield* Effect.promise(() => fs.readFile(file, "utf8"))
      const parsed = JSON.parse(text.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>
      expect(parsed["status"]).toBe("quarantined")
    }),
  )

  it.instance("invalid classification cannot produce active lesson", () =>
    Effect.gen(function* () {
      const write = yield* getTool()
      const instance = yield* TestInstance
      const ctx: Tool.Context = {
        ...baseCtx,
        ask: () => Effect.void,
      }

      yield* write.execute(
        {
          scope: "project",
          tags: ["workflow"],
          lesson: "Run package-level checks after edits.",
          detail: "",
          fix: "",
          classification_id: "invalid-or-expired-classification",
        },
        ctx,
      )
      const file = path.join(instance.directory, ".codemate", "lessons.jsonl")
      const text = yield* Effect.promise(() => fs.readFile(file, "utf8"))
      const parsed = JSON.parse(text.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>
      expect(parsed["status"]).toBe("quarantined")
    }),
  )

  it.instance("missing classification_id cannot produce active lesson", () =>
    Effect.gen(function* () {
      const write = yield* getTool()
      const instance = yield* TestInstance
      const ctx: Tool.Context = {
        ...baseCtx,
        ask: () => Effect.void,
      }
      yield* write.execute(
        {
          scope: "project",
          tags: ["workflow"],
          lesson: "Run package checks after edits.",
          detail: "",
          fix: "",
          classification_id: "missing-classification",
        },
        ctx,
      )
      const file = path.join(instance.directory, ".codemate", "lessons.jsonl")
      const text = yield* Effect.promise(() => fs.readFile(file, "utf8"))
      const parsed = JSON.parse(text.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>
      expect(parsed["status"]).toBe("quarantined")
    }),
  )

  it.instance("trajectory proposal candidate still requires classification before active write", () =>
    Effect.gen(function* () {
      const write = yield* getTool()
      const instance = yield* TestInstance
      const ctx: Tool.Context = {
        ...baseCtx,
        ask: () => Effect.void,
      }

      yield* write.execute(
        {
          scope: "project",
          tags: ["failure", "proposal"],
          lesson: "When tester fails due to wrong path, correct path and rerun tests before persistence.",
          detail: "proposal candidate without classification binding",
          fix: "do not persist from first failed run",
          classification_id: "proposal-missing-classification",
          trajectory: {
            failed_stage: "tester",
            failure_signal: "wrong path",
            repair_action: "correct path and rerun tests",
            success_signal: "tests passed",
          },
        },
        ctx,
      )

      const file = path.join(instance.directory, ".codemate", "lessons.jsonl")
      const text = yield* Effect.promise(() => fs.readFile(file, "utf8"))
      const parsed = JSON.parse(text.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>
      expect(parsed["status"]).toBe("quarantined")
    }),
  )

  it.instance("legacy lesson_write remains compatible without classification_id", () =>
    Effect.gen(function* () {
      const write = yield* getTool()
      const ctx: Tool.Context = {
        ...baseCtx,
        ask: () => Effect.void,
      }
      const result = yield* write.execute(
        {
          scope: "project",
          tags: ["build"],
          lesson: "Run bun typecheck before final response.",
          detail: "legacy write path",
          fix: "",
        },
        ctx,
      )
      const metadata = result.metadata as Record<string, unknown>
      expect(metadata["legacy_classification"]).toBe(true)
      expect(metadata["classification_bound"]).toBe(false)
    }),
  )

  it.instance("dedupes same fingerprint writes and merges evidence with stable created_at", () =>
    Effect.gen(function* () {
      const write = yield* getTool()
      const instance = yield* TestInstance
      const ctx: Tool.Context = {
        ...baseCtx,
        ask: () => Effect.void,
      }
      const fingerprint = "phase5a|same|fingerprint"

      yield* write.execute(
        {
          scope: "project",
          tags: ["workflow"],
          lesson: "Run package checks after risky refactors.",
          detail: "first evidence from checker run",
          fix: "",
          fingerprint,
        },
        ctx,
      )
      yield* Effect.sleep("5 millis")
      const second = yield* write.execute(
        {
          scope: "project",
          tags: ["workflow", "verification"],
          lesson: "Run package checks after risky refactors.",
          detail: "second evidence from checker rerun",
          fix: "do not skip verification on retry",
          fingerprint,
        },
        ctx,
      )
      const dedupe = ((second.metadata as Record<string, unknown>)["dedupe"] as Record<string, unknown>)["project"] as
        | Record<string, unknown>
        | undefined
      expect(dedupe?.["deduped"]).toBe(true)
      const conflicts = Array.isArray(dedupe?.["conflicts_with"]) ? dedupe?.["conflicts_with"] : []
      expect(conflicts.length).toBe(0)

      const file = path.join(instance.directory, ".codemate", "lessons.jsonl")
      const text = yield* Effect.promise(() => fs.readFile(file, "utf8"))
      const lines = text
        .trim()
        .split("\n")
        .filter(Boolean)
      expect(lines.length).toBe(1)
      const parsed = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>
      const quality = parsed["quality"] as Record<string, unknown>
      const evidence = Array.isArray(quality["evidence"]) ? quality["evidence"] : []
      const tags = Array.isArray(parsed["tags"]) ? parsed["tags"] : []
      const doList = Array.isArray(parsed["do"]) ? parsed["do"] : []
      const appliesWhen = Array.isArray(parsed["applies_when"]) ? parsed["applies_when"] : []
      expect(evidence).toContain("first evidence from checker run")
      expect(evidence).toContain("second evidence from checker rerun")
      expect(tags).toContain("verification")
      expect(doList.some((item) => typeof item === "string" && item.includes("Run package checks after risky refactors."))).toBe(true)
      expect(appliesWhen).toContain("second evidence from checker rerun")
      expect(parsed["created_at"]).not.toBe(parsed["updated_at"])
    }),
  )

  it.instance("appends when fingerprints differ", () =>
    Effect.gen(function* () {
      const write = yield* getTool()
      const instance = yield* TestInstance
      const ctx: Tool.Context = {
        ...baseCtx,
        ask: () => Effect.void,
      }

      yield* write.execute(
        {
          scope: "project",
          tags: ["workflow"],
          lesson: "Run typecheck after parser edits.",
          detail: "parser changed",
          fix: "",
          fingerprint: "phase5a|fp|one",
        },
        ctx,
      )
      yield* write.execute(
        {
          scope: "project",
          tags: ["workflow"],
          lesson: "Run focused tests after parser edits.",
          detail: "tests changed",
          fix: "",
          fingerprint: "phase5a|fp|two",
        },
        ctx,
      )

      const file = path.join(instance.directory, ".codemate", "lessons.jsonl")
      const text = yield* Effect.promise(() => fs.readFile(file, "utf8"))
      expect(
        text
          .trim()
          .split("\n")
          .filter(Boolean).length,
      ).toBe(2)
    }),
  )

  it.instance("dedupes legacy v1 row with incoming v2 by fingerprint and rewrites valid jsonl", () =>
    Effect.gen(function* () {
      const write = yield* getTool()
      const instance = yield* TestInstance
      const ctx: Tool.Context = {
        ...baseCtx,
        ask: () => Effect.void,
      }
      const file = path.join(instance.directory, ".codemate", "lessons.jsonl")
      yield* Effect.promise(() => fs.mkdir(path.dirname(file), { recursive: true }))
      yield* Effect.promise(() =>
        fs.writeFile(
          file,
          `${JSON.stringify({
            id: "legacy-fp-row",
            lesson: "Keep deterministic lockfile validation.",
            tags: ["workflow"],
            scope: "project",
            fingerprint: "phase5a|legacy|same",
            created_at: 1700000000000,
          })}\n`,
        ),
      )

      yield* write.execute(
        {
          scope: "project",
          tags: ["workflow"],
          lesson: "Keep deterministic lockfile validation.",
          detail: "second pass evidence",
          fix: "",
          fingerprint: "phase5a|legacy|same",
        },
        ctx,
      )

      const text = yield* Effect.promise(() => fs.readFile(file, "utf8"))
      const lines = text
        .trim()
        .split("\n")
        .filter(Boolean)
      expect(lines.length).toBe(1)
      const parsed = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>
      expect(parsed["version"]).toBe(2)
      expect(parsed["fingerprint"]).toBe("phase5a|legacy|same")
    }),
  )

  it.instance("does not auto-promote quarantined lesson on duplicate active write", () =>
    Effect.gen(function* () {
      const write = yield* getTool()
      const instance = yield* TestInstance
      const ctx: Tool.Context = {
        ...baseCtx,
        ask: () => Effect.void,
      }
      const now = new Date().toISOString()
      const file = path.join(instance.directory, ".codemate", "lessons.jsonl")
      yield* Effect.promise(() => fs.mkdir(path.dirname(file), { recursive: true }))
      yield* Effect.promise(() =>
        fs.writeFile(
          file,
          `${JSON.stringify({
            id: "q-existing",
            version: 2,
            scope: "project",
            type: "workflow_rule",
            status: "quarantined",
            summary: "Run safety checks after risky refactors.",
            tags: ["workflow"],
            applies_when: ["when risky refactor happened"],
            do: ["run safety checks"],
            dont: [],
            quality: { source: "writer_summary", confidence: 0.4, evidence: ["old"] },
            source: { tool: "lesson_write" },
            created_at: now,
            updated_at: now,
            fingerprint: "phase5a|status|q",
          })}\n`,
        ),
      )

      yield* write.execute(
        {
          scope: "project",
          tags: ["workflow", "verification"],
          lesson: "Run safety checks after risky refactors.",
          detail: "new evidence from passing run",
          fix: "do not skip checks",
          fingerprint: "phase5a|status|q",
        },
        ctx,
      )

      const text = yield* Effect.promise(() => fs.readFile(file, "utf8"))
      const parsed = JSON.parse(text.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>
      expect(parsed["status"]).toBe("quarantined")
    }),
  )

  it.instance("does not auto-reactivate deprecated lesson on duplicate active write", () =>
    Effect.gen(function* () {
      const write = yield* getTool()
      const instance = yield* TestInstance
      const ctx: Tool.Context = {
        ...baseCtx,
        ask: () => Effect.void,
      }
      const now = new Date().toISOString()
      const file = path.join(instance.directory, ".codemate", "lessons.jsonl")
      yield* Effect.promise(() => fs.mkdir(path.dirname(file), { recursive: true }))
      yield* Effect.promise(() =>
        fs.writeFile(
          file,
          `${JSON.stringify({
            id: "d-existing",
            version: 2,
            scope: "project",
            type: "workflow_rule",
            status: "deprecated",
            summary: "Deprecated deterministic lockfile flow.",
            tags: ["workflow"],
            applies_when: ["old migration path"],
            do: ["old flow"],
            dont: [],
            quality: { source: "writer_summary", confidence: 0.8, evidence: ["old"] },
            source: { tool: "lesson_write" },
            created_at: now,
            updated_at: now,
            fingerprint: "phase5a|status|d",
          })}\n`,
        ),
      )

      yield* write.execute(
        {
          scope: "project",
          tags: ["workflow"],
          lesson: "Deprecated deterministic lockfile flow.",
          detail: "new run detail",
          fix: "",
          fingerprint: "phase5a|status|d",
        },
        ctx,
      )

      const text = yield* Effect.promise(() => fs.readFile(file, "utf8"))
      const parsed = JSON.parse(text.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>
      expect(parsed["status"]).toBe("deprecated")
    }),
  )

  it.instance("dedupes per-scope file only and does not cross-merge project/global", () =>
    Effect.gen(function* () {
      const write = yield* getTool()
      const instance = yield* TestInstance
      const ctx: Tool.Context = {
        ...baseCtx,
        ask: () => Effect.void,
      }
      const globalLessonsFile = path.join(process.env["XDG_DATA_HOME"] ?? "", "codemate", "lessons", "global.jsonl")
      const fingerprint = "phase5a|scope|same"
      const beforeGlobalCount = yield* Effect.promise(() =>
        fs
          .readFile(globalLessonsFile, "utf8")
          .then((text) =>
            text
              .trim()
              .split("\n")
              .filter(Boolean).length,
          )
          .catch(() => 0),
      )

      yield* write.execute(
        {
          scope: "project",
          tags: ["workflow"],
          lesson: "Apply deterministic release checklist.",
          detail: "project flow",
          fix: "",
          fingerprint,
        },
        ctx,
      )
      yield* write.execute(
        {
          scope: "global",
          tags: ["workflow"],
          lesson: "Apply deterministic release checklist.",
          detail: "cross repo workflow when release process repeats",
          fix: "do not rely on project-specific path",
          fingerprint,
        },
        ctx,
      )

      const projectText = yield* Effect.promise(() => fs.readFile(path.join(instance.directory, ".codemate", "lessons.jsonl"), "utf8"))
      const globalText = yield* Effect.promise(() => fs.readFile(globalLessonsFile, "utf8"))
      expect(
        projectText
          .trim()
          .split("\n")
          .filter(Boolean).length,
      ).toBe(1)
      expect(
        globalText
          .trim()
          .split("\n")
          .filter(Boolean).length,
      ).toBe(beforeGlobalCount + 1)
    }),
  )

  it.instance("quarantines incoming lesson when incoming do conflicts with active existing dont", () =>
    Effect.gen(function* () {
      const write = yield* getTool()
      const instance = yield* TestInstance
      const ctx: Tool.Context = {
        ...baseCtx,
        ask: () => Effect.void,
      }
      const file = path.join(instance.directory, ".codemate", "lessons.jsonl")

      yield* write.execute(
        {
          scope: "project",
          tags: ["release", "workflow"],
          lesson: "Use smoke test shortcut in release workflow.",
          detail: "when release branch is prepared",
          fix: "do not run full integration tests before release",
        },
        ctx,
      )
      const firstText = yield* Effect.promise(() => fs.readFile(file, "utf8"))
      const first = JSON.parse(firstText.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>
      const firstID = first["id"]
      expect(typeof firstID).toBe("string")
      if (typeof firstID !== "string") return

      yield* write.execute(
        {
          scope: "project",
          tags: ["release", "workflow"],
          lesson: "Run full integration tests before release",
          detail: "when release branch is prepared",
          fix: "",
        },
        ctx,
      )

      const text = yield* Effect.promise(() => fs.readFile(file, "utf8"))
      const incoming = JSON.parse(text.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>
      expect(incoming["status"]).toBe("quarantined")
      const conflictsWith = Array.isArray(incoming["conflicts_with"]) ? incoming["conflicts_with"] : []
      expect(conflictsWith).toContain(firstID)
    }),
  )

  it.instance("quarantines incoming lesson on must vs must not contradiction", () =>
    Effect.gen(function* () {
      const write = yield* getTool()
      const instance = yield* TestInstance
      const ctx: Tool.Context = {
        ...baseCtx,
        ask: () => Effect.void,
      }
      const file = path.join(instance.directory, ".codemate", "lessons.jsonl")

      yield* write.execute(
        {
          scope: "project",
          tags: ["release", "test-policy"],
          lesson: "must run integration tests before release",
          detail: "when release branch is prepared",
          fix: "",
        },
        ctx,
      )
      yield* write.execute(
        {
          scope: "project",
          tags: ["release", "test-policy"],
          lesson: "prefer faster smoke checks for release notes",
          detail: "when release branch is prepared",
          fix: "must not run integration tests before release",
        },
        ctx,
      )

      const text = yield* Effect.promise(() => fs.readFile(file, "utf8"))
      const incoming = JSON.parse(text.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>
      expect(incoming["status"]).toBe("quarantined")
      const conflictsWith = Array.isArray(incoming["conflicts_with"]) ? incoming["conflicts_with"] : []
      expect(conflictsWith.length).toBeGreaterThan(0)
    }),
  )

  it.instance("quarantines incoming lesson on no-op vs do not no-op contradiction", () =>
    Effect.gen(function* () {
      const write = yield* getTool()
      const instance = yield* TestInstance
      const ctx: Tool.Context = {
        ...baseCtx,
        ask: () => Effect.void,
      }
      const file = path.join(instance.directory, ".codemate", "lessons.jsonl")

      yield* write.execute(
        {
          scope: "project",
          tags: ["persistence", "workflow"],
          lesson: "no-op persistence finalizer when changed files are empty",
          detail: "when persistence finalizer sees empty changed files",
          fix: "",
        },
        ctx,
      )
      yield* write.execute(
        {
          scope: "project",
          tags: ["persistence", "workflow"],
          lesson: "persist completion summary for finalized tasks",
          detail: "when persistence finalizer sees empty changed files",
          fix: "do not no-op persistence finalizer when changed files are empty",
        },
        ctx,
      )

      const text = yield* Effect.promise(() => fs.readFile(file, "utf8"))
      const incoming = JSON.parse(text.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>
      expect(incoming["status"]).toBe("quarantined")
      const conflictsWith = Array.isArray(incoming["conflicts_with"]) ? incoming["conflicts_with"] : []
      expect(conflictsWith.length).toBeGreaterThan(0)
    }),
  )

  it.instance("does not mark conflict for different tags and applies_when", () =>
    Effect.gen(function* () {
      const write = yield* getTool()
      const instance = yield* TestInstance
      const ctx: Tool.Context = {
        ...baseCtx,
        ask: () => Effect.void,
      }
      const file = path.join(instance.directory, ".codemate", "lessons.jsonl")

      yield* write.execute(
        {
          scope: "project",
          tags: ["build"],
          lesson: "must run integration tests before release",
          detail: "when release branch is prepared",
          fix: "",
        },
        ctx,
      )
      const second = yield* write.execute(
        {
          scope: "project",
          tags: ["docs"],
          lesson: "must not run integration tests before release",
          detail: "when writing architecture docs",
          fix: "",
        },
        ctx,
      )

      const dedupe = ((second.metadata as Record<string, unknown>)["dedupe"] as Record<string, unknown>)["project"] as
        | Record<string, unknown>
        | undefined
      const conflicts = Array.isArray(dedupe?.["conflicts_with"]) ? dedupe?.["conflicts_with"] : []
      expect(conflicts.length).toBe(0)
      const text = yield* Effect.promise(() => fs.readFile(file, "utf8"))
      const incoming = JSON.parse(text.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>
      expect(incoming["status"]).toBe("active")
    }),
  )

  it.instance("existing quarantined conflict does not block incoming active and reports possible_conflicts metadata", () =>
    Effect.gen(function* () {
      const write = yield* getTool()
      const instance = yield* TestInstance
      const ctx: Tool.Context = {
        ...baseCtx,
        ask: () => Effect.void,
      }
      const file = path.join(instance.directory, ".codemate", "lessons.jsonl")
      const now = new Date().toISOString()
      yield* Effect.promise(() => fs.mkdir(path.dirname(file), { recursive: true }))
      yield* Effect.promise(() =>
        fs.writeFile(
          file,
          `${JSON.stringify({
            id: "q-conflict-existing",
            version: 2,
            scope: "project",
            type: "workflow_rule",
            status: "quarantined",
            summary: "legacy quarantine policy",
            tags: ["release", "workflow"],
            applies_when: ["when release branch is prepared"],
            do: ["legacy release flow"],
            dont: ["do not run integration tests for release"],
            quality: { source: "writer_summary", confidence: 0.4, evidence: ["legacy"] },
            source: { tool: "lesson_write" },
            created_at: now,
            updated_at: now,
            fingerprint: "q-conflict-existing-fp",
          })}\n`,
        ),
      )

      const result = yield* write.execute(
        {
          scope: "project",
          tags: ["release", "workflow"],
          lesson: "run integration tests for release",
          detail: "when release branch is prepared",
          fix: "",
        },
        ctx,
      )

      const dedupe = ((result.metadata as Record<string, unknown>)["dedupe"] as Record<string, unknown>)["project"] as
        | Record<string, unknown>
        | undefined
      const possible = Array.isArray(dedupe?.["possible_conflicts"]) ? dedupe?.["possible_conflicts"] : []
      expect(possible).toContain("q-conflict-existing")
      const text = yield* Effect.promise(() => fs.readFile(file, "utf8"))
      const incoming = JSON.parse(text.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>
      expect(incoming["status"]).toBe("active")
    }),
  )

  it.instance("failure_pattern lesson can persist provided trajectory fields", () =>
    Effect.gen(function* () {
      const classify = yield* getClassifyTool()
      const write = yield* getTool()
      const instance = yield* TestInstance
      const ctx: Tool.Context = {
        ...baseCtx,
        ask: () => Effect.void,
      }
      const classified = yield* classify.execute(
        {
          lesson_text: "Runtime failure pattern: network retry loop must stop after bounded attempts.",
          error_context: "runtime task repeatedly failed after unbounded retry",
          fix: "bound retries and add explicit success criteria",
        },
        ctx,
      )
      const classificationID = (classified.metadata as Record<string, unknown>)["classification_id"]
      expect(typeof classificationID).toBe("string")
      if (typeof classificationID !== "string") return

      yield* write.execute(
        {
          scope: "project",
          tags: ["runtime", "failure"],
          lesson: "Runtime failure pattern: network retry loop must stop after bounded attempts.",
          detail: "applies when retries can loop forever without terminal success",
          fix: "bound retries and add explicit success criteria",
          classification_id: classificationID,
          trajectory: {
            failed_stage: "tester",
            failed_agent: "tester",
            failure_signal: "retry loop exhausted without pass",
            repair_action: "bound retry count and rerun tests",
            success_signal: "tests passed after retry bound fix",
            evidence_refs: ["task:test_retry_loop"],
          },
        },
        ctx,
      )

      const file = path.join(instance.directory, ".codemate", "lessons.jsonl")
      const text = yield* Effect.promise(() => fs.readFile(file, "utf8"))
      const parsed = JSON.parse(text.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>
      const trajectory = parsed["trajectory"] as Record<string, unknown>
      expect(trajectory).toBeDefined()
      expect(trajectory["failed_stage"]).toBe("tester")
      expect(trajectory["success_signal"]).toBe("tests passed after retry bound fix")
    }),
  )
})
