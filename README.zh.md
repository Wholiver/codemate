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
- [工作流闭环](#工作流闭环)
- [对比（给新用户快速判断）](#对比给新用户快速判断)
- [安装（JSR）](#安装jsr)

## 30 秒看懂价值

Codemate 的定位不是“调用模型回答问题”，而是“能持续进化的工程 Agent 运行时”。

| 支柱 | 内建能力 | 给用户的直接价值 |
| --- | --- | --- |
| Memory | 持久记忆 + 可检索结构 | 跨会话保留决策、偏好、排障经验 |
| Lessons | `.codemate/lessons.md` + `lesson_write` | 把错误和发现沉淀成可复用项目知识 |
| Self-check | `selfcheck` 默认与自定义验证 | 交付前拦截“看似完成但未验证” |
| Deep Research | `research-*` + `websearch/webfetch` | 高不确定任务有更稳的证据链 |
| 一体化运行时 | MCP + LSP + ACP 同栈集成 | 跨 TUI/CLI/Web/Server 行为更一致 |

如果你要的是“越用越懂项目”的 Agent，而不是一次性答题器，Codemate 就是为这个目标设计的。

## 核心功能

### Memory：超长期记忆系统

核心模块：`packages/codemate/src/memory/*`

- 记忆结构：`domain / path / version`
- 记忆工具：
  - `memory_create`
  - `memory_search`
  - `memory_read`
  - `memory_list`
- 检索模式：
  - `keyword`（关键词）
  - `semantic`（语义）
  - `hybrid`（推荐）
- 生命周期治理：
  - vitality（活性）评分
  - 衰减与清理
  - 去重与排序支持

用户价值：

- 关键决策和排障经验可以跨会话复用。
- 记忆不是聊天记录，而是项目知识资产。

### Lessons：自学习闭环

核心文件：`.codemate/lessons.md`  
写入工具：`lesson_write`

- 任务后写入 lessons
- 通过 `<project-lessons>` 回灌上下文
- lessons 聚焦：
  - 错误与规避方式
  - 弯路与避免复发
  - 关键发现与最终决策

用户价值：

- 同类错误显著减少。
- Agent 会形成“这个仓库专属经验”。

### Self-check：结果前自检

工具位置：`packages/codemate/src/tool/selfcheck.ts`

- JS/TS 默认检查：
  - `typecheck`
  - `lint`
  - `test`
- 非 JS/TS 可传自定义校验命令：
  - `pytest`
  - `go test ./...`
  - `cargo test`
- 失败后进入修复闭环：
  - 记录失败上下文
  - 更新 lessons/changelog
  - 补充研究并再次验证

用户价值：

- 降低无声失败概率。
- 复杂任务下结果稳定性更高。

### Deep Research：深度搜索能力

研究工具链：

- `research`
- `research-add-items`
- `research-add-fields`
- `research-deep`
- `research-report`

`research-deep` 支持结构化研究流程：

- 多项研究 outline
- 字段化提取
- 不确定性标记
- 面向来源交叉验证的采集方式

配合 `websearch` / `webfetch`，形成完整研究链路，而不是一次浅层搜索。

用户价值：

- 新框架、第三方 API、迁移决策这类高不确定任务更稳。
- 少拍脑袋，多证据。

## 工作流闭环

1. 理解目标与约束
2. 拉取相关长期记忆
3. 对不确定问题做深度研究
4. 执行改动
5. 运行 self-check
6. 回写 lessons + memory

核心不是“回答一次”，而是**持续进化的项目协作能力**。

## 对比（给新用户快速判断）

| 维度 | 与 OPENCODE 对比 | 与 Claude Code 对比 |
| --- | --- | --- |
| 运行时形态 | 当前活跃能力集中在 `packages/codemate/src/*`，核心模块收拢 | 完整开源，运行时可审计、可改造 |
| 记忆能力 | 内建持久记忆 + 检索 + 生命周期治理 | 跨会话项目上下文连续性更强 |
| 学习能力 | 原生 lessons 闭环（`.codemate/lessons.md` + `lesson_write`） | 项目知识可以制度化沉淀，而非一次性对话 |
| 结果可靠性 | 一等公民 selfcheck + 失败后反思修复流程 | 最终输出前的可控验证能力更强 |
| 搜索深度 | `research-*` + `websearch/webfetch` 组合成深度研究链路 | 更适合高不确定性工程决策场景 |
| 模型策略 | provider-agnostic，不绑定单一供应商 | 模型选择与成本策略更可控 |

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
