import { describe, expect, it } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  applySandboxOutputs,
  cleanupWorktree,
  createRunWorktree,
  mapTargetPathToSandbox,
} from "@/session/worktree-apply"

describe("session.worktree-apply", () => {
  it("planner required path maps to sandbox path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codemate-worktree-map-"))
    try {
      const ctx = await createRunWorktree({ runID: "run_map", projectRoot: root })
      const sandbox = mapTargetPathToSandbox(ctx, "/app/ssl/server.key")
      expect(sandbox.startsWith(`${ctx.sandbox_root}/`)).toBe(true)
      expect(ctx.sandbox_to_target.get(sandbox)).toBe("/app/ssl/server.key")
      expect(ctx.target_to_sandbox.get("/app/ssl/server.key")).toBe(sandbox)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("apply copies sandbox output to target path with readback hash verify", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codemate-worktree-apply-"))
    try {
      const ctx = await createRunWorktree({ runID: "run_apply", projectRoot: root })
      const target = path.join(root, "targets", "a.txt")
      const sandbox = mapTargetPathToSandbox(ctx, target)
      await mkdir(path.dirname(sandbox), { recursive: true })
      await writeFile(sandbox, "hello-worktree", "utf8")

      const result = await applySandboxOutputs({
        context: ctx,
        allowlistedTargetPaths: [target],
        sandboxOutputPaths: [sandbox],
      })

      expect(result.ok).toBe(true)
      expect(result.actual_output_paths).toEqual([target])
      expect(await readFile(target, "utf8")).toBe("hello-worktree")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("apply refuses non-allowlisted target", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codemate-worktree-allowlist-"))
    try {
      const ctx = await createRunWorktree({ runID: "run_allowlist", projectRoot: root })
      const target = path.join(root, "targets", "a.txt")
      const sandbox = mapTargetPathToSandbox(ctx, target)
      await mkdir(path.dirname(sandbox), { recursive: true })
      await writeFile(sandbox, "deny", "utf8")

      const result = await applySandboxOutputs({
        context: ctx,
        allowlistedTargetPaths: [path.join(root, "targets", "other.txt")],
        sandboxOutputPaths: [sandbox],
      })

      expect(result.ok).toBe(false)
      expect(result.reason).toContain("not allowlisted")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("apply checks sandbox file exists before copy", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codemate-worktree-missing-"))
    try {
      const ctx = await createRunWorktree({ runID: "run_missing", projectRoot: root })
      const target = path.join(root, "targets", "a.txt")
      const sandbox = mapTargetPathToSandbox(ctx, target)

      const result = await applySandboxOutputs({
        context: ctx,
        allowlistedTargetPaths: [target],
        sandboxOutputPaths: [sandbox],
      })

      expect(result.ok).toBe(false)
      expect(result.reason).toContain("sandbox file missing")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("cleanup worktree removes run-scoped root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codemate-worktree-cleanup-"))
    const ctx = await createRunWorktree({ runID: "run_cleanup", projectRoot: root })
    await writeFile(path.join(ctx.sandbox_root, "tmp.txt"), "x", "utf8")
    await cleanupWorktree(ctx)
    const exists = await Bun.file(path.join(root, ".codemate", "run-worktrees", "run_cleanup")).exists()
    expect(exists).toBe(false)
    await rm(root, { recursive: true, force: true })
  })
})
