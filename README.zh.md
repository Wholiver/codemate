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

## 一眼看懂 Codemate

Codemate 不是“只会调模型的命令行壳”。它是一个完整 Agent 运行时，核心是四件事：

- **Memory 超长期记忆**（跨会话持续可用）
- **Lessons 自学习**（做完任务后沉淀经验）
- **Self-check 自检**（最终回复前做验证）
- **Deep Research 深度搜索**（复杂问题走研究流程）

如果你要的是“越用越懂项目”的 Agent，而不是一次性答题器，Codemate 就是为这个目标设计的。

## 你做出的核心功能（重点）

### 1）Memory：超长期记忆系统

Memory 在 Codemate 里是核心模块（`packages/codemate/src/memory/*`），不是附加笔记。

- 记忆数据天然带有 **domain / path / version** 结构
- 工具层直接提供：
  - `memory_create`
  - `memory_search`
  - `memory_read`
  - `memory_list`
- `memory_search` 支持三种模式：
  - `keyword`（关键词）
  - `semantic`（语义）
  - `hybrid`（推荐，混合）
- 记忆生命周期具备：
  - vitality（活性）评分
  - 衰减与清理
  - 检索排序信号
- 对于“有持续价值”的任务，系统提示会推动写入 memory，确保上下文可以跨会话复用。

用户能直接感知到的价值：

- 上周定过的策略、踩过的坑、偏好配置，不会每次都从头再讲。
- 记忆不是聊天记录，而是可检索、可演化的项目知识。

### 2）Lessons：自学习闭环

Codemate 把“学习”做成了显式机制。

- lessons 文件位置：`.codemate/lessons.md`
- 通过 `lesson_write` 工具更新
- 系统会把 lessons 重新注入上下文（`<project-lessons>`）
- lessons 的内容重点是：
  - 遇到的错误与规避方式
  - 走过的弯路与避免复发
  - 关键发现与最终决策

用户能直接感知到的价值：

- 同类错误越来越少。
- Agent 会逐步形成“这个仓库专属”的工作经验。

### 3）Self-check：结果前自检

Codemate 内置 `selfcheck` 工具（`packages/codemate/src/tool/selfcheck.ts`）。

- JS/TS 默认检查：
  - `typecheck`
  - `lint`
  - `test`
- 非 JS/TS 可传自定义校验命令：
  - 例如 `pytest`、`go test ./...`、`cargo test`
- 失败后不是一句“失败了”，而是进入修复闭环：
  - 记录失败上下文
  - 更新 lessons/changelog
  - 补充研究并再次验证

用户能直接感知到的价值：

- 明显减少“看起来完成了，但其实没验证过”的交付。
- 在复杂任务里更稳，不容易无声失败。

### 4）Deep Research：深度搜索能力

Codemate 有完整 research 工具链，而不是只做一次浅层搜索。

- 研究相关工具：
  - `research`
  - `research-add-items`
  - `research-add-fields`
  - `research-deep`
  - `research-report`
- `research-deep` 支持结构化研究流程：
  - 基于 outline 的多项研究
  - 字段化提取
  - 不确定性标记
  - 面向来源交叉验证的采集方式
- 配合 `websearch` / `webfetch`（以及可选 Exa 路径）做信息闭环。

用户能直接感知到的价值：

- 面对新框架、第三方 API、迁移方案这类高不确定任务时，正确率和可解释性更高。
- 少拍脑袋，多证据链。

## 真实任务是怎么跑起来的

1. 理解任务目标与约束
2. 拉取相关长期记忆
3. 对不确定问题进行深度研究
4. 执行改动
5. 运行 self-check
6. 回写 lessons + memory，让下一次更聪明

这套流程的核心不是“回答一次问题”，而是**持续进化的项目协作能力**。

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
