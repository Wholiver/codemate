# Codemate

> 一个基于 TaskGraph、闭环验证和多层记忆系统的多 agent 编程助手。

[English](./README.en.md)

## 简介

Codemate 是一个面向真实代码库的多 agent coding system，基于 opencode 演化而来。

它不是“单模型一次性改代码”的 CLI，而是把任务拆成不同职责 agent 协同完成：

- `orchestrator` 负责主控与编排
- `planner` 负责生成 TaskGraph
- `research / coder / tester` 执行研究、实现与测试
- `reviewer` 负责审查与验收
- `writer` 负责最终持久化收口

系统通过 closed-loop（自检、重试、漂移检测）降低长任务执行偏移和不稳定性。

## 核心特性

### 多 Agent 协作

Codemate 当前核心角色：

- `orchestrator`
- `planner`
- `research`
- `coder`
- `tester`
- `reviewer`
- `writer`

角色分离的目标是降低“一个 agent 同时做规划、编码、测试、总结”导致的混杂决策。

### TaskGraph 闭环执行

- `planner` 输出 TaskGraph
- 子任务通过依赖关系组织执行顺序
- `coder` 与 `tester` 在依赖允许时可并行执行
- `reviewer` 在实现和测试后执行审查
- `writer` 在执行链末端做 persistence finalization

### 自检、重试与意图防漂移

- `selfcheck`：统一验证关口
- `retry loop`：失败后进入修复循环
- `intent anchor`：固定任务目标语义
- `drift check`：定期检测偏航，必要时纠偏

这套机制用于避免任务在多轮执行中“越做越偏”。

### 三层上下文系统

Codemate 将长期与短期上下文分层处理：

- `supermemory`：用户偏好与长期记忆
- `lessons`：可复用工程经验与防错规则
- `changelog`：项目近期历史记录

关键边界：

- `writer` 只接收 `project lessons`，不接收 `global lessons`（避免 persistence 被全局噪声污染）
- `changelog` 只作为 historical context，不是 instructions
- recent changelog 仅注入 `orchestrator / planner / coder / tester / reviewer`，不注入 `writer / research`
- 显式记忆指令（`remember` / `记住` / `save this` 等）可在任意 step 写入 supermemory
- memory context 仅在 `step===1` 注入，避免每轮 prompt 膨胀

### Persistence Finalizer（Writer）

`writer` 是持久化收口角色，不是普通执行节点：

- 不进入常规 TaskGraph 执行队列
- 在主循环尾部兜底触发
- 写入 changelog
- 通过 `lesson_classify` / `lesson_write` 写入 lessons
- 当 `completedSubtasks > 0` 时，即使 git diff 为空，也不能直接 no-op

### TUI

- 终端首页已品牌化为 `CODEMATE`
- 可观察 agent 执行日志与闭环过程
- 保持终端可读性和低干扰交互

## 架构概览

```text
用户输入
  ↓
Session / Prompt Builder
  ↓
Orchestrator
  ↓
Planner → TaskGraph
  ↓
Research / Coder / Tester
  ↓
Reviewer / Selfcheck / Retry
  ↓
Writer
  ↓
Changelog / Lessons / Supermemory
```

简述：

1. Session 层组装 system prompt、历史消息与上下文注入。
2. Orchestrator 决定是否进入 TaskGraph 闭环。
3. Planner 拆解任务并生成依赖图。
4. Research/Coder/Tester 按图执行，Reviewer 做质量审查。
5. 失败进入 selfcheck/retry 修复回路。
6. Writer 在尾部统一做持久化写入。

## Agent 职责

| Agent | 职责 | 主要输入 | 主要输出 |
|---|---|---|---|
| Orchestrator | 主控与调度 | 用户请求、上下文 | 调度决策 |
| Planner | 任务拆解 | intent anchor、上下文 | TaskGraph |
| Research | 环境/资料调查 | 子任务、上下文 | research drafts |
| Coder | 实现 | TaskGraph 节点 | 代码改动 |
| Tester | 测试与验证 | 需求、实现目标 | 测试结果 |
| Reviewer | 审查与验收 | coder/tester 输出 | review 结果 |
| Writer | 持久化总结 | completed subtasks、diff/fallback、research drafts | changelog / lessons |

## 记忆与持久化

- `.codemate/changelog.md`：项目近期变更历史（历史上下文，不是指令）
- Project lessons：项目级可复用经验，优先服务当前仓库
- Global lessons：跨项目经验（对 writer 做了注入收紧，避免污染 persistence）
- Supermemory：本地长期记忆工具（支持 `add/search/list/profile/forget/help`，并支持显式记忆写入；不依赖外部 Supermemory API）

边界原则：

- lessons 是“可复用行为规则”
- changelog 是“近期历史事实”
- 两者不混用

## 安装与运行

> 需要 Bun `1.3.13`（见根 `package.json` 的 `packageManager`）。

```bash
# 安装依赖
bun install

# 在仓库根目录运行 codemate 开发入口
bun dev
```

常用开发命令（仓库根目录）：

```bash
bun typecheck
bun dev:web
bun dev:desktop
```

单包命令（`packages/codemate`）：

```bash
cd packages/codemate
bun dev
bun typecheck
bun test
```

## 贡献

提交前请优先阅读：

- [CONTRIBUTING.zh.md](./CONTRIBUTING.zh.md)
- [CONTRIBUTING.md](./CONTRIBUTING.md)

请勿提交以下内容：

- `.codemate` 运行产物
- 临时证书与私钥
- token / API key
- 本机绝对路径信息

## 测试

```bash
cd packages/codemate
bun typecheck
bun test test/session/prompt.test.ts
bun test test/tool/supermemory.test.ts
```

可选完整测试：

```bash
cd packages/codemate
bun test
```

## License

[MIT](./LICENSE)
