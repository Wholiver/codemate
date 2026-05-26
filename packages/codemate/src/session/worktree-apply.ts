import path from "node:path"
import os from "node:os"
import { createHash } from "node:crypto"
import { copyFile, mkdir, readFile, rm, stat } from "node:fs/promises"
import { ensureAbsolutePathList, normalizeAbsolute } from "@/session/path-context"

export type WorktreeContext = {
  run_id: string
  project_root: string
  worktree_root: string
  sandbox_root: string
  target_to_sandbox: Map<string, string>
  sandbox_to_target: Map<string, string>
}

export type ApplyResult = {
  ok: boolean
  actual_output_paths: string[]
  applied: Array<{ sandbox_path: string; target_path: string; sha256: string }>
  reason?: string
}

function toAbs(input: string, cwd: string) {
  const [abs] = ensureAbsolutePathList([input], { cwd })
  return abs ? normalizeAbsolute(abs) : ""
}

function stableRelTarget(targetPath: string) {
  const normalized = normalizeAbsolute(targetPath)
  if (normalized === "/") return "ROOT_FORBIDDEN"
  const rel = normalized.replace(/^\/+/, "")
  return rel.length > 0 ? rel : "ROOT_FORBIDDEN"
}

function sha256Hex(input: Uint8Array) {
  return createHash("sha256").update(input).digest("hex")
}

async function hashFile(filepath: string) {
  const content = await readFile(filepath)
  return sha256Hex(content)
}

export async function createRunWorktree(input: { runID: string; projectRoot: string }) {
  const projectRoot = normalizeAbsolute(input.projectRoot)
  const runRoot = path.join(projectRoot, ".codemate", "run-worktrees", input.runID)
  const sandboxRoot = path.join(runRoot, "sandbox")
  await mkdir(sandboxRoot, { recursive: true })
  return {
    run_id: input.runID,
    project_root: projectRoot,
    worktree_root: runRoot,
    sandbox_root: sandboxRoot,
    target_to_sandbox: new Map<string, string>(),
    sandbox_to_target: new Map<string, string>(),
  } satisfies WorktreeContext
}

export function mapTargetPathToSandbox(context: WorktreeContext, targetPath: string) {
  const targetAbs = toAbs(targetPath, context.project_root)
  if (!targetAbs || targetAbs === "/") {
    throw new Error(`invalid target path for worktree mapping: ${targetPath}`)
  }
  const existing = context.target_to_sandbox.get(targetAbs)
  if (existing) return existing
  const sandboxPath = normalizeAbsolute(path.join(context.sandbox_root, stableRelTarget(targetAbs)))
  context.target_to_sandbox.set(targetAbs, sandboxPath)
  context.sandbox_to_target.set(sandboxPath, targetAbs)
  return sandboxPath
}

export async function applySandboxOutputs(input: {
  context: WorktreeContext
  allowlistedTargetPaths: string[]
  sandboxOutputPaths: string[]
}) {
  const allowlistedTargets = new Set(
    ensureAbsolutePathList(input.allowlistedTargetPaths, { cwd: input.context.project_root })
      .map((item) => normalizeAbsolute(item))
      .filter((item) => item && item !== "/"),
  )
  if (allowlistedTargets.size === 0) {
    return {
      ok: false,
      actual_output_paths: [],
      applied: [],
      reason: "no allowlisted target paths",
    } satisfies ApplyResult
  }

  const sandboxOutputs = [...new Set(input.sandboxOutputPaths.map((item) => normalizeAbsolute(item)).filter(Boolean))]
  if (sandboxOutputs.length === 0) {
    return {
      ok: true,
      actual_output_paths: [],
      applied: [],
      reason: "no sandbox outputs to apply",
    } satisfies ApplyResult
  }

  const applied: Array<{ sandbox_path: string; target_path: string; sha256: string }> = []
  for (const sandboxPath of sandboxOutputs) {
    const targetPath = input.context.sandbox_to_target.get(sandboxPath)
    if (!targetPath) {
      return {
        ok: false,
        actual_output_paths: [],
        applied: [],
        reason: `sandbox output not mapped to target: ${sandboxPath}`,
      } satisfies ApplyResult
    }
    if (targetPath === "/") {
      return {
        ok: false,
        actual_output_paths: [],
        applied: [],
        reason: "refusing to apply to root path '/'",
      } satisfies ApplyResult
    }
    if (!allowlistedTargets.has(targetPath)) {
      return {
        ok: false,
        actual_output_paths: [],
        applied: [],
        reason: `target path not allowlisted: ${targetPath}`,
      } satisfies ApplyResult
    }

    const sandboxStat = await stat(sandboxPath).catch(() => undefined)
    if (!sandboxStat || !sandboxStat.isFile()) {
      return {
        ok: false,
        actual_output_paths: [],
        applied: [],
        reason: `sandbox file missing before apply: ${sandboxPath}`,
      } satisfies ApplyResult
    }

    await mkdir(path.dirname(targetPath), { recursive: true })
    await copyFile(sandboxPath, targetPath)

    const [sourceHash, targetHash] = await Promise.all([hashFile(sandboxPath), hashFile(targetPath)])
    if (sourceHash !== targetHash) {
      return {
        ok: false,
        actual_output_paths: [],
        applied: [],
        reason: `apply readback/hash verification failed: ${targetPath}`,
      } satisfies ApplyResult
    }

    applied.push({ sandbox_path: sandboxPath, target_path: targetPath, sha256: targetHash })
  }

  return {
    ok: true,
    actual_output_paths: [...new Set(applied.map((item) => item.target_path))],
    applied,
  } satisfies ApplyResult
}

export async function cleanupWorktree(context: WorktreeContext | undefined) {
  if (!context) return
  const normalized = normalizeAbsolute(context.worktree_root)
  const runRoot = normalizeAbsolute(path.join(context.project_root, ".codemate", "run-worktrees"))
  if (!normalized.startsWith(`${runRoot}/`)) return
  if (normalized === "/") return
  await rm(normalized, { recursive: true, force: true })
}

export function defaultWorktreeBase() {
  return path.join(os.tmpdir(), "codemate-run-worktrees")
}
