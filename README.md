<pre align="center">
 ███   ███  ████  █████ █   █  ███  █████ █████
█     █   █ █   █ █     ██ ██ █   █   █   █
█     █   █ █   █ ████  █ █ █ █████   █   ████
█     █   █ █   █ █     █   █ █   █   █   █
 ███   ███  ████  █████ █   █ █   █   █   █████
</pre>

<p align="center"><strong>Open-source coding agent built for ultra-long memory, self-learning, self-check, and deep research.</strong></p>

<p align="center">
  <a href="https://codemate.ai/discord"><img alt="Discord" src="https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord" /></a>
  <a href="https://github.com/Wholiver/codemate/actions/workflows/publish.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/Wholiver/codemate/publish.yml?style=flat-square&branch=dev" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a>
</p>

[![Codemate Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://codemate.ai)

---

## Quick Navigation

- [30-Second Value](#30-second-value)
- [Core Features](#core-features)
- [Architecture At A Glance](#architecture-at-a-glance)
- [Workflow Loop](#workflow-loop)
- [Comparison](#comparison)
- [Install (JSR)](#install-jsr)

## 30-Second Value

Codemate is not optimized for one-shot responses. It is optimized for continuous engineering outcomes.

| Pillar | Built-in capability | Why it matters in real work |
| --- | --- | --- |
| Memory | Persistent memory with searchable records | Keeps architecture decisions, preferences, and debug wins across sessions |
| Lessons | `.codemate/lessons.md` + `lesson_write` | Turns mistakes and discoveries into reusable project knowledge |
| Self-check | `selfcheck` with default + custom verification | Catches "looks done but broken" before final delivery |
| Deep research | `research-*` + `websearch` + `webfetch` | Supports high-uncertainty technical decisions with source-backed investigation |
| Unified runtime | MCP + LSP + ACP in one core | Keeps CLI/TUI/Web behavior consistent and reduces integration friction |

What this means for teams:

- The agent gets stronger on your codebase over time.
- High-context tasks stop starting from zero each session.
- Reliability comes from built-in verification loops, not luck.

## Core Features

### Memory: Ultra-Long Project Memory

First-class module: `packages/codemate/src/memory/*`

- Structured record model: `domain / path / version`
- Tooling surface:
  - `memory_create`
  - `memory_search`
  - `memory_read`
  - `memory_list`
- Retrieval modes:
  - `keyword`
  - `semantic`
  - `hybrid` (recommended)
- Lifecycle support:
  - vitality scoring
  - decay and cleanup
  - dedup and ranking

Why it matters:

- Important implementation context survives across long projects.
- Repeated architecture and debugging discussions become reusable assets.

### Lessons: Built-In Self-Learning

Core file: `.codemate/lessons.md`  
Write tool: `lesson_write`

- Lessons are written after meaningful execution.
- Lessons are reloaded into context via `<project-lessons>`.
- Entries focus on:
  - errors and prevention
  - failed detours and why
  - discoveries and final decisions

Why it matters:

- The same class of mistakes appears less often over time.
- Team-specific engineering habits become explicit and reusable.

### Self-check: Verification Before Final Answer

Tool: `packages/codemate/src/tool/selfcheck.ts`

- Default JS/TS checks:
  - `typecheck`
  - `lint`
  - `test`
- Custom checks for other stacks:
  - `pytest`
  - `go test ./...`
  - `cargo test`
- Failure loop:
  - capture failure context
  - update lessons/changelog
  - re-research and re-verify

Why it matters:

- Fewer silent regressions in production tasks.
- Better confidence when shipping multi-step changes.

### Deep Research: Research-Native Workflow

Toolchain:

- `research`
- `research-add-items`
- `research-add-fields`
- `research-deep`
- `research-report`

`research-deep` enables:

- multi-item investigation outlines
- field-driven extraction
- uncertainty marking
- citation-oriented collection flow

With `websearch` and `webfetch`, Codemate supports deep research workflows instead of shallow single-query behavior.

Why it matters:

- Better choices for evolving APIs, migrations, and vendor-specific behavior.
- Less assumption-driven implementation risk.

## Architecture At A Glance

```text
User Request
   -> Planner / Session Loop
      -> Memory (create/search/read/list)
      -> Research (research-*)
      -> Tool Execution (code, shell, MCP)
      -> Self-check (verify)
      -> Lessons Write-back (.codemate/lessons.md)
```

Codemate keeps these systems connected so each iteration improves the next one.

## Workflow Loop

1. Understand goal and constraints.
2. Retrieve relevant memory.
3. Run deep research when uncertainty is high.
4. Implement with project-aware tooling.
5. Run self-check.
6. Persist lessons and memory updates.

Codemate is built as a continuous improvement loop, not a single-turn responder.

## Comparison

| Dimension | Compared with OPENCODE | Compared with Claude Code |
| --- | --- | --- |
| Runtime shape | Active runtime is consolidated in `packages/codemate/src/*` with integrated subsystems | Fully open-source runtime that can be inspected and modified end-to-end |
| Memory model | Built-in persistent memory + retrieval + lifecycle (not only prompt history) | Stronger project continuity across sessions |
| Learning loop | Native lessons workflow (`.codemate/lessons.md` + `lesson_write`) | More explicit institutional learning inside daily operations |
| Verification | First-class self-check tool with structured failure loops | More controllable verification path before final output |
| Research depth | Dedicated research toolchain (`research-*`, `websearch`, `webfetch`) | Better fit for high-uncertainty decision-heavy engineering tasks |
| Model strategy | Provider-agnostic by design | Not tied to a single vendor path |

## Install (JSR)

```bash
# npm / bun / older pnpm/yarn
npx jsr add @codemate/codemate

# or
bunx jsr add @codemate/codemate
pnpm dlx jsr add @codemate/codemate
yarn dlx jsr add @codemate/codemate
```

- Package: https://jsr.io/@codemate/codemate
- Docs: https://codemate.ai/docs

## Contributing

Please read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a PR.

---

**Community**: [Discord](https://discord.gg/codemate) · [X](https://x.com/codemate)
