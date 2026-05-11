# Contributing to Codemate

<sub>English · <a href="./CONTRIBUTING.zh.md">简体中文</a></sub>

Thanks for contributing to Codemate.

Codemate is currently in **beta**, so we move fast and optimize for clear, reviewable changes.

## Quick Checklist

- Work from `dev` branch (default development branch).
- Keep changes focused and small.
- Run checks from package directories (never run tests from repo root).
- Open PRs with clear verification notes.

## Development Setup

```bash
bun install
bun dev
```

For local web app development:

```bash
bun run --cwd packages/codemate --conditions=browser ./src/index.ts serve --port 4096
bun --cwd packages/app dev -- --port 4444
```

## Branching

- Base branch for contributions: `dev`
- Do not target `main` directly.
- Use `dev` / `origin/dev` when generating diffs.

## Quality Gates

Run before opening a PR:

```bash
bun lint
bun typecheck
```

Run tests at package level only:

```bash
bun --cwd packages/codemate test
bun --cwd packages/app test:unit
bun --cwd packages/core test
```

Do not run tests from repo root (`bun test` at root is intentionally blocked).

## Code Generation and Migrations

Regenerate SDK/OpenAPI artifacts:

```bash
./script/generate.ts
```

Generate SQLite migrations:

```bash
bun --cwd packages/codemate run db generate --name <slug>
```

## Do Not Edit Generated Files

Examples:

- `packages/sdk/js/src/gen/*.ts`
- `packages/sdk/js/src/v2/gen/**/*.ts`
- `packages/codemate/src/provider/models-snapshot.js`
- `packages/codemate/src/provider/models-snapshot.d.ts`
- `packages/desktop/src/bindings.ts`
- `sst-env.d.ts`

Use generation scripts instead of manual edits.

## Commit and PR Requirements

PR titles and commit messages should follow conventional commit style:

- `feat: ...`
- `fix: ...`
- `docs: ...`
- `chore: ...`
- `refactor: ...`
- `test: ...`

Also required:

- Reference an issue (for example: `Fixes #123`).
- Include verification details (what commands you ran and results).
- Include screenshots/videos for UI changes.

## Review Expectations

- Prefer correctness over cleverness.
- Preserve existing behavior unless change is intentional and documented.
- Keep naming and structure consistent with surrounding code.

## Thank You

High-quality small PRs are the fastest way to move this project forward.
