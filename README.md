<p align="center">
  <img src="packages/web/src/assets/lander/readme-banner.svg" alt="Codemate" />
</p>

<div align="center">

### Open-source coding agent for long-horizon engineering

**Memory-first. Learning-enabled. Verification-driven. Research-native.**

[![Build status](https://img.shields.io/github/actions/workflow/status/Wholiver/codemate/publish.yml?style=flat-square&branch=dev)](https://github.com/Wholiver/codemate/actions/workflows/publish.yml)
[![JSR](https://img.shields.io/badge/JSR-@codemate/codemate-00bcd4?style=flat-square)](https://jsr.io/@codemate/codemate)

_Built on top of OPENCODE, with sincere thanks to the OPENCODE team and community._

<sub><a href="README.md">English</a> · <a href="README.zh.md">简体中文</a></sub>

</div>

[![Codemate Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://codemate.ai)

---

<p align="center"><strong>See it fast:</strong> <a href="#30-second-value">30-second value</a> · <a href="#install-global-cli">install</a> · <a href="#architecture-at-a-glance">architecture</a> · <a href="#core-features">core features</a> · <a href="#comparison">comparison</a></p>

## 30-Second Value

Codemate is built for teams that need reliable output over many sessions, not only clever answers in one session.

| Pillar          | Built-in capability                          | What changes in real work                              |
| --------------- | -------------------------------------------- | ------------------------------------------------------ |
| Memory          | Persistent memory with structured retrieval  | Decisions, patterns, and fixes survive across sessions |
| Lessons         | `.codemate/lessons.md` + `lesson_write` loop | Mistakes become reusable team knowledge                |
| Self-check      | `selfcheck` with default + custom checks     | Fewer "looks done" failures                            |
| Deep research   | `research-*` + `websearch` + `webfetch`      | Better decisions under uncertainty                     |
| Unified runtime | MCP + LSP + ACP in one core                  | Consistent behavior across terminal and automation flows |

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

## SDK (Optional, JSR)

```bash
npx jsr add @codemate/codemate
```

- SDK package: https://jsr.io/@codemate/codemate

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

```text
Codemate Runtime
├─ 1. Input Layer
│  ├─ User request
│  ├─ Project context (repo/files/runtime state)
│  └─ Session history
├─ 2. Planning Layer
│  ├─ Goal decomposition
│  ├─ Constraint detection
│  └─ Execution strategy selection
├─ 3. Knowledge Layer
│  ├─ Memory System
│  │  ├─ write: memory_create
│  │  ├─ retrieve: memory_search / memory_read / memory_list
│  │  └─ retrieval modes: keyword / semantic / hybrid
│  └─ Lessons System
│     ├─ store: .codemate/lessons.md
│     ├─ write: lesson_write
│     └─ load: <project-lessons>
├─ 4. Research Layer
│  ├─ research
│  ├─ research-add-items
│  ├─ research-add-fields
│  ├─ research-deep
│  └─ research-report (+ websearch / webfetch)
├─ 5. Execution Layer
│  ├─ code edits
│  ├─ shell commands
│  └─ tool/MCP calls
├─ 6. Verification Layer
│  ├─ selfcheck
│  ├─ default checks: typecheck / lint / test
│  └─ custom checks: pytest / go test / cargo test ...
└─ 7. Feedback Loop
   ├─ record failures and fixes
   ├─ update lessons and memory
   └─ improve next run quality
```

Codemate is designed as a compounding loop: each run can improve the next run.

## Core Features

### 1) Memory: Ultra-Long Project Memory

Keep critical project context available across sessions.

- Use it when: work spans days or weeks and decisions need to stay consistent.
- Example: A team sets "SQLite for local mode, Postgres for cloud". A week later, migration work follows the same rule automatically.
- Value: Less repeated explanation and fewer regressions from forgotten context.

### 2) Lessons: Built-In Self-Learning

Turn mistakes and fixes into reusable team knowledge.

- Use it when: your team wants fewer repeated incidents across similar tasks.
- Example: A release fails due to a missing env variable. The next release flow includes an env preflight checklist before build.
- Value: Learning compounds at the project level instead of resetting every session.

### 3) Self-check: Verification Before Final Output

Verify before handoff, then fix and re-check until stable.

- Use it when: changes touch reliability-sensitive code paths.
- Example: During a refactor, it runs typecheck, lint, and tests; if lint fails, it fixes issues and re-runs checks before completion.
- Value: Fewer "looks done, but breaks in CI" outcomes.

### 4) Deep Research: Research-Native Workflow

Investigate uncertain decisions with a structured research flow.

- Use it when: requirements are ambiguous or external APIs and policies change quickly.
- Example: For two API vendors, it compares pricing, rate limits, migration cost, and risk, then outputs a decision brief.
- Value: Better decisions in migrations, vendor selection, and other high-uncertainty areas.

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

---

**Community**: [Discord](https://discord.gg/codemate) · [X](https://x.com/codemate)
