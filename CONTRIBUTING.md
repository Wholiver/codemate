# Contributing to Codemate

<sub>English · <a href="./CONTRIBUTING.zh.md">简体中文</a></sub>

Thanks for helping improve Codemate. Small, clear PRs are the fastest way to get changes merged.

## 1. Development Setup

### Prerequisites

- Bun (runtime/package manager)
- Git
- A GitHub account

Check your Bun version:

```bash
bun --version
```

### Install and run

```bash
bun install
bun dev
```

Main package for core agent/session work:

```bash
cd packages/codemate
```

## 2. Project Structure

Top-level directories you will touch most:

- `packages/codemate/`: main Codemate package (agent, session loop, tools, tests)
- `packages/app/`: app frontend
- `packages/core/`: shared core logic
- `packages/sdk/js/`: JavaScript SDK
- `packages/docs/`: docs assets and supporting docs content
- `script/`: repo-level automation scripts

Inside `packages/codemate/`:

- `src/`: implementation
- `test/`: tests
- `migration/`: database migrations
- `script/`: package-level scripts

## 3. Development Workflow

### Branching

- Base branch is `dev`
- Do not open PRs against `main`
- Create a short-lived branch from `dev`

```bash
git checkout dev
git pull origin dev
git checkout -b feat/your-change
```

### Commit style

Use conventional commit prefixes:

- `feat: ...`
- `fix: ...`
- `docs: ...`
- `refactor: ...`
- `test: ...`
- `chore: ...`

Example:

```bash
git commit -m "fix: prevent planner node from entering execution queue"
```

### Pull request flow

1. Keep scope focused
2. Run checks locally
3. Push your branch
4. Open PR to `dev`
5. Add clear verification notes (what you ran, what passed)
6. Add screenshots for UI changes

## 4. Code Quality Rules

Run checks before opening a PR.

Lint:

```bash
cd packages/codemate
bun lint
```

Type check:

```bash
cd packages/codemate
bun typecheck
```

Notes:

- Codemate code is TypeScript + Bun
- Keep changes small and readable
- Follow existing patterns in nearby files

## 5. Testing Requirements

Minimum test command:

```bash
cd packages/codemate
bun test
```

Run targeted tests if your change is scoped.

## 6. Issue Guidelines

### Bug report

Please include:

- What happened
- What you expected
- Repro steps
- Environment (OS, Bun version, package path)
- Logs/error output

Template:

```md
## Bug
Short description

## Repro
1. ...
2. ...

## Expected
...

## Actual
...

## Environment
- OS:
- Bun:
- Package:
```

### Feature request

Please include:

- Problem statement
- Proposed behavior
- Why it helps
- Optional alternatives considered

Template:

```md
## Problem
...

## Proposal
...

## Value
...
```
