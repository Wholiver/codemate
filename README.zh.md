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

## 第一天就能感受到的收益

| 收益 | Codemate 如何实现 |
| --- | --- |
| 少走重复弯路 | 执行后写入 lessons，后续自动回灌上下文 |
| 项目上下文不断档 | Memory 保存长期有效信息，不止聊天记录 |
| 交付更稳 | 最终输出前执行 self-check |
| 技术决策更有依据 | 深度研究工具链支持结构化取证 |

## 核心功能

### 1) Memory：超长期项目记忆

模块：`packages/codemate/src/memory/*`

- 结构化模型：`domain / path / version`
- 工具：`memory_create`、`memory_search`、`memory_read`、`memory_list`
- 检索模式：`keyword`、`semantic`、`hybrid`
- 生命周期治理：活性评分、衰减清理、去重排序

为什么重要：

- 架构决策和排障经验可以在数月后继续检索使用。
- 高上下文任务不再每次从零启动。

### 2) Lessons：内建自学习系统

核心文件：`.codemate/lessons.md`  
写入工具：`lesson_write`

- 有意义执行后写入 lessons。
- 通过 `<project-lessons>` 回灌到后续会话。
- 典型内容：
  - 失败模式与预防方式
  - 弯路原因与规避策略
  - 关键发现与最终决策

为什么重要：

- Agent 会逐步贴合你的团队工作方式。
- 已知坑会变成可复用规则。

### 3) Self-check：交付前结果自检

工具：`packages/codemate/src/tool/selfcheck.ts`

- JS/TS 默认校验：`typecheck`、`lint`、`test`
- 支持自定义命令（示例）：`pytest`、`go test ./...`、`cargo test`
- 失败闭环：记录上下文 -> 更新 lessons/changelog -> 补充研究 -> 再验证

为什么重要：

- 可靠性成为流程步骤，而不是“希望没问题”。
- 多文件、长链路改动更安全。

### 4) Deep Research：深度研究工作流

工具链：

- `research`
- `research-add-items`
- `research-add-fields`
- `research-deep`
- `research-report`

`research-deep` 支持：

- 多项研究计划
- 字段化信息提取
- 不确定性标注
- 面向来源的采集与报告

为什么重要：

- 在迁移、第三方 API、快速变化技术栈下更稳。
- 降低“拍脑袋改代码”的风险。

## 架构速览

```text
用户请求
   -> 规划 / 会话循环
      -> Memory（create/search/read/list）
      -> Research（research-*）
      -> Tool Execution（code/shell/MCP）
      -> Self-check（verify）
      -> Lessons 回写（.codemate/lessons.md）
```

Codemate 是可复利的执行闭环，每次运行都可以增强下一次运行质量。

## 工作流闭环

1. 理解目标与约束。
2. 拉取相关记忆。
3. 对不确定问题做深度研究。
4. 用项目感知工具实施改动。
5. 运行 self-check。
6. 回写 lessons 与 memory。

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
