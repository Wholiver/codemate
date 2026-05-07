<pre align="center">
 ███   ███  ████  █████ █   █  ███  █████ █████
█     █   █ █   █ █     ██ ██ █   █   █   █
█     █   █ █   █ ████  █ █ █ █████   █   ████
█     █   █ █   █ █     █   █ █   █   █   █
 ███   ███  ████  █████ █   █ █   █   █   █████
</pre>

<div align="center">

### Open-source coding agent for long-horizon engineering

**Memory-first. Learning-enabled. Verification-driven. Research-native.**

[![Discord](https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord)](https://codemate.ai/discord)
[![Build status](https://img.shields.io/github/actions/workflow/status/Wholiver/codemate/publish.yml?style=flat-square&branch=dev)](https://github.com/Wholiver/codemate/actions/workflows/publish.yml)
[![JSR](https://img.shields.io/badge/JSR-@codemate/codemate-00bcd4?style=flat-square)](https://jsr.io/@codemate/codemate)

<sub><a href="README.md">English</a> · <a href="README.zh.md">简体中文</a></sub>

</div>

[![Codemate Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://codemate.ai)

---

<p align="center"><strong>See it fast:</strong> <a href="#30-second-value">30-second value</a> · <a href="#core-features">core features</a> · <a href="#architecture-at-a-glance">architecture</a> · <a href="#comparison">comparison</a> · <a href="#install-jsr">install</a></p>

## 30-Second Value

Codemate is built for teams that need reliable output over many sessions, not only clever answers in one session.

| Pillar | Built-in capability | What changes in real work |
| --- | --- | --- |
| Memory | Persistent memory with structured retrieval | Decisions, patterns, and fixes survive across sessions |
| Lessons | `.codemate/lessons.md` + `lesson_write` loop | Mistakes become reusable team knowledge |
| Self-check | `selfcheck` with default + custom checks | Fewer "looks done" failures |
| Deep research | `research-*` + `websearch` + `webfetch` | Better decisions under uncertainty |
| Unified runtime | MCP + LSP + ACP in one core | Consistent behavior across CLI/TUI/Web |

## What You Get On Day 1

| Outcome | How Codemate achieves it |
| --- | --- |
| Fewer repeated mistakes | Lessons are written after execution and loaded back into context |
| Better project continuity | Memory stores durable context beyond chat history |
| Safer delivery | Self-check runs before final handoff |
| Stronger technical decisions | Deep research toolchain gathers and structures evidence |

## Core Features

### 1) Memory: Ultra-Long Project Memory

Module: `packages/codemate/src/memory/*`

- Structured record model: `domain / path / version`
- Tools: `memory_create`, `memory_search`, `memory_read`, `memory_list`
- Retrieval modes: `keyword`, `semantic`, `hybrid`
- Lifecycle: vitality scoring, cleanup/decay, dedup and ranking

Why this matters:

- Architecture decisions and debugging wins remain searchable months later.
- High-context tasks stop restarting from zero.

### 2) Lessons: Built-In Self-Learning

Core file: `.codemate/lessons.md`  
Write tool: `lesson_write`

- Lessons are written after meaningful execution.
- Lessons are injected back into future sessions via `<project-lessons>`.
- Typical lesson payload:
  - failure mode and prevention
  - dead ends and why they failed
  - key discovery and final decision

Why this matters:

- The agent adapts to your team style over time.
- Known pitfalls become explicit and avoidable.

### 3) Self-check: Verification Before Final Output

Tool: `packages/codemate/src/tool/selfcheck.ts`

- Default JS/TS checks: `typecheck`, `lint`, `test`
- Custom checks supported (example): `pytest`, `go test ./...`, `cargo test`
- Failure loop: capture context -> update lessons/changelog -> re-research -> re-verify

Why this matters:

- Reliability is enforced as a workflow step, not left to chance.
- Complex multi-file changes are safer to ship.

### 4) Deep Research: Research-Native Workflow

Toolchain:

- `research`
- `research-add-items`
- `research-add-fields`
- `research-deep`
- `research-report`

`research-deep` supports:

- multi-item investigation plans
- field-based extraction
- uncertainty marking
- source-oriented collection and reporting

Why this matters:

- Better for migrations, vendor APIs, and fast-changing surfaces.
- Reduces assumption-driven implementation risk.

## Architecture At A Glance

```text
User Request
   -> Planner / Session Loop
      -> Memory (create/search/read/list)
      -> Research (research-*)
      -> Tool Execution (code/shell/MCP)
      -> Self-check (verify)
      -> Lessons Write-back (.codemate/lessons.md)
```

Codemate is designed as a compounding loop: each run can improve the next run.

## Workflow Loop

1. Understand the goal and constraints.
2. Pull relevant memory.
3. Run deep research for uncertain topics.
4. Implement with project-aware tools.
5. Run self-check.
6. Persist lessons and memory updates.

## Comparison

| Dimension | Compared with OPENCODE | Compared with Claude Code |
| --- | --- | --- |
| Runtime shape | Active runtime is consolidated in `packages/codemate/src/*` with integrated subsystems | Fully open-source runtime that can be inspected and modified end-to-end |
| Memory model | Built-in persistent memory + retrieval + lifecycle | Stronger project continuity across sessions |
| Learning loop | Native lessons workflow (`.codemate/lessons.md` + `lesson_write`) | More explicit institutional learning in daily workflows |
| Verification | First-class self-check tool with structured failure loops | More controllable verification path before final output |
| Research depth | Dedicated research toolchain (`research-*`, `websearch`, `webfetch`) | Better fit for high-uncertainty engineering decisions |
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
