<div align="center">

# Codemate

**A TaskGraph-driven multi-agent coding assistant.**

Built around closed-loop verification, role separation, and layered memory for long-running coding tasks in real repositories.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
![Bun](https://img.shields.io/badge/runtime-Bun-000?logo=bun)
![TypeScript](https://img.shields.io/badge/language-TypeScript-3178C6?logo=typescript&logoColor=white)

[中文](./README.md) · [Contributing](./CONTRIBUTING.md) · [License](./LICENSE)

</div>

## Why Codemate?

- **Not a single agent running blindly**: work is decomposed by `planner` into a TaskGraph.
- **Not just code generation**: `research / coder / tester / reviewer` collaborate with separated roles.
- **Not "done and forgotten"**: `writer` finalizes persistence with changelog and lessons.
- **Not uncontrolled drift**: `intent anchor`, `selfcheck`, retry loops, and drift checks keep execution aligned.

## Key Features

| Feature | What it means |
|---|---|
| TaskGraph execution | `planner` emits dependency-aware task graphs |
| Multi-agent roles | `orchestrator / planner / research / coder / tester / reviewer / writer` split responsibilities |
| Closed-loop verification | selfcheck, retries, and drift checks reduce execution drift |
| Layered context | `supermemory`, `lessons`, and `changelog` have distinct roles |
| Persistence finalizer | `writer` performs end-of-loop changelog and lesson persistence |

## Workflow

```text
User request
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

Terminal-style view:

```text
$ bun dev
CODEMATE

orchestrator → planner → coder/tester → reviewer → writer
```

## Agents

| Agent | Responsibility | Primary inputs | Primary outputs |
|---|---|---|---|
| Orchestrator | Main control and scheduling | User request, context | Scheduling decisions |
| Planner | Task decomposition | Intent anchor, context | TaskGraph |
| Research | Environment/evidence gathering | Task node, context | Research drafts |
| Coder | Implementation | TaskGraph node | Code changes |
| Tester | Testing and validation | Requirements, implementation target | Test results |
| Reviewer | Review and acceptance | Coder/tester outputs | Review result |
| Writer | Persistence finalization | Completed subtasks, diff/fallback, research drafts | Changelog / lessons |

## Memory and Persistence

- **supermemory**: local long-term memory implementation, no external Supermemory API dependency.
  - Supports `add/search/list/profile/forget/help`.
  - Explicit remember-style instructions can be written at any step.
  - Memory context injection remains step-1 only (`step===1`) to avoid prompt bloat.
- **lessons**: reusable engineering practices and guardrails.
  - `writer` reads project lessons only, not global lessons.
- **changelog**: recent project history.
  - Historical context only, not instructions.
  - Recent changelog is injected into `orchestrator / planner / coder / tester / reviewer`, not `writer / research`.
- **writer finalizer rules**:
  - `writer` is a persistence finalizer, not a normal TaskGraph execution node.
  - If `completedSubtasks > 0`, writer must not no-op only because git diff is empty.

## Installation

> Bun `1.3.13` is required (see root `package.json` `packageManager`).

```bash
bun install
bun dev
```

Optional workspace commands (repo root):

```bash
bun typecheck
bun dev:web
bun dev:desktop
```

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

## Project Status

- Codemate is a multi-agent closed-loop coding system for real repositories.
- It is actively evolving and does not claim perfect correctness or full autonomous software engineering.

## Contributing

Please read:

- [CONTRIBUTING.md](./CONTRIBUTING.md)
- [CONTRIBUTING.zh.md](./CONTRIBUTING.zh.md)

Do not commit:

- `.codemate` runtime artifacts
- temporary certificates or private keys
- tokens / API keys
- local absolute machine paths

## License

[MIT](./LICENSE)
