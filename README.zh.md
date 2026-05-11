<p align="center">
  <img src="packages/web/src/assets/lander/readme-banner.svg" alt="Codemate" />
</p>

<div align="center">

### 面向长周期工程的开源编程代理

**记忆优先。学习增强。验证驱动。研究原生。**

[![Build status](https://img.shields.io/github/actions/workflow/status/Wholiver/codemate/publish.yml?style=flat-square&branch=dev)](https://github.com/Wholiver/codemate/actions/workflows/publish.yml)
[![JSR](https://img.shields.io/badge/JSR-@codemate/codemate-00bcd4?style=flat-square)](https://jsr.io/@codemate/codemate)

_基于 OPENCODE 构建，向 OPENCODE 团队与社区致以诚挚感谢。_

<sub><a href="README.en.md">English</a> · <a href="README.md">简体中文</a></sub>

</div>

[![Codemate Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://codemate.ai)

---

<p align="center"><strong>快速浏览：</strong> <a href="#30-秒价值">30 秒价值</a> · <a href="#install-global-cli">安装</a> · <a href="#架构总览">架构</a> · <a href="#核心能力">核心能力</a> · <a href="#对比">对比</a></p>

> [!WARNING]
> Codemate 当前处于 **Beta** 阶段，API、行为与包细节在正式稳定版前可能调整。

## 30 秒价值

Codemate 不是“一次对话工具”，而是一个会把每次工程执行沉淀成下次上下文的运行时。

| 30 秒看点          | 系统在背后做什么                                                     | 你会直接感受到什么                       |
| ------------------ | -------------------------------------------------------------------- | ---------------------------------------- |
| 会话可持续推进     | `SessionPrompt` 驱动循环，按状态持续调度模型与工具                  | 任务不会停在“回答一句话”，而是推进到收口 |
| 工程上下文可复用   | 每轮自动注入 `memory`、`project-changelog`、`project-lessons` 上下文 | 不必反复解释历史决策与踩坑点             |
| 改动有证据链       | Snapshot 对比生成 patch，并落 changelog 与会话摘要                  | 变更来源、影响文件和决策路径都可追踪     |
| 交付前有验证关口   | `selfcheck` 统一执行验证（默认 JS/TS + 可扩展自定义命令）           | 降低“本地看起来 OK，提交后失败”的风险    |
| 长上下文不易崩溃   | 上下文超限时自动 compaction，保留关键 tail 并续跑                   | 长任务更稳定，不容易因上下文过长中断     |
| 高不确定问题可研究 | `research-*` 形成“问题拆解 → 证据收集 → 报告输出”流程              | 选型、迁移、政策类决策更稳、更可解释     |

<a id="install-global-cli"></a>

## 安装（全局 CLI）

> [!IMPORTANT]
> 参与仓库开发请使用 Bun `1.3.13`（本 monorepo 依赖精确版本）。

```bash
npm install -g codemate-agent
codemate --help
```

- 全局 `codemate` 命令包：https://www.npmjs.com/package/codemate-agent
- 文档：https://codemate.ai/docs

## CLI 测试运行（仓库方式）

```bash
git clone https://github.com/Wholiver/codemate.git
cd codemate
bun install
bun dev
```

## 架构总览

> [!IMPORTANT]
> 默认分支是 `dev`（不是 `main`）。做 diff 和 PR 目标分支时请使用 `dev` / `origin/dev`。

Codemate 的核心不是单次模型调用，而是“带状态的会话运行时”。下面是一次标准回合的真实链路：

```text
User input
  -> SessionPrompt.run (会话主循环)
  -> Context Assembly
       (system + instructions + history + memory + changelog + lessons)
  -> LLM.stream
       -> SessionProcessor 消费事件流
          (reasoning / text / tool-call / tool-result / step-finish)
       -> ToolRegistry 分发工具
          (builtin + MCP + plugin, 含权限与防 doom-loop)
  -> Snapshot/Patch + SessionSummary + Changelog
  -> Self-check & 经验沉淀提醒
       (selfcheck / memory_create / lesson_write / changelog_append)
  -> 若超限: SessionCompaction
       (摘要压缩 + 保留近期上下文 + 自动续跑)
```

| 子系统               | 关键职责                                               | 关键模块（示例）                          |
| -------------------- | ------------------------------------------------------ | ----------------------------------------- |
| 会话编排层           | 驱动消息循环、调度模型、注入提醒、处理中断与续跑       | `session/prompt.ts`                       |
| 事件处理层           | 接收流式事件并落盘为可回放的 message parts             | `session/processor.ts`、`session/message-v2.ts` |
| 工具与协议层         | 聚合内置工具、MCP 工具、插件工具，并统一权限门控       | `tool/registry.ts`、`mcp/index.ts`、`acp/agent.ts` |
| 项目记忆与经验层     | 提供检索记忆、变更日志、项目 lessons，并自动注入上下文 | `memory/*`、`changelog/*`、`lesson/context.ts` |
| 验证与恢复层         | 在交付前执行验证；失败后进入反思与再研究流程           | `tool/selfcheck.ts`、`session/system.ts` |
| 长上下文稳定层       | 上下文超限时做 compaction，并清理历史大输出            | `session/compaction.ts`                   |

这套设计的目标是：每一轮不仅“完成任务”，还会让下一轮更快、更稳、更少重复犯错。

## 核心能力

### 1) Memory：跨会话保留项目上下文

Memory 用来把关键决策和约束持续保存下来，即使任务跨天、跨周、跨成员，也能保持一致性。

- 它具体做什么：支持结构化记忆写入，支持 keyword/semantic/hybrid 检索，并通过版本更新让新规则平滑替换旧规则。
- 什么时候用：多阶段迁移、长周期排障、多人接力开发这类“决策原因必须被记住”的场景。
- 例子：团队确定“认证方案采用短期 access token + 可轮换 refresh token”。两周后新增功能和安全修复仍会遵循同一策略，不需要反复在提示里重申。
- 价值：减少重复解释，降低上下文遗忘导致的冲突改动和回归。

### 2) Lessons：把事故沉淀为团队方法

Lessons 会把失败和修复沉淀到 `.codemate/lessons.md`，让经验能在后续任务中被真正复用。

- 它具体做什么：通过 `lesson_write` 持续记录并合并可执行经验，并在后续会话自动加载为项目上下文。
- 什么时候用：发布流程、运维动作、重复性工程任务等容易“同样问题反复发生”的地方。
- 例子：某次部署因漏执行数据库迁移而失败，团队写入经验“部署前必须做 schema 检查”。后续发布流程会自动带上这个前置守卫。
- 价值：改进会在项目层面持续累计，而不是只停留在某个人的临时记忆里。

### 3) Self-check：交付前先验证再收口

Self-check 是内置验证关卡：先跑检查，再根据结果修复并复检，直到达到可交付状态。

- 它具体做什么：默认支持 JS/TS 常见检查（typecheck、lint、test，按适用性执行），也支持自定义命令检查（如 `pytest`、`go test`、`cargo test`）。
- 什么时候用：重构、依赖升级、CI 敏感路径或任何“不能只靠主观判断”的改动。
- 例子：一次 TypeScript 重构本地看似可用，但 `selfcheck` 发现 lint 回归和一个单测失败；在交付前完成修复并复跑，避免把问题带进 PR/CI。
- 价值：显著减少“本地看起来好了，CI 才暴雷”的交付风险。

### 4) 深度研究：在不确定中做结构化决策

深度研究能力把“问题拆解 → 证据收集 → 报告输出”做成了完整流程，适合高不确定任务。

- 它具体做什么：先建立研究大纲，再补充研究项与字段，执行深度研究任务，最后产出带证据与不确定性说明的结构化报告。
- 什么时候用：供应商选型、架构取舍、合规/政策解读、外部依赖变化频繁的决策任务。
- 例子：在向量数据库选型时，对比写入吞吐、地域可用性、计费方式和迁移风险，最终得到可直接用于评审的决策报告，并明确哪些结论仍需补证据。
- 价值：在信息不完整、成本高的决策上，减少拍脑袋，提升决策质量和可解释性。

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

发起 PR 前请阅读 [CONTRIBUTING.zh.md](./CONTRIBUTING.zh.md)。
英文版本：[CONTRIBUTING.md](./CONTRIBUTING.md)。

---
