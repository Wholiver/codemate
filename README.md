<p align="center">
  <a href="https://codemate.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="Codemate logo" width="350">
    </picture>
  </a>
</p>
<p align="center"><strong><font size="4">The AI coding agent that gets smarter — right inside your project.</font></strong></p>
<p align="center">
  <a href="https://codemate.ai/discord"><img alt="Discord" src="https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord" /></a>
  <a href="https://www.npmjs.com/package/codemate-ai"><img alt="npm" src="https://img.shields.io/npm/v/codemate-ai?style=flat-square" /></a>
  <a href="https://github.com/Wholiver/codemate/actions/workflows/publish.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/Wholiver/codemate/publish.yml?style=flat-square&branch=dev" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a>
</p>

<p align="center">
  <a href="https://codemate.ai">
    <img src="packages/web/src/assets/lander/screenshot.png" alt="Codemate Terminal UI" width="90%">
  </a>
</p>

---

Most AI coding tools start from scratch every session. Codemate doesn't. It builds a **living project brain** — memory, lessons, and history that compound over time, right inside your project's SQLite database. The longer you use it in a project, the more it understands your codebase, your patterns, and your conventions.

### How Codemate Gets Smarter Inside Your Project

#### 1. Project Memory — Always There, Always Relevant

Every piece of knowledge Codemate learns about your project is stored persistently in SQLite. It survives sessions, restarts, and even machine reboots. The memory system doesn't just store facts — it manages them:

- **Vitality scoring** — Frequently accessed memories stay prominent (vitality score 0→1). Rarely used ones naturally decay toward 0. The system knows what matters to your project.
- **Version chains** — When memory content changes, it creates a new version rather than overwriting. History is preserved. Old versions can be referenced when needed.
- **Hybrid search** — Combines keyword matching and LSH-based semantic embeddings. Intent-aware: factual queries weight keywords higher; exploratory queries weight semantics higher. Alias system lets you reference the same memory by different names.
- **Automatic consolidation** — If multiple fragments exist for the same topic, Codemate merges them automatically. No duplicate noise.
- **Lifecycle management** — Memories decay over time (30-day half-life if unused). Stale, low-vitality entries are cleaned up. The system stays lean and relevant.

#### 2. Lessons — The Feedback Loop

After each task, Codemate writes lessons to `.codemate/lessons.md`. These are loaded as context at the **start of every new task** — so it immediately knows your project's conventions, gotchas, and patterns before it begins:

> "This project uses feature flags for all new features."
> "Never commit directly to main — use the PR workflow."
> "The database schema is the source of truth, not the ORM models."

Lessons accumulate. They are the explicit, human-readable record of what works and what doesn't in your project.

#### 3. Changelog — History You Can Search

Every significant change is recorded in a project-scoped changelog with timestamps, changed files, and summaries. Before working on a new task, Codemate can search this history to understand recent context — what was changed, by whom, and why.

#### 4. The Compound Effect

Together, these systems feed into Codemate's context window at every task:

```
New task starts
  → Load lessons from .codemate/lessons.md  (what we know works)
  → Load recent changelog                   (what changed recently)
  → Search project memory                   (everything else we know)
  → Agent builds context from all of this
  → Agent executes task
  → Agent writes new lessons, updates memory, appends to changelog
```

After 10 sessions, Codemate knows your project structure, your team's conventions, the patterns that caused bugs before, and the patterns that work well. After 50 sessions, it's a genuine project expert.

### Other Features

- **Two built-in agents** — switch with `Tab`: `build` (default, full-access) and `plan` (read-only, asks before bash)
- **Provider-agnostic** — works with Claude, OpenAI, Google, or local models via [Codemate Zen](https://codemate.ai/zen)
- **Built-in LSP support** — code intelligence out of the box
- **Client/server architecture** — run the backend headless, drive it from any frontend (TUI, web, desktop)
- **Plugin system** — extend via `@codemate-ai/plugin`
- **100% open source**

### Installation

```bash
# YOLO
curl -fsSL https://codemate.ai/install | bash

# Package managers
npm i -g codemate-ai@latest        # or bun/pnpm/yarn
scoop install codemate             # Windows
choco install codemate             # Windows
brew install anomalyco/tap/codemate # macOS and Linux (recommended, always up to date)
brew install codemate              # macOS and Linux (official brew formula, updated less)
sudo pacman -S codemate            # Arch Linux (Stable)
paru -S codemate-bin               # Arch Linux (Latest from AUR)
mise use -g codemate               # Any OS
nix run nixpkgs#codemate           # or github:anomalyco/codemate for latest dev branch
```

> [!TIP]
> Remove versions older than 0.1.x before installing.

### Documentation

For more info on how to configure Codemate, [**head over to our docs**](https://codemate.ai/docs).

### Contributing

If you are interested in contributing to Codemate, please read our [contributing docs](./CONTRIBUTING.md) before submitting a pull request.

### FAQ

#### How is this different from Claude Code?

It's very similar to Claude Code in terms of capability. Here are the key differences:

- 100% open source
- Not coupled to any provider. Although we recommend the models we provide through [Codemate Zen](https://codemate.ai/zen), Codemate can be used with Claude, OpenAI, Google, or even local models. As models evolve, the gaps between them will close and pricing will drop, so being provider-agnostic is important.
- Out-of-the-box LSP support
- A focus on TUI. Codemate is built by neovim users and the creators of [terminal.shop](https://terminal.shop); we are going to push the limits of what's possible in the terminal.
- A client/server architecture. This, for example, can allow Codemate to run on your computer while you drive it remotely from a mobile app, meaning that the TUI frontend is just one of the possible clients.

---

**Join our community** [Discord](https://discord.gg/codemate) | [X.com](https://x.com/codemate)