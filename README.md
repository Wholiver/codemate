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
| - **Current codebase status**: many historical `packages/opencode/*` docs/tests were removed, and active runtime work is now centered in `packages/codemate/src/*`.<br>- **Capability surface**: the active modules include `agent`, `session`, `tool`, `mcp`, `lsp`, `memory`, `server`, `cli`, and `acp` (Agent Client Protocol), which reflects a broader integrated runtime than a simple CLI-only layout.<br>- **Multi-interface runtime**: current architecture still exposes TUI/CLI/web/server paths from the same core runtime, so behavior and context can be shared across interfaces.<br>- **Plugin direction**: plugin internals are being reshaped (for example, legacy plugin entrypoints changed), so extension APIs are powerful but currently in active evolution.<br>- **Practical takeaway**: if you compare against earlier OPENCODE snapshots, the biggest difference today is consolidation: fewer duplicated package trees, more features living in one codemate runtime. | - **Open source and inspectable**: Codemate remains fully open source, with core runtime code in this repo and transparent behavior at module level.<br>- **Provider strategy**: still provider-agnostic (Claude/OpenAI/Google/local-model paths), rather than locking a single model vendor.<br>- **Built-in infra**: native MCP, LSP, memory, and session systems are first-class modules in the runtime, not only external wrappers.<br>- **Agent protocol support**: ACP support is implemented in-tree (`src/acp/*`), which is useful for integrating Codemate into broader agent ecosystems.<br>- **Tradeoff**: because the project is moving fast, some APIs and docs can change quickly; the best source of truth is the current code tree and docs in this branch. |

---

**Join our community** [Discord](https://discord.gg/codemate) | [X.com](https://x.com/codemate)
