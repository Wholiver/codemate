<p align="center">
  <a href="https://codemate.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="Codemate logo">
    </picture>
  </a>
</p>
<p align="center">The open source AI coding agent with long-term memory, self-learning, and self-check.</p>
<p align="center">
  <a href="https://codemate.ai/discord"><img alt="Discord" src="https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord" /></a>
  <a href="https://www.npmjs.com/package/codemate-ai"><img alt="npm" src="https://img.shields.io/npm/v/codemate-ai?style=flat-square" /></a>
  <a href="https://github.com/Wholiver/codemate/actions/workflows/publish.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/Wholiver/codemate/publish.yml?style=flat-square&branch=dev" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a>
</p>

[![Codemate Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://codemate.ai)

---

### Why Codemate

- **Ultra long-term memory**: Codemate keeps durable project memory across sessions so it can remember your codebase context, preferences, and past fixes.
- **Self-learning improvement loop**: Every run can feed lessons and changelogs back into future behavior, so the agent gets better as you keep using it.
- **Built-in self-check**: Before finishing tasks, Codemate can run structured self-check flows to verify outcomes and reduce silent mistakes.

### Core Workflow

1. Plan the task with difficulty, time, and research needs.
2. Execute with tool use and context-aware memory.
3. Self-check results, then reflect into memory/lessons/changelog.

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

### Desktop App (BETA)

Codemate is also available as a desktop application. Download directly from the [releases page](https://github.com/Wholiver/codemate/releases) or [codemate.ai/download](https://codemate.ai/download).

| Platform              | Download                              |
| --------------------- | ------------------------------------- |
| macOS (Apple Silicon) | `codemate-desktop-darwin-aarch64.dmg` |
| macOS (Intel)         | `codemate-desktop-darwin-x64.dmg`     |
| Windows               | `codemate-desktop-windows-x64.exe`    |
| Linux                 | `.deb`, `.rpm`, or AppImage           |

```bash
# macOS (Homebrew)
brew install --cask codemate-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/codemate-desktop
```

#### Installation Directory

The install script respects the following priority order for the installation path:

1. `$CODEMATE_INSTALL_DIR` - Custom installation directory
2. `$XDG_BIN_DIR` - XDG Base Directory Specification compliant path
3. `$HOME/bin` - Standard user binary directory (if it exists or can be created)
4. `$HOME/.codemate/bin` - Default fallback

```bash
# Examples
CODEMATE_INSTALL_DIR=/usr/local/bin curl -fsSL https://codemate.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://codemate.ai/install | bash
```

### Agents

Codemate includes two built-in agents you can switch between with the `Tab` key.

- **build** - Default, full-access agent for development work
- **plan** - Read-only agent for analysis and code exploration
  - Denies file edits by default
  - Asks permission before running bash commands
  - Ideal for exploring unfamiliar codebases or planning changes

Also included is a **general** subagent for complex searches and multistep tasks.
This is used internally and can be invoked using `@general` in messages.

Learn more about [agents](https://codemate.ai/docs/agents).

### Documentation

For more info on how to configure Codemate, [**head over to our docs**](https://codemate.ai/docs).

### Contributing

If you're interested in contributing to Codemate, please read our [contributing docs](./CONTRIBUTING.md) before submitting a pull request.

### Building on Codemate

If you are working on a project that's related to Codemate and is using "codemate" as part of its name, for example "codemate-dashboard" or "codemate-mobile", please add a note to your README to clarify that it is not built by the Codemate team and is not affiliated with us in any way.

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
