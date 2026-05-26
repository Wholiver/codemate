# Typecheck Baseline (2026-05-24)

## Scope
- Command:
  - `cd packages/codemate`
  - `bun typecheck 2>&1 | tee /tmp/codemate-typecheck.log`
- Goal of this baseline:
  - confirm files changed for HNSW/adaptive_replan/provider/memory are type-clean
  - classify remaining repo-wide type errors without changing runtime behavior

## Current Status
- `bun typecheck`: **failed**
- Total TypeScript errors: **984**
- Files with at least one error: **157**

## Error Category Distribution
- `TS2307` missing module: **161**
- `TS7016` missing declaration: **21**
- `TS7006` implicit any parameter: **483**
- `TS18046` unknown type access: **97**
- Other TS errors: **222**

Top remaining codes after the four categories above:
- `TS2339`: 96
- `TS2739`: 31
- `TS2345`: 27
- `TS2554`: 25
- `TS2322`: 17

## Core Files (This Round) Type-Clean Check
The following files were checked directly against `/tmp/codemate-typecheck.log` and all are clean (0 errors):

- `src/session/agent-memory-hnsw-index.ts`
- `src/session/agent-memory-config.ts`
- `src/session/agent-memory-index.ts`
- `src/session/embedding.ts`
- `src/session/replan.ts`
- `src/session/taskgraph-patch.ts`
- `src/session/prompt.ts`
- `src/provider/provider-routing.ts`
- `src/provider/provider-health.ts`
- `src/provider/provider-telemetry.ts`
- `src/provider/provider-route-scoring.ts`
- `src/provider/provider-route-dry-run.ts`
- `src/session/llm.ts`

## Missing-Dependency Focus (Investigated)
Modules called out for inspection:
- `@agentclientprotocol/sdk`
- `@clack/prompts`
- `@actions/core`
- `@actions/github`
- `@octokit/webhooks-types`
- `@types/yargs`

Current `packages/codemate/package.json` state:
- all six are currently missing from `dependencies/devDependencies`.

Usage/impact assessment:
- `@agentclientprotocol/sdk`: imported by `src/acp/*` and ACP tests; required for ACP compile path.
- `@clack/prompts`: imported by multiple CLI commands; required for CLI compile path.
- `@actions/*` + `@octokit/webhooks-types`: used in GitHub command path; needed for full compile of that command module.
- `@types/yargs`: needed for typed `yargs` imports to remove `TS7016`.

Decision in this baseline pass:
- No dependency additions were made in this pass.
- Reason: this pass is for baseline establishment and keeping behavior unchanged; missing-module/type-declaration failures are recorded as existing repo baseline debt outside HNSW/adaptive_replan/provider/memory changes.

## Error Concentration (By Module Prefix)
Most errors are outside this round’s scope and are concentrated in:
- `src/cli/*`
- `src/acp/*`
- `test/util/*`
- `test/acp/*`

## Optional Targeted Verification Commands
- Full:
  - `bun typecheck 2>&1 | tee /tmp/codemate-typecheck.log`
- Verify round-scope files are clean:
  - `python` log scan over the file list above against `/tmp/codemate-typecheck.log`

## Notes
- No feature behavior changes were introduced by baseline work.
- HNSW/adaptive_replan/provider/memory runtime behavior and tests remain unchanged in this pass.

---

## Pre-Commit Audit Update (2026-05-26)

### Command
- `cd packages/codemate`
- `bun run typecheck > /tmp/codemate-cli-typecheck.log 2>&1`

### Current Snapshot
- `bun run typecheck`: **failed** (`exit 2`)
- Total TypeScript errors in this run: **263**
- Files with at least one error in this run: **69**

### Core Files (This Round) Status
Type errors present:
- `src/session/prompt.ts`
- `src/session/trajectory.ts`
- `src/tool/task.ts`
- `test/session/prompt.test.ts`
- `test/tool/task.test.ts`

Checked clean in this run (0 errors in `/tmp/codemate-cli-typecheck.log`):
- `src/session/llm.ts`
- `src/session/path-context.ts`
- `src/session/worktree-apply.ts`
- `src/session/replan.ts`
- `src/session/taskgraph-patch.ts`
- `src/session/embedding.ts`
- `src/session/agent-memory-config.ts`
- `src/session/agent-memory-hnsw-index.ts`
- `src/session/agent-memory-hybrid-index.ts`
- `src/session/agent-memory-index.ts`
- `src/session/agent-memory-sync.ts`
- `src/provider/provider-routing.ts`
- `src/provider/provider-health.ts`
- `src/provider/provider-route-scoring.ts`
- `src/provider/provider-route-dry-run.ts`
- `src/provider/provider-telemetry.ts`

### Remaining Baseline Concentration (Top)
- `src/cli/cmd/run.ts` (90 errors)
- `test/util/effect-zod.test.ts` (32 errors)
- `src/cli/cmd/mcp.ts` (13 errors)
