<div align="center">

<p align="center">
  <img src="./packages/docs/logo/codemate-ascii.svg" alt="Codemate" width="1200" />
</p>

<p align="center"><strong>A multi-agent coding assistant for real repositories.</strong></p>

<p align="center">Built around closed-loop verification, role specialization, and layered memory for long-running engineering tasks.</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-green.svg" alt="License MIT" /></a>
  <img src="https://img.shields.io/badge/runtime-Bun-000?logo=bun" alt="runtime Bun" />
  <img src="https://img.shields.io/badge/language-TypeScript-3178C6?logo=typescript&logoColor=white" alt="language TypeScript" />
</p>

<p align="center"><a href="./README.en.md">简体中文</a> | <a href="./docs/codemate-self-study-architecture.md">Self-study architecture</a> | <a href="./CONTRIBUTING.md">Contributing</a> | <a href="./LICENSE">License</a></p>
<p align="center"><sub>Special thanks to opencode — Codemate is developed on top of it.</sub></p>

<p align="center">
  <img src="./packages/docs/images/readme-links-divider.png" alt="README divider" width="900" />
</p>

</div>

## Why Codemate?

- **Not a single-agent free run**: work is decomposed into a TaskGraph by `planner`.
- **Not just code generation**: `research / coder / tester / reviewer` collaborate by role.
- **Not done-and-forgotten**: `writer` closes the loop with changelog + lessons.
- **Not drift-prone**: `intent anchor`, `selfcheck`, `retry`, and `drift check` keep execution aligned.

## Install & Run

### Install CLI From npm

> Requires Bun `1.3.13` or newer in `PATH` to run `codemate` (installation via npm still uses Node/npm).

```bash
npm install -g @codemate-ai/cli
codemate --version
codemate
```

### Run From Source (Development)

> Repository development also requires Bun `1.3.13` (see `packageManager` in root `package.json`).

```bash
bun install
bun dev
```

Optional commands (repo root):

```bash
bun typecheck
bun dev:web
bun dev:desktop
```

## Core Capabilities

<img src="./packages/docs/images/readme-capabilities-grid.svg" alt="Codemate core capabilities" width="100%" />

## Agent Roles

| Agent | Responsibility | Main inputs | Main outputs |
|---|---|---|---|
| Orchestrator | Control and scheduling | User request, context | Scheduling decisions |
| Planner | Task decomposition | Intent anchor, context | TaskGraph |
| Research | Research and evidence | Subtask, context | Research drafts |
| Coder | Implementation | TaskGraph node | Code changes |
| Tester | Validation and tests | Requirements, target implementation | Test results |
| Reviewer | Review and acceptance | Coder/tester outputs | Review result |
| Writer | Persistence finalization | Completed subtasks, diff/fallback, research drafts | Changelog / lessons |

## Memory & Persistence

- **supermemory**: local long-term memory, no external Supermemory API dependency.
  - Supports `add/search/list/profile/forget/help`.
  - Explicit memory instructions (`remember` / `save this`) can be saved at any step.
  - Memory context is injected only at `step===1` to avoid prompt bloat.
- **lessons**: reusable engineering learnings and guardrails.
  - `writer` reads only project lessons, not global lessons.
- **changelog**: recent project history.
  - Historical context only, not instructions.
  - Recent changelog is injected into `orchestrator / planner / coder / tester / reviewer`, not into `writer / research`.
- **writer finalizer rules**:
  - `writer` is a persistence finalizer, not a normal TaskGraph execution node.
  - If `completedSubtasks > 0`, writer must not no-op just because git diff is empty.

## Workflow

```mermaid
flowchart TD
  request[User Request] --> orchestrator[Orchestrator]
  orchestrator --> planner[Planner]
  planner --> task_graph[TaskGraph]
  task_graph --> scheduler[Dependency Scheduler]

  subgraph parallel[Parallel Execution]
    research[Research]
    coder[Coder]
    tester[Tester]
  end

  scheduler --> research
  scheduler --> coder
  scheduler --> tester

  research --> reviewer[Reviewer]
  coder --> reviewer
  tester --> reviewer

  reviewer --> selfcheck[Selfcheck]
  selfcheck -->|pass| writer[Writer]
  selfcheck -->|fail| retry_loop[Retry Loop max 5]
  retry_loop -->|retry| scheduler

  writer --> persistence[Persist: lessons / changelog / supermemory]

  subgraph notes[System Notes]
    preload_note[Context preload: lessons / memory / changelog]
    write_note[Lesson system: write at task end]
    drift_note[Intent drift check: every 5 subtasks]
  end

  preload_note --> orchestrator
  writer --> write_note
  scheduler --> drift_note
```

## Testing

```bash
cd packages/codemate
bun typecheck
bun test test/session/prompt.test.ts
bun test test/tool/supermemory.test.ts
```

Optional full run:

```bash
cd packages/codemate
bun test
```

## Current Status

- Codemate is a multi-agent closed-loop system for real repository work.
- The project is actively evolving and does not claim full autonomy or perfect correctness.

## Contributing

Read first:

- [CONTRIBUTING.md](./CONTRIBUTING.md)
- [CONTRIBUTING.zh.md](./CONTRIBUTING.zh.md)

Do not commit:

- `.codemate` runtime artifacts
- temporary certificates or private keys
- token / API key
- local machine-specific absolute paths

## License

[MIT](./LICENSE)
