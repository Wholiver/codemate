<pre align="center">
 ███   ███  ████  █████ █   █  ███  █████ █████ 
█     █   █ █   █ █     ██ ██ █   █   █   █     
█     █   █ █   █ ████  █ █ █ █████   █   ████  
█     █   █ █   █ █     █   █ █   █   █   █     
 ███   ███  ████  █████ █   █ █   █   █   █████ 
</pre>

<p align="center"><strong>Open-source coding agent with long-term memory, self-learning, and self-check.</strong></p>

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

## What You Built

Codemate today is a consolidated runtime centered in `packages/codemate/src/*`, with core capabilities you already shipped:

- **Long-term memory system** (`memory/*`) for cross-session recall
- **Self-learning loop** (`lesson/*`, `changelog/*`) so behavior improves over time
- **Structured self-check workflow** before final responses
- **Built-in MCP + LSP + ACP support** (`mcp/*`, `lsp/*`, `acp/*`)
- **Unified multi-interface runtime** for TUI / CLI / web / server from one core
- **Provider-agnostic model layer** (`provider/*`) across major vendors and local options

## Quick Compare

| | Codemate vs OPENCODE | Codemate vs Claude Code |
| --- | --- | --- |
| **Architecture** | Consolidated runtime, fewer split package surfaces, stronger shared core | Open-source runtime you can inspect and modify end-to-end |
| **State & Memory** | Built-in memory + lessons + changelog loop in core flow | Stronger persistent project context across sessions |
| **Integration** | Native MCP/LSP/ACP modules in main runtime | More control over tools, permissions, and integration boundaries |
| **Model Strategy** | Provider-agnostic by design | Not locked to one model provider |

## Install

```bash
npx jsr add @codemate/codemate
```

- JSR: https://jsr.io/@codemate/codemate
- Docs: https://codemate.ai/docs

## Contributing

Please read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a PR.

---

**Community**: [Discord](https://discord.gg/codemate) · [X](https://x.com/codemate)
