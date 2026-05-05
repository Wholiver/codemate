import path from "path"
import { Effect, Schema, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { InstanceState } from "@/effect/instance-state"
import * as Log from "@codemate-ai/core/util/log"
import * as Tool from "./tool"

const log = Log.create({ service: "selfcheck-tool" })

export const Parameters = Schema.Struct({
  checks: Schema.optional(
    Schema.Array(
      Schema.Literals(["typecheck", "lint", "test"]).annotate({
        description: "Which checks to run. Defaults to all three: typecheck, lint, test.",
      }),
    ),
  ).annotate({
    description: "Optional array of checks to run. Default: ['typecheck', 'lint', 'test']",
  }),
  commands: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      "Optional custom verification commands to execute in the repo root (for non-JS/TS tasks, pass task-appropriate commands like pytest/go test/cargo test).",
  }),
})

type CheckResult = {
  check: string
  status: "passed" | "failed" | "skipped"
  exitCode: number | null
  output: string
}

type Metadata = {
  results: Array<{
    check: string
    status: "passed" | "failed" | "skipped"
    passed: boolean
    exitCode: number | null
  }>
  allPassed: boolean
}

const QUICK_TIMEOUT = 15_000
const CHECK_TIMEOUT = 5 * 60 * 1000
const TEST_TIMEOUT = 10 * 60 * 1000
const TRUNCATE_MAX_LINES = 200

function truncateOutput(output: string, maxLines = TRUNCATE_MAX_LINES): string {
  const lines = output.split("\n")
  if (lines.length <= maxLines) return output
  return lines.slice(0, maxLines).join("\n") + `\n\n... truncated (${lines.length - maxLines} more lines)`
}

function splitLines(output: string) {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
}

function isSelfcheckRelevantFile(file: string) {
  const normalized = file.replaceAll(path.sep, "/")

  if (
    normalized === "package.json" ||
    normalized === "bunfig.toml" ||
    normalized.startsWith("packages/") ||
    normalized.endsWith("/package.json") ||
    normalized.endsWith("/bunfig.toml") ||
    normalized.endsWith("/tsconfig.json") ||
    normalized.endsWith("/tsconfig.base.json")
  ) {
    return true
  }

  return (
    normalized.endsWith(".ts") ||
    normalized.endsWith(".tsx") ||
    normalized.endsWith(".js") ||
    normalized.endsWith(".jsx") ||
    normalized.endsWith(".mjs") ||
    normalized.endsWith(".cjs") ||
    normalized.endsWith(".json")
  )
}

function summarize(result: CheckResult) {
  const icon = result.status === "passed" ? "PASS" : result.status === "failed" ? "FAIL" : "SKIP"
  const detail =
    result.status === "passed"
      ? "passed"
      : result.status === "failed"
        ? `failed (exit ${result.exitCode})`
        : "skipped"
  return `${icon} ${result.check}: ${detail}`
}

const detectChangedFiles = Effect.fn("SelfCheck.detectChangedFiles")(function* (
  spawner: { readonly spawn: ChildProcessSpawner["Service"]["spawn"] },
  root: string,
) {
  const tracked = yield* runCommand(spawner, "git diff --name-only --relative HEAD", root, QUICK_TIMEOUT)
  const untracked = yield* runCommand(spawner, "git ls-files --others --exclude-standard", root, QUICK_TIMEOUT)

  if (tracked.exitCode !== 0 && untracked.exitCode !== 0) {
    return {
      files: [] as string[],
      gitAvailable: false,
    }
  }

  return {
    files: Array.from(new Set([...splitLines(tracked.output), ...splitLines(untracked.output)])),
    gitAvailable: true,
  }
})

function runCommand(
  spawner: { readonly spawn: ChildProcessSpawner["Service"]["spawn"] },
  command: string,
  cwd: string,
  timeout: number,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(command, [], {
          shell: true,
          cwd,
          stdin: "ignore",
          detached: false,
          extendEnv: true,
        }),
      )

      let output = ""
      yield* Effect.forkScoped(
        Stream.runForEach(Stream.decodeText(handle.all), (chunk) => {
          output += chunk
          return Effect.void
        }),
      )

      const exitCode = yield* Effect.raceAll([
        handle.exitCode.pipe(Effect.map((code) => ({ code }))),
        Effect.sleep(timeout).pipe(
          Effect.tap(() => handle.kill()),
          Effect.map(() => ({ code: null as null })),
        ),
      ])

      return { output, exitCode: exitCode.code }
    }),
  ).pipe(Effect.orDie)
}

async function findNearestPackage(root: string, changedPath: string) {
  const absolute = path.resolve(root, changedPath)
  const packagesRoot = path.join(root, "packages")
  let current = absolute

  while (current.startsWith(packagesRoot)) {
    if (await Bun.file(path.join(current, "package.json")).exists()) {
      return path.relative(root, current).replaceAll(path.sep, "/")
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
}

async function getPackageTestCommand(root: string, packageDir: string) {
  const pkg = (await Bun.file(path.join(root, packageDir, "package.json")).json()) as {
    scripts?: Record<string, string>
  }
  if (!pkg.scripts?.test) return
  return "bun run test"
}

const detectTestTargets = Effect.fn("SelfCheck.detectTestTargets")(function* (
  spawner: { readonly spawn: ChildProcessSpawner["Service"]["spawn"] },
  root: string,
) {
  const tracked = yield* runCommand(spawner, "git diff --name-only --relative HEAD", root, QUICK_TIMEOUT)
  const untracked = yield* runCommand(spawner, "git ls-files --others --exclude-standard", root, QUICK_TIMEOUT)

  if (tracked.exitCode !== 0 && untracked.exitCode !== 0) {
    return {
      runnable: [] as Array<{ packageDir: string; command: string }>,
      skipped: [] as string[],
      reason: "Unable to detect changed files from git.",
    }
  }

  const changedFiles = Array.from(new Set([...splitLines(tracked.output), ...splitLines(untracked.output)]))
  if (changedFiles.length === 0) {
    return {
      runnable: [] as Array<{ packageDir: string; command: string }>,
      skipped: [] as string[],
      reason: "No changed files detected.",
    }
  }

  const packageDirs = Array.from(
    new Set(
      (
        yield* Effect.promise(() =>
          Promise.all(changedFiles.map((changedPath) => findNearestPackage(root, changedPath))),
        )
      ).filter((item): item is string => Boolean(item)),
    ),
  )

  const runnable: Array<{ packageDir: string; command: string }> = []
  const skipped: string[] = []

  for (const packageDir of packageDirs) {
    const command = yield* Effect.promise(() => getPackageTestCommand(root, packageDir))
    if (!command) {
      skipped.push(`${packageDir} (no test script)`)
      continue
    }
    runnable.push({ packageDir, command })
  }

  return { runnable, skipped, reason: "" }
})

export const SelfCheckTool = Tool.define<typeof Parameters, Metadata, ChildProcessSpawner>(
  "selfcheck",
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner
    return {
      description:
        "Verify your work by running checks. For JS/TS code changes, this runs typecheck, lint, and test. For non-JS/TS tasks, pass task-appropriate verification commands via `commands` (for example: pytest, go test ./..., cargo test). Always call selfcheck before your final response regardless of task type. If any check fails, you must record the failure via memory_create and changelog_append, then update lessons with lesson_write, then run a new research pass (websearch or webfetch plus at least one research tool) before your next major fix attempt.",
      parameters: Parameters,
      execute: (params, _ctx) =>
        Effect.gen(function* () {
          const instanceCtx = yield* InstanceState.context
          const root = instanceCtx.worktree
          const checks = params.checks ?? ["typecheck", "lint", "test"]
          const commands = (params.commands ?? []).map((item) => item.trim()).filter(Boolean)
          const results: CheckResult[] = []

          const bunCheck = yield* runCommand(spawner, "command -v bun >/dev/null 2>&1", root, QUICK_TIMEOUT)
          const changed = yield* detectChangedFiles(spawner, root)
          const hasRelevantChanges = changed.files.some(isSelfcheckRelevantFile)
          const applicable = bunCheck.exitCode === 0 && (!changed.gitAvailable || hasRelevantChanges)

          for (const command of commands) {
            const result = yield* runCommand(spawner, command, root, CHECK_TIMEOUT)
            results.push({
              check: `command: ${command}`,
              status: result.exitCode === 0 ? "passed" : "failed",
              exitCode: result.exitCode,
              output: result.output,
            })
          }

          if (!applicable) {
            const reason =
              bunCheck.exitCode !== 0
                ? "bun is not available; selfcheck (repo JS/TS checks) is not applicable to this task."
                : changed.gitAvailable
                  ? "No relevant JS/TS repository changes detected."
                  : "Unable to confirm relevant repository JS/TS changes."

            if (commands.length === 0) {
              results.push({
                check: "verification",
                status: "failed",
                exitCode: 1,
                output: `${reason}\nProvide task-appropriate verification commands via selfcheck.commands.`,
              })
            }

            return {
              title: commands.length === 0 ? "Verification required" : "Custom verification completed",
              output: [results.map(summarize).join("\n"), "", "--- selfcheck output ---", reason, ""].join("\n"),
              metadata: {
                results: results.map((result) => ({
                  check: result.check,
                  status: result.status,
                  passed: result.status === "passed",
                  exitCode: result.exitCode,
                })),
                allPassed: results.every((result) => result.status !== "failed"),
              },
            }
          }

          if (checks.length === 0 && commands.length === 0) {
            results.push({
              check: "verification",
              status: "failed",
              exitCode: 1,
              output: "No checks or verification commands were provided.",
            })
          }

          for (const check of checks) {
            switch (check) {
              case "typecheck": {
                const result = yield* runCommand(spawner, "bun typecheck", root, CHECK_TIMEOUT)
                results.push({
                  check: "typecheck",
                  status: result.exitCode === 0 ? "passed" : "failed",
                  exitCode: result.exitCode,
                  output: result.output,
                })
                break
              }
              case "lint": {
                const result = yield* runCommand(spawner, "bun lint", root, CHECK_TIMEOUT)
                results.push({
                  check: "lint",
                  status: result.exitCode === 0 ? "passed" : "failed",
                  exitCode: result.exitCode,
                  output: result.output,
                })
                break
              }
              case "test": {
                const targets = yield* detectTestTargets(spawner, root)

                if (targets.runnable.length === 0) {
                  results.push({
                    check: "test",
                    status: "skipped",
                    exitCode: null,
                    output:
                      [targets.reason, ...targets.skipped].filter(Boolean).join("\n") || "No package tests were selected.",
                  })
                  break
                }

                let failed = false
                const testOutputs: string[] = []
                for (const target of targets.runnable) {
                  const testResult = yield* runCommand(
                    spawner,
                    target.command,
                    path.join(root, target.packageDir),
                    TEST_TIMEOUT,
                  )
                  if (testResult.exitCode !== 0) failed = true
                  testOutputs.push(
                    `[${target.packageDir}] exit=${testResult.exitCode}\n${truncateOutput(testResult.output)}`,
                  )
                }
                if (targets.skipped.length > 0) {
                  testOutputs.push(`Skipped:\n${targets.skipped.join("\n")}`)
                }
                results.push({
                  check: "test",
                  status: failed ? "failed" : "passed",
                  exitCode: failed ? 1 : 0,
                  output: testOutputs.join("\n\n"),
                })
                break
              }
            }
          }

          const allPassed = results.every((result) => result.status !== "failed")
          const anySkipped = results.some((result) => result.status === "skipped")
          const outputParts = [results.map(summarize).join("\n"), ""]

          for (const result of results) {
            if (result.status === "failed" || result.status === "skipped" || result.output.includes("Skipped:\n")) {
              outputParts.push(`--- ${result.check} output ---`)
              outputParts.push(truncateOutput(result.output))
              outputParts.push("")
            }
          }

          log.info("selfcheck completed", {
            allPassed,
            results: results.map((result) => ({
              check: result.check,
              status: result.status,
              exitCode: result.exitCode,
            })),
          })

          return {
            title: allPassed ? (anySkipped ? "Checks completed with skips" : "All checks passed") : "Some checks failed",
            output: outputParts.join("\n"),
            metadata: {
              results: results.map((result) => ({
                check: result.check,
                status: result.status,
                passed: result.status === "passed",
                exitCode: result.exitCode,
              })),
              allPassed,
            },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
