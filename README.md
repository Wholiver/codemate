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

## One-Glance Overview

Codemate is not just "a CLI that calls a model". It is a runtime that combines:

- **Ultra-long memory** across sessions
- **Project learning loops** through lessons
- **Built-in self-check before final output**
- **Deep web research workflow** for hard tasks
- **Integrated MCP + LSP + ACP** in one core

If you want an agent that gets better over time on your real project, this is what Codemate is optimized for.

## Core Capabilities (What You Built)

### 1) Memory: Ultra-Long Project Memory

Memory is a first-class system in Codemate (`packages/codemate/src/memory/*`), not a bolt-on note pad.

- Persistent memory records with **domain/path/version**
- Memory APIs exposed as tools:
  - `memory_create`
  - `memory_search`
  - `memory_read`
  - `memory_list`
- `memory_search` supports:
  - `keyword`
  - `semantic`
  - `hybrid` (recommended)
- Memory quality lifecycle includes:
  - vitality scoring
  - decay / cleanup
  - dedup and retrieval ranking signals
- Session prompts explicitly encourage durable writes for substantive work, so important context survives beyond one chat.

What this means for users:

- "Don’t forget what we decided last week" is practical, not aspirational.
- Architecture choices, debugging outcomes, and user preferences are reusable context.

### 2) Lessons: Built-In Self-Learning

Codemate treats learning as an operational loop, not an afterthought.

- Project lessons are stored in `.codemate/lessons.md`
- `lesson_write` updates lessons after meaningful task execution
- Lessons are loaded back into context via `<project-lessons>` prompt injection
- Lesson guidance focuses on:
  - errors and how to avoid them
  - wrong paths / detours and how to avoid repeat
  - key discoveries and final decisions

What this means for users:

- Repeated mistakes drop over time.
- Team-specific patterns become institutional knowledge inside the agent flow.

### 3) Self-Check: Verification Before Final Answer

Codemate includes a dedicated `selfcheck` tool (`packages/codemate/src/tool/selfcheck.ts`).

- Default JS/TS checks:
  - `typecheck`
  - `lint`
  - `test`
- Custom verification commands are supported for non-JS stacks
  - examples: `pytest`, `go test ./...`, `cargo test`
- Failure handling is designed as a loop:
  - record durable failure context
  - update lessons/changelog
  - re-run research and validate again

What this means for users:

- Fewer "looks done but actually broken" outcomes.
- Better reliability when tasks get complex.

### 4) Deep Search: Research-Native Workflow

Codemate ships a research pipeline instead of generic "search once" behavior.

- Dedicated deep research tools:
  - `research`
  - `research-add-items`
  - `research-add-fields`
  - `research-deep`
  - `research-report`
- `research-deep` is designed for structured investigation:
  - multi-item outlines
  - field-driven extraction
  - uncertainty marking
  - citation-oriented collection flow
- Web data collection tools (`websearch`, `webfetch`, optional Exa path) are part of the runtime tool surface.

What this means for users:

- Better results on ambiguous tasks (new APIs, vendor behavior, migration risks, integration decisions).
- More traceable reasoning versus ad-hoc guessing.

## How a Real Task Flows

1. Understand goal and constraints
2. Pull relevant long-term memory
3. Do deep research when facts may be stale or uncertain
4. Implement with project-aware tools
5. Run self-check
6. Write back lessons + memory so the next task starts smarter

This is the key difference: **Codemate is designed as a continuous improvement loop, not a one-shot responder.**

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
