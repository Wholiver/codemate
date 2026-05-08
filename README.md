<div align="center">
  <img src="./packages/identity/mark.svg" alt="Codemate logo" width="72" />

# Codemate

**Open-source coding agent for long-horizon engineering work**

[![Build status](https://img.shields.io/github/actions/workflow/status/anomalyco/codemate/publish.yml?style=flat-square&branch=dev)](https://github.com/anomalyco/codemate/actions/workflows/publish.yml)
[![Discord](https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord)](https://codemate.ai/discord)
[![JSR](https://img.shields.io/badge/JSR-@codemate/codemate-00bcd4?style=flat-square)](https://jsr.io/@codemate/codemate)

[Website](https://codemate.ai) • [Docs](https://codemate.ai/docs) • [Discord](https://discord.gg/codemate)

</div>

[![Codemate UI and terminal preview](./packages/web/src/assets/lander/screenshot.png)](https://codemate.ai)

Codemate is a Bun-powered monorepo for an AI coding agent with a CLI/TUI runtime, shared web UI, desktop apps, SDKs, and plugin tooling.

## Why Codemate

- Persistent project memory and lessons across sessions
- Built-in verification loops (`typecheck`, `lint`, `test`)
- Research-oriented workflows for uncertain tasks
- Provider-agnostic runtime with MCP/LSP/ACP integrations
- Fully inspectable and hackable open-source codebase

## Monorepo Structure

| Package                     | Purpose                                          |
| --------------------------- | ------------------------------------------------ |
| `packages/codemate`         | Core runtime: CLI, server, TUI, agent logic      |
| `packages/app`              | Shared web UI (SolidJS + Vite + Tailwind v4)     |
| `packages/core`             | Shared utilities and Effect-based infrastructure |
| `packages/sdk/js`           | TypeScript SDK generated from OpenAPI            |
| `packages/plugin`           | Plugin SDK (`@codemate-ai/plugin`)               |
| `packages/ui`               | Shared SolidJS component library                 |
| `packages/desktop`          | Tauri desktop wrapper for `packages/app`         |
| `packages/desktop-electron` | Electron desktop wrapper for `packages/app`      |
| `packages/console/*`        | Console web app and backend                      |
| `packages/web`              | Marketing site (Astro)                           |

## Quick Start

> [!IMPORTANT]
> Use Bun `1.3.13` (the repo expects an exact Bun version).

```bash
# 1) Install dependencies
bun install

# 2) Run Codemate locally (CLI/server runtime)
bun dev
```

Useful variants:

```bash
# Run against current directory
bun dev .

# Headless API server (port 4096)
bun dev serve

# Web UI dev server
bun run --cwd packages/app dev
```

## Local Development Workflow

```bash
# Lint
bun lint

# Typecheck (tsgo via turbo)
bun typecheck

# Format
bun run prettier --write .
```

> [!IMPORTANT]
> Do not run tests from the repo root (guarded by `bunfig.toml`).

```bash
# Package-level tests
bun --cwd packages/codemate test
bun --cwd packages/app test:unit
bun --cwd packages/app test:e2e:local
bun --cwd packages/core test

# Full CI-style test run
bun turbo test:ci
```

## Build and Generation

```bash
# Build standalone executable for current platform
./packages/codemate/script/build.ts --single

# Regenerate JavaScript SDK only
./packages/sdk/js/script/build.ts

# Regenerate SDK + OpenAPI + model snapshot + formatting
./script/generate.ts
```

> [!NOTE]
> Generated artifacts should not be edited by hand (for example files under `packages/sdk/js/src/gen` and `packages/sdk/js/src/v2/gen`).

## Database Migrations

```bash
bun --cwd packages/codemate run db generate --name <slug>
```

Drizzle migrations are created under:

- `packages/codemate/migration/<timestamp>_<slug>/migration.sql`
- `packages/codemate/migration/<timestamp>_<slug>/snapshot.json`

## Architecture Notes

- Runtime stack: Effect v4 beta + Hono + Drizzle/SQLite
- Conditional imports for runtime surfaces:
  - `#db` (Bun/Node DB adapter)
  - `#pty` (Bun/Node PTY adapter)
  - `#hono` (Bun/Node server adapter)
- Default branch: `dev`

## Releases and CI

Main workflows in `.github/workflows`:

- `test.yml` for unit and e2e checks
- `typecheck.yml` for cross-package typechecking
- `generate.yml` for generated artifacts refresh
- `publish.yml` for CLI and desktop release artifacts

## Troubleshooting

- If `bun typecheck` fails after dependency changes, run `bun install` again and retry.
- If desktop/web dev does not boot, run the package-specific dev commands from **Quick Start**.
- If generated files drift, run `./script/generate.ts` and re-check.

For deeper docs and product usage guides, see [codemate.ai/docs](https://codemate.ai/docs).
