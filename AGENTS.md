- To regenerate the JavaScript SDK, run `./packages/sdk/js/script/build.ts`.
- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.
- The default branch in this repo is `dev`.
- Local `main` ref may not exist; use `dev` or `origin/dev` for diffs.
- Prefer automation: execute requested actions without confirmation unless blocked by missing info or safety/irreversibility.

## AI Agent Quick Start

- **Goal:** Help AI coding agents get productive immediately with minimal context.
- **Bootstrap:** Run `bun install` then `bun dev` in the relevant package (`packages/codemate` for the CLI/server). See **Commands** below for variations.
- **Tests:** Do not run tests from the repo root (guarded by `bunfig.toml`). Run package-level tests (see **Commands** → `# Tests`).
- **Branching:** Default branch is `dev`. Use `dev` or `origin/dev` for diffs and PR targets.
- **Generated code:** Do not edit generated files (see **Generated Code (DO NOT EDIT)**). Use `./script/generate.ts` to regenerate artifacts.
- **Style & safety:** Prefer automated changes, use parallel tools where applicable, and avoid heavy edits without a clear failing test or issue reference.


## Repo Overview

Monorepo (Turborepo + Bun 1.3.13). AI-powered coding agent with TUI, web UI, and desktop apps.

**Key packages:**
- `packages/codemate` — CLI, server, TUI, core business logic (Effect v4 + Hono + Drizzle/SQLite)
- `packages/app` — Shared web UI (SolidJS + Vite + Tailwind v4)
- `packages/core` — Shared utilities (Effect, NPM, Git, FileSystem)
- `packages/sdk/js` — TypeScript SDK (auto-generated from OpenAPI)
- `packages/plugin` — Plugin SDK (`@codemate-ai/plugin`)
- `packages/ui` — UI component library (SolidJS)
- `packages/desktop` — Tauri desktop app (wraps `packages/app`)
- `packages/desktop-electron` — Electron desktop app (wraps `packages/app`)
- `packages/console/*` — Console web app + backend (SolidStart)
- `packages/web` — Marketing site (Astro)

## Commands

```bash
# Install
bun install

# Dev (run Codemate CLI locally)
bun dev                          # runs in packages/codemate dir
bun dev <directory>              # run against specific dir
bun dev .                        # run against repo root

# Dev servers
bun dev serve                    # headless API server (port 4096)
bun run --cwd packages/app dev  # web UI dev server

# Lint / Format / Typecheck
bun lint                         # oxlint (type-aware)
bun typecheck                    # turbo typecheck (runs tsgo in all packages)
bun run prettier --write .       # format (semi:false, printWidth:120)

# Tests (NEVER run from repo root — bunfig.toml guard)
bun --cwd packages/codemate test                        # codemate unit tests
bun --cwd packages/app test:unit                        # app unit tests
bun --cwd packages/app test:e2e:local                   # app e2e (Playwright + Chromium)
bun --cwd packages/core test                            # core unit tests
bun turbo test:ci                                       # all tests with JUnit reporter

# Build
./packages/codemate/script/build.ts --single            # standalone executable for current platform

# Code generation (SDK + OpenAPI + models snapshot)
./script/generate.ts                                     # runs SDK build + openapi export + format

# Database migrations (Drizzle + SQLite)
bun --cwd packages/codemate run db generate --name <slug>
```

**Command order matters:** `bun install` → `bun typecheck` → `bun test` (CI does `typecheck` and `test` in parallel).

## Testing

- Avoid mocks as much as possible; test actual implementation
- Tests cannot run from repo root (guard: `do-not-run-tests-from-root`); run from package dirs
- Use `await using tmp = await tmpdir()` from `test/fixture/fixture.ts` for temp dirs with auto-cleanup
- Use `testEffect(Layer)` from `test/lib/effect.ts` for Effect-based tests
- `it.effect(...)` uses TestClock/TestConsole; `it.live(...)` uses real OS behavior (most tests use `it.live`)
- Use `provideTmpdirInstance(...)` for tests needing a temp instance; `provideTmpdirServer(...)` for tests also needing the test LLM server
- Test directory structure mirrors `src/` — find tests at `test/<module>/<file>.test.ts`
- E2E tests use Playwright with Chromium; config at `packages/app/playwright.config.ts`

## Type Checking

- Always run `bun typecheck` from package directories or `bun turbo typecheck` from root
- Uses `tsgo` (TypeScript native preview), NOT `tsc` directly
- Each package has its own `tsconfig.json` — `packages/codemate` uses path aliases: `@/*` → `./src/*`, `@tui/*` → `./src/cli/cmd/tui/*`

## Style Guide

### General Principles

- Keep things in one function unless composable or reusable
- Avoid `try`/`catch` where possible
- Avoid using the `any` type
- Use Bun APIs when possible, like `Bun.file()`
- Rely on type inference when possible; avoid explicit type annotations or interfaces unless necessary for exports or clarity
- Prefer functional array methods (flatMap, filter, map) over for loops; use type guards on filter to maintain type inference downstream
- In `src/config`, follow the existing self-export pattern at the top of the file (for example `export * as ConfigAgent from "./agent"`) when adding a new config module.

Reduce total variable count by inlining when a value is only used once.

```ts
// Good
const journal = await Bun.file(path.join(dir, "journal.json")).json()

// Bad
const journalPath = path.join(dir, "journal.json")
const journal = await Bun.file(journalPath).json()
```

### Destructuring

Avoid unnecessary destructuring. Use dot notation to preserve context.

```ts
// Good
obj.a
obj.b

// Bad
const { a, b } = obj
```

### Variables

Prefer `const` over `let`. Use ternaries or early returns instead of reassignment.

```ts
// Good
const foo = condition ? 1 : 2

// Bad
let foo
if (condition) foo = 1
else foo = 2
```

### Control Flow

Avoid `else` statements. Prefer early returns.

```ts
// Good
function foo() {
  if (condition) return 1
  return 2
}

// Bad
function foo() {
  if (condition) return 1
  else return 2
}
```

### Schema Definitions (Drizzle)

Use snake_case for field names so column names don't need to be redefined as strings.

```ts
// Good
const table = sqliteTable("session", {
  id: text().primaryKey(),
  project_id: text().notNull(),
  created_at: integer().notNull(),
})

// Bad
const table = sqliteTable("session", {
  id: text("id").primaryKey(),
  projectID: text("project_id").notNull(),
  createdAt: integer("created_at").notNull(),
})
```

## Module Conventions (packages/codemate)

Do not use `export namespace Foo { ... }`. Use flat top-level exports with a self-reexport at the bottom:

```ts
// src/foo/foo.ts
export class Service extends Context.Service<Service, Interface>()("@codemate/Foo") {}
export const layer = Layer.effect(Service, ...)
export * as Foo from "./foo"
```

Consumers import the namespace projection: `import { Foo } from "@/foo/foo"`.

For `index.ts` files, use `export * as Foo from "."` (not `"./index"`).

Multi-sibling directories (e.g. `src/session/`, `src/config/`): no barrel `index.ts` — each sibling has its own self-reexport.

## Effect Rules (packages/codemate)

Detailed patterns in `packages/codemate/AGENTS.md` and `specs/effect/migration.md`. Key points:

- Use `Effect.gen(function* () { ... })` for composition
- Use `Effect.fn("Domain.method")` for named/traced effects; `Effect.fnUntraced` for internal helpers
- `Effect.fork`/`Effect.forkDaemon` do NOT exist in v4 beta — use `Effect.forkIn(scope)`
- Use `makeRuntime` (from `src/effect/run-service.ts`) for all services
- Use `InstanceState` (from `src/effect/instance-state.ts`) for per-directory state with cleanup
- Prefer Effect services (`FileSystem`, `ChildProcessSpawner`, `HttpClient`, `Path`, `Config`, `Clock`) over raw platform APIs
- Use `Schema.TaggedErrorClass` for typed errors; `Schema.Class` for multi-field data
- `Instance.bind(fn)` for native addon callbacks that need ALS context

## Database (packages/codemate)

- Schema: Drizzle + SQLite, files at `src/**/*.sql.ts`
- Migrations: `bun --cwd packages/codemate run db generate --name <slug>`
- Output: `migration/<timestamp>_<slug>/migration.sql` + `snapshot.json`
- Migration files are **denied from editing** in `.codemate/codemate.jsonc`
- Tests should read per-folder layout (no `_journal.json`)

## Generated Code (DO NOT EDIT)

- `packages/sdk/js/src/gen/*.ts` — generated by `@hey-api/openapi-ts`
- `packages/sdk/js/src/v2/gen/**/*.ts` — v2 SDK generated code
- `packages/codemate/src/provider/models-snapshot.js` — models.dev snapshot
- `packages/codemate/src/provider/models-snapshot.d.ts` — snapshot types
- `packages/desktop/src/bindings.ts` — Tauri bindings (in `.prettierignore`)
- `sst-env.d.ts` — SST environment types (in `.prettierignore`)
- `**/sdk.gen.ts` — ignored by oxlint

Regenerate with `./script/generate.ts` (runs SDK build + OpenAPI export + Prettier).

## Conditional Imports (packages/codemate)

The `#db`, `#pty`, `#hono` imports resolve conditionally via package.json `imports` field:
- `"bun"` condition → Bun-specific implementation
- `"node"` condition → Node-specific implementation
- Default → Bun implementation

## CI

- **test.yml**: Unit + E2E tests on Linux/Windows (Node 24, Bun). `bun turbo test:ci`.
- **typecheck.yml**: `bun typecheck` on PR and dev pushes.
- **generate.yml**: Runs `./script/generate.ts` on dev, auto-commits changes.
- **publish.yml**: Builds CLI binaries + Tauri/Electron desktop apps, publishes to npm/GitHub/AUR.
- **review.yml**: On `/review` comment, runs Codemate against PR for style guide compliance.

Pre-push hook (`.husky/pre-push`): validates Bun version matches `package.json` `packageManager` field, then runs `bun typecheck`.

## Linting

**oxlint** (`.oxlintrc.json`): type-aware, catches unhandled promises (`typescript/no-floating-promises: warn`), warns on non-plain object spreads. Ignores `node_modules`, `dist`, `.build`, `.sst`, `*.d.ts`, `sdk.gen.ts`.

Disabled rules of note: `require-yield` (Effect.gen), `no-unassigned-vars` (SolidJS refs), `no-unused-expressions` (SolidJS reactivity), `no-shadow` (Effect closures).

## Package-Specific Notes

- **packages/app**: `codemate dev web` proxies `https://app.codemate.ai` (no local changes). For local UI: run backend (`bun run --cwd packages/codemate --conditions=browser ./src/index.ts serve --port 4096`) and app (`bun --cwd packages/app dev -- --port 4444`) separately. Prefer `createStore` over multiple `createSignal`.
- **packages/desktop**: Never call `invoke` manually; use generated bindings in `src/bindings.ts`.
- **packages/desktop-electron**: Renderer uses `window.api` from `src/preload`; main registers IPC handlers in `src/main/ipc.ts`.

## Contributing

- All PRs must reference an existing issue (`Fixes #123`)
- PR titles follow conventional commits: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:` (optionally scoped: `feat(app):`)
- UI changes need screenshots/videos; logic changes need verification description
- No AI-generated walls of text in PRs
- New providers: PR to https://github.com/anomalyco/models.dev first
- UI/core features need design review before implementation

## Config

- `.codemate/codemate.jsonc` — Codemate session config (denies editing migration files)
- `bunfig.toml` — `exact = true` for installs, test root guard
- `turbo.json` — task definitions, `test` depends on `^build`
- `.editorconfig` — 2-space indent, UTF-8, LF, max 80 chars
