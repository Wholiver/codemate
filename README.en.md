<p align="center">
  <img src="packages/web/src/assets/lander/readme-banner.svg" alt="Codemate" />
</p>

<div align="center">

### Open-source coding agent for long-horizon engineering

**Memory-first. Learning-enabled. Verification-driven. Research-native.**

[![Build status](https://img.shields.io/github/actions/workflow/status/Wholiver/codemate/publish.yml?style=flat-square&branch=dev)](https://github.com/Wholiver/codemate/actions/workflows/publish.yml)
[![JSR](https://img.shields.io/badge/JSR-@codemate/codemate-00bcd4?style=flat-square)](https://jsr.io/@codemate/codemate)

_Built on top of OPENCODE, with sincere thanks to the OPENCODE team and community._

<sub><a href="README.en.md">English</a> · <a href="README.md">简体中文</a></sub>

</div>

[![Codemate Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://codemate.ai)

---

<p align="center"><strong>See it fast:</strong> <a href="#30-second-value">30-second value</a> · <a href="#install-global-cli">install</a> · <a href="#architecture-at-a-glance">architecture</a> · <a href="#core-features">core features</a> · <a href="#comparison">comparison</a></p>

> [!WARNING]
> Codemate is currently in **beta**. APIs, behavior, and package details may change before stable release.

## 30-Second Value

Codemate is not a one-shot chat tool. It is a runtime that turns each engineering run into context for the next run.

| 30-second signal      | What the system actually does                                            | What you feel in day-to-day work                |
| --------------------- | ------------------------------------------------------------------------ | ----------------------------------------------- |
| Sessions keep moving  | `SessionPrompt` runs a stateful loop across model calls and tool actions | Work advances to closure, not just one response |
| Context compounds     | Each turn injects `memory`, `project-changelog`, and `project-lessons`  | Less repeated onboarding and fewer context gaps |
| Changes are traceable | Snapshot diffs produce patch parts, summaries, and changelog entries     | You can audit what changed and why              |
| Verification is built in | `selfcheck` provides a unified verification gate (default + custom commands) | Fewer "works locally, breaks in CI" outcomes |
| Long runs stay stable | Overflow triggers automatic compaction with recent-tail preservation      | Large sessions fail less often from context size |
| Uncertain work is structured | `research-*` turns ambiguity into a research pipeline and report         | Better migration/vendor/policy decisions         |

<a id="install-global-cli"></a>

## Install (Global CLI)

> [!IMPORTANT]
> For repository development, use Bun `1.3.13` (exact version expected by this monorepo).

```bash
npm install -g codemate-agent
codemate --help
```

- Global `codemate` command package: https://www.npmjs.com/package/codemate-agent
- Docs: https://codemate.ai/docs

## Run CLI For Testing

```bash
git clone https://github.com/Wholiver/codemate.git
cd codemate
bun install
bun dev
```

## Architecture At A Glance

> [!IMPORTANT]
> The default branch is `dev` (not `main`). Use `dev` / `origin/dev` for diffs and PR targets.

Codemate is not centered on a single model call. It runs a stateful session runtime with explicit event, tool, and recovery stages:

```text
User input
  -> SessionPrompt.run (main session loop)
  -> Context Assembly
       (system + instructions + history + memory + changelog + lessons)
  -> LLM.stream
       -> SessionProcessor consumes stream events
          (reasoning / text / tool-call / tool-result / step-finish)
       -> ToolRegistry routes tool calls
          (builtin + MCP + plugin, with permission and doom-loop guards)
  -> Snapshot/Patch + SessionSummary + Changelog
  -> Verification & persistence reminders
       (selfcheck / memory_create / lesson_write / changelog_append)
  -> If overflow: SessionCompaction
       (summary compaction + recent-tail preservation + auto-continue)
```

| Subsystem               | Responsibility                                        | Key modules (examples)                    |
| ----------------------- | ----------------------------------------------------- | ----------------------------------------- |
| Session orchestration   | Runs turn loop, model scheduling, reminders, and flow control | `session/prompt.ts`                  |
| Event processing        | Persists stream events into replayable message parts  | `session/processor.ts`, `session/message-v2.ts` |
| Tool and protocol plane | Aggregates builtin, MCP, and plugin tools with unified permission gating | `tool/registry.ts`, `mcp/index.ts`, `acp/agent.ts` |
| Memory and learning plane | Supplies searchable memory, changelog, and lessons context | `memory/*`, `changelog/*`, `lesson/context.ts` |
| Verification and recovery | Applies pre-handoff checks and failure reflection flow | `tool/selfcheck.ts`, `session/system.ts` |
| Long-context stability  | Handles overflow compaction and historical output pruning | `session/compaction.ts`                  |

The goal is compounding reliability: each run should make the next run faster, safer, and less repetitive.

## Core Features

### 1) Memory: Keep Project Context Across Sessions

Memory keeps important decisions and constraints reusable, even when work is spread across days, weeks, or different contributors.

- What it does: Stores structured project memory, retrieves by keyword/semantic/hybrid search, and lets new memory versions replace outdated ones cleanly.
- When to use it: Multi-step migrations, long bug investigations, or any work where "why we chose this" matters later.
- Example: Your team decides "Auth uses short-lived access tokens + rotating refresh tokens." Two weeks later, a new feature and a security fix both follow that same policy without re-explaining it in each prompt.
- Why it matters: Less repeated context loading, fewer contradictory changes, and better continuity across handoffs.

### 2) Lessons: Turn Incidents Into Reusable Team Practice

Lessons are project-level learnings persisted in `.codemate/lessons.md`, so failures become guidance instead of repeating.

- What it does: Captures actionable lessons from failed runs, merges/refines them with `lesson_write`, and loads them back into future sessions as project context.
- When to use it: Release pipelines, recurring operational tasks, or any workflow where the same mistakes can happen again.
- Example: A deploy fails because a migration step was skipped. The team records a lesson: "Run schema check before deploy." Future release tasks now include that guardrail automatically.
- Why it matters: Your process improves run by run, not just person by person.

### 3) Self-check: Verify Before You Ship

Self-check is a built-in verification gate that runs checks, reports failures clearly, and supports fix-and-rerun loops before final output.

- What it does: Runs default JS/TS checks (typecheck, lint, test where applicable) and also supports custom command checks for other stacks (`pytest`, `go test`, `cargo test`, etc.).
- When to use it: Refactors, dependency upgrades, CI-sensitive paths, or any change where "probably works" is not enough.
- Example: A TypeScript refactor passes local smoke testing, but `selfcheck` catches a lint rule regression and one failing unit test. Both are fixed before handoff, avoiding a broken PR cycle.
- Why it matters: Fewer "done locally, failed in CI" surprises and more reliable delivery quality.

### 4) Deep Research: Structured Decisions Under Uncertainty

Deep Research provides a step-by-step research workflow, from defining questions to producing a decision-ready report.

- What it does: Creates research outlines, adds items/fields, runs deeper research tasks, and compiles a report with source-backed findings and uncertainty handling.
- When to use it: Vendor selection, architecture tradeoffs, compliance/policy interpretation, or fast-changing external dependencies.
- Example: Before choosing a vector database, the team compares ingestion throughput, region availability, pricing model, and migration risk, then receives a structured report with evidence and explicit unknowns.
- Why it matters: Better decisions when stakes are high and information is incomplete.

## Comparison

| Dimension      | Compared with OPENCODE                                                                 | Compared with Claude Code                                               |
| -------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Runtime shape  | Active runtime is consolidated in `packages/codemate/src/*` with integrated subsystems | Fully open-source runtime that can be inspected and modified end-to-end |
| Memory model   | Built-in persistent memory + retrieval + lifecycle                                     | Stronger project continuity across sessions                             |
| Learning loop  | Native lessons workflow (`.codemate/lessons.md` + `lesson_write`)                      | More explicit institutional learning in daily workflows                 |
| Verification   | First-class self-check tool with structured failure loops                              | More controllable verification path before final output                 |
| Research depth | Dedicated research toolchain (`research-*`, `websearch`, `webfetch`)                   | Better fit for high-uncertainty engineering decisions                   |
| Model strategy | Provider-agnostic by design                                                            | Not tied to a single vendor path                                        |

## Contributing

> [!IMPORTANT]
> Before pushing changes, run checks from package directories (do not run tests from repo root).

Please read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a PR.
Chinese version: [CONTRIBUTING.zh.md](./CONTRIBUTING.zh.md).

---
