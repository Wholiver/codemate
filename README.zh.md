<p align="center">
  <img src="packages/web/src/assets/lander/readme-banner.svg" alt="Codemate" />
</p>

<div align="center">

### 面向长周期工程的开源编程代理

**记忆优先。学习增强。验证驱动。研究原生。**

[![Build status](https://img.shields.io/github/actions/workflow/status/Wholiver/codemate/publish.yml?style=flat-square&branch=dev)](https://github.com/Wholiver/codemate/actions/workflows/publish.yml)
[![JSR](https://img.shields.io/badge/JSR-@codemate/codemate-00bcd4?style=flat-square)](https://jsr.io/@codemate/codemate)

_基于 OPENCODE 构建，向 OPENCODE 团队与社区致以诚挚感谢。_

<sub><a href="README.md">English</a> · <a href="README.zh.md">简体中文</a></sub>

</div>

[![Codemate Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://codemate.ai)

---

<p align="center"><strong>快速浏览：</strong> <a href="#30-秒价值">30 秒价值</a> · <a href="#安装-jsr">安装</a> · <a href="#架构总览">架构</a> · <a href="#核心能力">核心能力</a> · <a href="#对比">对比</a></p>

## 30 秒价值

Codemate 面向的是需要在多轮会话中持续产出稳定结果的团队，而不仅仅是一次会话里的“聪明回答”。

| 支柱         | 内置能力                                      | 在实际工作中的变化                       |
| ------------ | --------------------------------------------- | ---------------------------------------- |
| 记忆         | 持久化记忆与结构化检索                        | 决策、模式和修复可跨会话延续             |
| 经验         | `.codemate/lessons.md` + `lesson_write` 回路 | 错误沉淀为可复用的团队知识               |
| 自检         | `selfcheck`（默认检查 + 自定义检查）         | 降低“看起来完成了”但实际上失败的情况     |
| 深度研究     | `research-*` + `websearch` + `webfetch`      | 在不确定场景下做出更可靠决策             |
| 统一运行时   | MCP + LSP + ACP 一体化                        | 终端与自动化流程中的行为一致             |

## 安装 (JSR)

> [!IMPORTANT]
> 参与仓库开发请使用 Bun `1.3.13`（本 monorepo 依赖精确版本）。

```bash
# npm / bun / 较老版本 pnpm/yarn
npx jsr add @codemate/codemate

# 或
bunx jsr add @codemate/codemate
pnpm dlx jsr add @codemate/codemate
yarn dlx jsr add @codemate/codemate
```

- 包地址：https://jsr.io/@codemate/codemate
- 文档：https://codemate.ai/docs

## 架构总览

> [!IMPORTANT]
> 默认分支是 `dev`（不是 `main`）。做 diff 和 PR 目标分支时请使用 `dev` / `origin/dev`。

```text
Codemate Runtime
├─ 1. 输入层
│  ├─ 用户请求
│  ├─ 项目上下文（仓库/文件/运行状态）
│  └─ 会话历史
├─ 2. 规划层
│  ├─ 目标拆解
│  ├─ 约束检测
│  └─ 执行策略选择
├─ 3. 知识层
│  ├─ Memory 系统
│  │  ├─ 写入：memory_create
│  │  ├─ 检索：memory_search / memory_read / memory_list
│  │  └─ 检索模式：keyword / semantic / hybrid
│  └─ Lessons 系统
│     ├─ 存储：.codemate/lessons.md
│     ├─ 写入：lesson_write
│     └─ 加载：<project-lessons>
├─ 4. 研究层
│  ├─ research
│  ├─ research-add-items
│  ├─ research-add-fields
│  ├─ research-deep
│  └─ research-report（配合 websearch / webfetch）
├─ 5. 执行层
│  ├─ 代码修改
│  ├─ Shell 命令
│  └─ 工具 / MCP 调用
├─ 6. 验证层
│  ├─ selfcheck
│  ├─ 默认检查：typecheck / lint / test
│  └─ 自定义检查：pytest / go test / cargo test ...
└─ 7. 反馈闭环
   ├─ 记录失败与修复
   ├─ 更新 lessons 和 memory
   └─ 提升下一轮质量
```

Codemate 被设计为可复利的闭环：每一次运行都可以提升下一次运行质量。

## 核心能力

### 1) Memory：超长项目记忆

- 让关键项目上下文跨会话保留，而不是只停留在当前聊天里。
- 在相似任务再次出现时，能够回忆之前的决策、约束和约定。

例子：

- 团队约定了“本地用 SQLite、云端用 Postgres”。一周后做迁移任务时，Codemate 会沿用这条决策，避免改出不一致方案。

为什么重要：

- 长周期项目里可以少做重复说明，也能减少反复踩同样的坑。

### 2) Lessons：内置自学习

- 记录“哪里失败了、怎么修好的、下次该怎么做”。
- 在同一项目后续任务中复用这些经验。

例子：

- 某次发布因为环境变量缺失失败。下一次发布任务里，Codemate 会先补上环境变量预检清单再执行构建。

为什么重要：

- 学习效果会在项目层面持续累积，而不是每轮会话都重新开始。

### 3) Self-check：交付前验证

- 在交付前先做验证，直到结果稳定再给结论。
- 可以按项目技术栈和质量门槛执行对应检查。

例子：

- 做一次重构时，先跑 typecheck、lint、test；如果 lint 失败，会先修复并复跑，再反馈完成状态。

为什么重要：

- 明显减少“看起来完成了，但 CI 会挂”的交付结果。

### 4) 深度研究：研究原生工作流

- 面对需求不清晰或变化很快的问题，支持结构化调研。
- 能比较多种方案、追踪证据来源，并清晰总结取舍。

例子：

- 在两个 API 供应商之间选型时，可对比价格、限流、迁移成本和风险，并输出决策简报。

为什么重要：

- 在迁移、供应商选型和高不确定技术问题上做出更稳的决策。

## 对比

| 维度         | 与 OPENCODE 对比                                                     | 与 Claude Code 对比                             |
| ------------ | -------------------------------------------------------------------- | ----------------------------------------------- |
| 运行时形态   | 活跃运行时整合在 `packages/codemate/src/*`，子系统深度集成          | 运行时全开源，可端到端审查与修改                |
| 记忆模型     | 内置持久化记忆 + 检索 + 生命周期                                     | 跨会话项目连续性更强                            |
| 学习闭环     | 原生 lessons 工作流（`.codemate/lessons.md` + `lesson_write`）      | 在日常工程中具备更明确的组织化学习路径          |
| 验证能力     | 一等公民的自检工具与结构化失败闭环                                   | 最终输出前的验证路径更可控                      |
| 研究深度     | 专用研究工具链（`research-*`、`websearch`、`webfetch`）             | 更适合高不确定性的工程决策                      |
| 模型策略     | 设计上与模型提供方解耦                                               | 不绑定单一供应商路线                            |

## 贡献

> [!IMPORTANT]
> 推送前请在各 package 目录执行检查（不要在仓库根目录跑测试）。

发起 PR 前请阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)。

---

**社区**：[Discord](https://discord.gg/codemate) · [X](https://x.com/codemate)
