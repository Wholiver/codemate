<pre align="center">
 ███   ███  ████  █████ █   █  ███  █████ █████ 
█     █   █ █   █ █     ██ ██ █   █   █   █     
█     █   █ █   █ ████  █ █ █ █████   █   ████  
█     █   █ █   █ █     █   █ █   █   █   █     
 ███   ███  ████  █████ █   █ █   █   █   █████ 
</pre>
<p align="center">The open source AI coding agent with long-term memory, self-learning, and self-check.</p>
<p align="center">
  <a href="https://codemate.ai/discord"><img alt="Discord" src="https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord" /></a>
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
npx jsr add @codemate/codemate
```

JSR download: https://jsr.io/@codemate/codemate

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

#### How is this different from OPENCODE and Claude Code?

| Compared with OPENCODE | Compared with Claude Code |
| --- | --- |
| - Client/server architecture with multiple clients.<br>- Strong terminal-first (TUI) focus by the [terminal.shop](https://terminal.shop) team.<br>- Built-in long-term memory and self-learning loops. | - 100% open source.<br>- Provider-agnostic: use Claude, OpenAI, Google, or local models (and [Codemate Zen](https://codemate.ai/zen)).<br>- Out-of-the-box LSP support. |

---

**Join our community** [Discord](https://discord.gg/codemate) | [X.com](https://x.com/codemate)
