# Codemate

> A multi-agent coding system built on TaskGraph orchestration, closed-loop verification, and layered memory.

[简体中文](./README.md)

## Overview

Codemate is a multi-agent coding system for real repositories, evolved from opencode.

It is not a single-agent "one prompt, one patch" CLI. Instead, responsibilities are separated:

- `orchestrator` controls the loop
- `planner` builds TaskGraph plans
- `research / coder / tester` execute research, implementation, and tests
- `reviewer` validates outcomes
- `writer` finalizes persistence

A closed-loop runtime (selfcheck, retry, drift detection) is used to improve stability on long-running tasks.

## Core Capabilities

### Multi-agent collaboration

Current primary roles:

- `orchestrator`
- `planner`
- `research`
- `coder`
- `tester`
- `reviewer`
- `writer`

Role separation reduces planning/implementation/review coupling inside a single agent step.

### TaskGraph closed-loop execution

- `planner` emits TaskGraph
- tasks execute through dependency edges
- `coder` and `tester` can run in parallel when dependencies allow
- `reviewer` runs after implementation and testing
- `writer` runs as persistence finalizer at the end

### Self-check, retry, and anti-drift controls

- `selfcheck` for unified verification
- retry loops for failed runs
- `intent anchor` for goal stability
- periodic `drift check` with correction flow

This prevents long tasks from drifting away from user intent.

### Three-layer context system

Codemate separates long-term and short-term context into three layers:

- `supermemory`: user preferences and long-term memory
- `lessons`: reusable engineering patterns and guardrails
- `changelog`: recent project history

Important boundaries:

- `writer` receives project lessons only (global lessons are excluded for safer persistence)
- changelog is historical context, not instruction
- recent changelog is injected only into `orchestrator / planner / coder / tester / reviewer`, not `writer / research`
- explicit memory commands (`remember`, `save this`, `记住`, etc.) can write at any step
- memory context injection remains step-1 only to avoid prompt growth

### Persistence Finalizer (Writer)

`writer` is not a regular TaskGraph worker:

- excluded from normal TaskGraph execution queue
- triggered in main-loop fallback phase
- writes changelog
- writes lessons via `lesson_classify` and `lesson_write`
- cannot no-op when `completedSubtasks > 0` even if git diff is empty

### TUI

- Terminal home branding uses `CODEMATE`
- Agent execution logs are visible in-session
- Closed-loop activity is observable in terminal workflow

## Architecture Flow

```text
User input
  ↓
Session / Prompt Builder
  ↓
Orchestrator
  ↓
Planner → TaskGraph
  ↓
Research / Coder / Tester
  ↓
Reviewer / Selfcheck / Retry
  ↓
Writer
  ↓
Changelog / Lessons / Supermemory
```

Execution summary:

1. Session layer assembles system prompt, history, and injected context.
2. Orchestrator decides whether to enter TaskGraph closed-loop mode.
3. Planner creates a dependency graph.
4. Research/Coder/Tester execute graph tasks, Reviewer validates quality.
5. Failures enter selfcheck/retry repair loops.
6. Writer performs final persistence.

## Agent Responsibilities

| Agent | Responsibility | Primary inputs | Primary outputs |
|---|---|---|---|
| Orchestrator | Main control and scheduling | User request, context | Scheduling decisions |
| Planner | Task decomposition | Intent anchor, context | TaskGraph |
| Research | Environment and evidence gathering | Task node, context | Research drafts |
| Coder | Implementation | TaskGraph node | Code changes |
| Tester | Test authoring and validation | Requirements, implementation target | Test results |
| Reviewer | Review and acceptance | Coder/tester outputs | Review result |
| Writer | Persistence finalization | Completed subtasks, diff/fallback, research drafts | Changelog / lessons |

## Memory and Persistence

- `.codemate/changelog.md`: recent project history (context only, not instructions)
- Project lessons: reusable project-scoped practices
- Global lessons: cross-project lessons (writer scope is intentionally narrowed)
- Supermemory: local long-term memory tool (supports `add/search/list/profile/forget/help`, plus explicit remember-style writes; no external Supermemory API dependency)

Boundary rules:

- lessons are reusable behavior rules
- changelog is recent historical record
- they should not be conflated

## Install and Run

> Bun `1.3.13` is required (see root `package.json` `packageManager`).

```bash
# install dependencies
bun install

# run codemate dev entry from repo root
bun dev
```

Common workspace commands (repo root):

```bash
bun typecheck
bun dev:web
bun dev:desktop
```

Package-level commands (`packages/codemate`):

```bash
cd packages/codemate
bun dev
bun typecheck
bun test
```

## Contributing

Please read:

- [CONTRIBUTING.md](./CONTRIBUTING.md)
- [CONTRIBUTING.zh.md](./CONTRIBUTING.zh.md)

Do not commit:

- `.codemate` runtime artifacts
- temporary certificates or private keys
- tokens / API keys
- local absolute machine paths

## Testing

```bash
cd packages/codemate
bun typecheck
bun test test/session/prompt.test.ts
bun test test/tool/supermemory.test.ts
```

Optional full test run:

```bash
cd packages/codemate
bun test
```

## License

[MIT](./LICENSE)
