<pre align="center">
 ███   ███  ████  █████ █   █  ███  █████ █████
█     █   █ █   █ █     ██ ██ █   █   █   █
█     █   █ █   █ ████  █ █ █ █████   █   ████
█     █   █ █   █ █     █   █ █   █   █   █
 ███   ███  ████  █████ █   █ █   █   █   █████
</pre>

<p align="center"><strong>开源 AI Coding Agent：超长期记忆 + 自学习 + 自检 + 深度搜索。</strong></p>

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

## 快速导航

- [30 秒看懂价值](#30-秒看懂价值)
- [核心功能](#核心功能)
- [架构速览](#架构速览)
- [工作流闭环](#工作流闭环)
- [对比（给新用户快速判断）](#对比给新用户快速判断)
- [安装（JSR）](#安装jsr)

## 30 秒看懂价值

Codemate 不是一次性问答工具，而是持续进化的工程 Agent 运行时。

| 支柱 | 内建能力 | 在真实工作里的价值 |
| --- | --- | --- |
| Memory | 持久记忆 + 可检索结构 | 跨会话保留架构决策、偏好和排障经验 |
| Lessons | `.codemate/lessons.md` + `lesson_write` | 把错误与发现沉淀为可复用项目知识 |
| Self-check | `selfcheck`（默认 + 自定义验证） | 在交付前拦截“看似完成但未验证” |
| Deep Research | `research-*` + `websearch` + `webfetch` | 在高不确定任务中提供带来源依据的研究能力 |
| 一体化运行时 | MCP + LSP + ACP 同栈集成 | 让 CLI/TUI/Web 行为更一致，降低集成摩擦 |

这意味着：

- Agent 会随着你的项目持续变强。
- 高上下文任务不再每次从零开始。
- 结果可靠性来自内建验证闭环，而不是运气。

## 核心功能

### Memory：超长期记忆系统

核心模块：`packages/codemate/src/memory/*`

- 结构化记忆模型：`domain / path / version`
- 记忆工具：
  - `memory_create`
  - `memory_search`
  - `memory_read`
  - `memory_list`
- 检索模式：
  - `keyword`
  - `semantic`
  - `hybrid`（推荐）
- 生命周期治理：
  - vitality（活性）评分
  - 衰减与清理
  - 去重与排序

为什么重要：

- 关键实现上下文可以跨长期项目保留。
- 架构讨论和排障经验会变成可复用资产。

### Lessons：内建自学习闭环

核心文件：`.codemate/lessons.md`  
写入工具：`lesson_write`

- 有意义的执行后写入 lessons。
- 通过 `<project-lessons>` 回灌上下文。
- 条目聚焦：
  - 错误与预防
  - 弯路与原因
  - 发现与最终决策

为什么重要：

- 同类错误会越来越少。
- 团队工程习惯被显式沉淀并复用。

### Self-check：结果前自检

工具：`packages/codemate/src/tool/selfcheck.ts`

- JS/TS 默认检查：
  - `typecheck`
  - `lint`
  - `test`
- 非 JS/TS 支持自定义校验：
  - `pytest`
  - `go test ./...`
  - `cargo test`
- 失败后闭环：
  - 记录失败上下文
  - 更新 lessons/changelog
  - 补充研究并再次验证

为什么重要：

- 减少无声回归风险。
- 多步骤复杂改动的交付信心更高。

### Deep Research：深度研究工作流

研究工具链：

- `research`
- `research-add-items`
- `research-add-fields`
- `research-deep`
- `research-report`

`research-deep` 支持：

- 多项研究大纲
- 字段化提取
- 不确定性标记
- 面向引用的采集流程

配合 `websearch` 与 `webfetch`，Codemate 可以进行深度研究，而不是单次浅层搜索。

为什么重要：

- 对新框架、第三方 API、迁移决策更稳。
- 降低“拍脑袋改代码”的风险。

## 架构速览

```text
用户请求
   -> 规划 / 会话循环
      -> Memory（create/search/read/list）
      -> Research（research-*）
      -> Tool Execution（代码、shell、MCP）
      -> Self-check（验证）
      -> Lessons 回写（.codemate/lessons.md）
```

这些系统被统一在一个连续改进循环里，每次执行都会增强下一次执行质量。

## 工作流闭环

1. 理解目标与约束。
2. 拉取相关长期记忆。
3. 高不确定问题执行深度研究。
4. 用项目感知工具实施改动。
5. 运行 self-check。
6. 回写 lessons 和 memory。

核心不是“回答一次”，而是持续进化的项目协作能力。

## 对比（给新用户快速判断）

| 维度 | 与 OPENCODE 对比 | 与 Claude Code 对比 |
| --- | --- | --- |
| 运行时形态 | 活跃运行时集中在 `packages/codemate/src/*`，子系统整合更紧 | 完整开源，端到端可审计、可改造 |
| 记忆能力 | 内建持久记忆 + 检索 + 生命周期治理（不止对话历史） | 跨会话项目连续性更强 |
| 学习能力 | 原生 lessons 闭环（`.codemate/lessons.md` + `lesson_write`） | 项目知识更易制度化沉淀 |
| 结果可靠性 | 一等公民 self-check + 失败后修复流程 | 最终输出前验证路径更可控 |
| 研究深度 | `research-*` + `websearch` + `webfetch` 深度组合 | 更适合高不确定、决策密集型工程任务 |
| 模型策略 | provider-agnostic，不绑定单一供应商 | 模型与成本策略可控性更高 |

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
