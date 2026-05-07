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
- [Workflow Loop](#workflow-loop)
- [Comparison](#comparison)
- [Install (JSR)](#install-jsr)

## 30-Second Value

Codemate is an agent runtime focused on **continuity and reliability**, not just one-shot answers.

| Pillar | Built-in capability | Why it matters |
| --- | --- | --- |
| Memory | Persistent memory with searchable records | Keeps decisions, patterns, and user preferences across sessions |
| Lessons | `.codemate/lessons.md` + `lesson_write` loop | Converts mistakes and discoveries into reusable project knowledge |
| Self-check | `selfcheck` with default and custom verification | Catches "looks done but broken" before final output |
| Deep research | `research-*` + `websearch`/`webfetch` | Produces stronger outcomes for high-uncertainty tasks |
| Integrated runtime | MCP + LSP + ACP in one core | Reduces glue code and improves cross-interface consistency |

If you want an agent that gets **smarter on your actual codebase over time**, this is the operating model.

## Core Features

### Memory: Ultra-Long Project Memory

First-class module: `packages/codemate/src/memory/*`

- Structured memory records: `domain / path / version`
- Tooling surface:
  - `memory_create`
  - `memory_search`
  - `memory_read`
  - `memory_list`
- Retrieval modes:
  - `keyword`
  - `semantic`
  - `hybrid` (recommended)
- Lifecycle signals:
  - vitality scoring
  - decay / cleanup
  - dedup and ranking support

User impact:

- Keeps architecture decisions and debugging wins available for future tasks.
- Turns "we already solved this" into reusable context instead of manual recall.

### Lessons: Built-In Self-Learning

Core file: `.codemate/lessons.md`  
Write tool: `lesson_write`

- Lessons are written after meaningful execution.
- Lessons are reloaded into context via `<project-lessons>`.
- Lesson entries focus on:
  - errors and prevention
  - detours and avoidance
  - discoveries and final decisions

User impact:

- Reduces repeated mistakes.
- Captures team-specific engineering habits inside the agent loop.

### Self-check: Verification Before Final Answer

Tool: `packages/codemate/src/tool/selfcheck.ts`

- Default JS/TS checks:
  - `typecheck`
  - `lint`
  - `test`
- Custom verification commands for non-JS stacks:
  - `pytest`
  - `go test ./...`
  - `cargo test`
- On failure, the loop is explicit:
  - record failure context
  - update lessons/changelog
  - re-research and re-verify

User impact:

- Fewer silent regressions.
- Better delivery quality under complex task conditions.

### Deep Research: Research-Native Workflow

Tools:

- `research`
- `research-add-items`
- `research-add-fields`
- `research-deep`
- `research-report`

`research-deep` supports structured investigation:

- multi-item outlines
- field-driven extraction
- uncertainty marking
- citation-oriented collection flow

Combined with `websearch` and `webfetch`, this gives Codemate a practical research pipeline instead of shallow "search once" behavior.

User impact:

- Better decisions for evolving APIs, migrations, and vendor-specific behavior.
- More traceable reasoning and fewer assumption-based fixes.

## Workflow Loop

1. Understand goal and constraints
2. Retrieve relevant memory
3. Run deep research when needed
4. Implement with project-aware tools
5. Run self-check
6. Persist lessons and memory updates

**Codemate is built as a continuous improvement loop, not a single-turn responder.**

## Comparison

| Dimension | Compared with OPENCODE | Compared with Claude Code |
| --- | --- | --- |
| Runtime shape | Current active runtime is consolidated in `packages/codemate/src/*` with integrated subsystems | Fully open-source runtime that can be inspected and modified end-to-end |
| Memory model | Built-in persistent memory + retrieval + lifecycle (not just prompt history) | Stronger cross-session continuity and project-specific recall |
| Learning loop | Native lessons workflow (`.codemate/lessons.md` + `lesson_write`) | More explicit institutional learning inside agent operations |
| Verification | First-class self-check tool with structured failure loops | More controllable verification path before final output |
| Research depth | Dedicated research toolchain (`research-*`, `websearch`, `webfetch`) | Better suited for high-uncertainty, decision-heavy engineering tasks |
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
