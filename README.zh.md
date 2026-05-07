<pre align="center">
 ███   ███  ████  █████ █   █  ███  █████ █████
█     █   █ █   █ █     ██ ██ █   █   █   █
█     █   █ █   █ ████  █ █ █ █████   █   ████
█     █   █ █   █ █     █   █ █   █   █   █
 ███   ███  ████  █████ █   █ █   █   █   █████
</pre>

<div align="center">

### 面向长期工程协作的开源 Coding Agent

**Memory 驱动，自学习增强，自检兜底，深度研究优先。**

[![Discord](https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord)](https://codemate.ai/discord)
[![Build status](https://img.shields.io/github/actions/workflow/status/Wholiver/codemate/publish.yml?style=flat-square&branch=dev)](https://github.com/Wholiver/codemate/actions/workflows/publish.yml)
[![JSR](https://img.shields.io/badge/JSR-@codemate/codemate-00bcd4?style=flat-square)](https://jsr.io/@codemate/codemate)

<sub><a href="README.md">English</a> · <a href="README.zh.md">简体中文</a></sub>

</div>

[![Codemate Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://codemate.ai)

---

<p align="center"><strong>快速了解：</strong><a href="#30-秒看懂价值">30 秒价值</a> · <a href="#核心功能">核心能力</a> · <a href="#架构速览">架构速览</a> · <a href="#对比">对比</a> · <a href="#安装jsr">安装</a></p>

## 30 秒看懂价值

Codemate 不追求一次对话里的“聪明回答”，而是追求多轮、多天、多项目中的稳定交付。

| 支柱 | 内建能力 | 在真实工程中的变化 |
| --- | --- | --- |
| Memory | 持久记忆 + 结构化检索 | 架构决策、偏好、排障经验可跨会话复用 |
| Lessons | `.codemate/lessons.md` + `lesson_write` | 错误和经验会被沉淀为团队资产 |
| Self-check | `selfcheck`（默认 + 自定义校验） | 减少“看起来完成但实际没验证” |
| Deep Research | `research-*` + `websearch` + `webfetch` | 高不确定任务有更稳的证据支撑 |
| 一体化运行时 | MCP + LSP + ACP 同栈 | CLI/TUI/Web 体验与行为更一致 |

## 核心功能

### 1) Memory：超长期项目记忆

模块：`packages/codemate/src/memory/*`

- 结构化记忆模型：`domain / path / version`
- 工具：`memory_create`、`memory_search`、`memory_read`、`memory_list`
- 检索模式：`keyword`、`semantic`、`hybrid`

为什么重要：

- 项目上下文可在跨对话、跨任务中持续复用。

### 2) Lessons：内建自学习系统

核心文件：`.codemate/lessons.md`  
写入工具：`lesson_write`

- 有意义执行后写入 lessons。
- 通过 `<project-lessons>` 回灌到后续会话。
- 聚焦：失败模式、弯路原因、最终决策。

为什么重要：

- 同一项目里的重复错误会明显减少。

### 3) Self-check：交付前结果自检

工具：`packages/codemate/src/tool/selfcheck.ts`

- JS/TS 默认校验：`typecheck`、`lint`、`test`
- 支持自定义命令：`pytest`、`go test ./...`、`cargo test`
- 校验失败后会进入修复并复验闭环。

为什么重要：

- 交付前有明确验证步骤，结果更稳。

### 4) Deep Research：深度研究工作流

- 工具链：`research`、`research-add-items`、`research-add-fields`、`research-deep`、`research-report`
- 支持结构化调研、字段提取、不确定性标注和来源化报告。

为什么重要：

- 面对迁移和第三方 API 这类高不确定任务，决策更稳。

## 架构速览

- **输入层**
  - 用户请求
  - 项目上下文：仓库/文件/运行态
  - 会话历史

- **规划层**
  - 目标拆解
  - 约束识别
  - 执行策略选择

- **知识层**
  - Memory 系统
    - 写入：`memory_create`
    - 检索：`memory_search` / `memory_read` / `memory_list`
    - 检索模式：`keyword` / `semantic` / `hybrid`
  - Lessons 系统
    - 存储：`.codemate/lessons.md`
    - 写入：`lesson_write`
    - 加载：`project-lessons`

- **研究层**
  - `research`
  - `research-add-items`
  - `research-add-fields`
  - `research-deep`
  - `research-report`
  - `websearch` / `webfetch`

- **执行层**
  - 代码改动
  - shell 命令
  - 工具与 MCP 调用

- **验证层**
  - `selfcheck`
  - 默认检查：`typecheck` / `lint` / `test`
  - 自定义检查：`pytest` / `go test` / `cargo test` ...

- **反馈闭环**
  - 记录失败与修复
  - 回写 lessons 与 memory
  - 增强下一次执行质量

流程：

`输入 -> 规划 -> 知识 -> 研究 -> 执行 -> 验证 -> 反馈 -> 规划`

Codemate 是可复利的执行闭环，每次运行都可以增强下一次运行质量。

## 对比

| 维度 | 与 OPENCODE 对比 | 与 Claude Code 对比 |
| --- | --- | --- |
| 运行时形态 | 活跃能力集中在 `packages/codemate/src/*`，子系统整合更紧密 | 全开源运行时，可端到端审计和改造 |
| 记忆模型 | 内建持久记忆 + 检索 + 生命周期治理 | 跨会话项目连续性更强 |
| 学习闭环 | 原生 lessons 机制（`.codemate/lessons.md` + `lesson_write`） | 更容易形成制度化项目知识 |
| 结果验证 | 一等公民 self-check 与失败后修复闭环 | 最终输出前验证路径更可控 |
| 研究深度 | `research-*` + `websearch` + `webfetch` 深度组合 | 更适合高不确定工程决策任务 |
| 模型策略 | provider-agnostic，不绑定单一供应商 | 模型路线与成本策略更可控 |

## 安装（JSR）

```bash
# npm / bun / 旧版 pnpm/yarn
npx jsr add @codemate/codemate

# 或
bunx jsr add @codemate/codemate
pnpm dlx jsr add @codemate/codemate
yarn dlx jsr add @codemate/codemate
```

- JSR 包地址：https://jsr.io/@codemate/codemate
- 文档：https://codemate.ai/docs

## 参与贡献

提交 PR 前请先阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)。

---

**社区**：[Discord](https://discord.gg/codemate) · [X](https://x.com/codemate)
