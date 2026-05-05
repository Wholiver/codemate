<p align="center">
  <a href="https://codemate.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="Codemate logo">
    </picture>
  </a>
</p>
<p align="center">在项目内部越用越聪明的 AI Coding Agent。</p>
<p align="center">
  <a href="https://codemate.ai/discord"><img alt="Discord" src="https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord" /></a>
  <a href="https://www.npmjs.com/package/codemate-ai"><img alt="npm" src="https://img.shields.io/npm/v/codemate-ai?style=flat-square" /></a>
  <a href="https://github.com/Wholiver/codemate/actions/workflows/publish.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/Wholiver/codemate/publish.yml?style=flat-square&branch=dev" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a>
</p>

[![Codemate Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://codemate.ai)

---

大多数 AI Coding 工具在每个会话时都会从头开始。Codemate 不同。它在项目内部构建一个**活的项目大脑** — 记忆、经验和历史会随时间不断积累，持久化存储在 SQLite 数据库中。在同一个项目里用得越久，Codemate 就越懂你的代码库、你的模式、你的规范。

### Codemate 如何在项目内变得越聪明

#### 1. 项目记忆 — 常驻、永不过时

关于项目的每一点知识都会被持久化存储在 SQLite 中，跨会话、跨重启、跨机器重启都能保留。记忆系统不仅仅是存储事实，还在管理它们：

- **活跃度评分（Vitality）** — 频繁访问的记忆保持突出（活跃度 0→1）。很少使用的会自然衰减向 0。系统知道什么对你的项目重要。
- **版本链** — 记忆内容变化时，不是覆盖而是创建新版本。历史被保留，旧版本在需要时可以追溯。
- **混合搜索** — 结合关键词匹配和 LSH 语义嵌入。意图感知：事实性查询权重偏关键词；探索性查询权重偏语义。有别名系统，可以用不同名称引用同一段记忆。
- **自动合并** — 如果同一主题存在多个碎片，Codemate 会自动合并，不会产生重复噪音。
- **生命周期管理** — 记忆会随时间衰减（30 天半衰期，未使用时）。低活跃度的条目会被清理。系统保持精简且相关。

#### 2. 经验 Lessons — 反馈循环

每个任务完成后，Codemate 会将经验写入 `.codemate/lessons.md`。这些经验在**每个新任务开始时**都会作为上下文加载 — 所以它在开始前就立即了解你的项目规范、坑点、和模式：

> "这个项目用特性开关来控制所有新功能。"
> "不要直接提交到 main — 要用 PR 工作流。"
> "数据库 schema 是真相来源，而不是 ORM 模型。"

经验不断积累。它们是关于什么可行、什么不可行的明确的人类可读记录。

#### 3. 变更日志 Changelog — 可搜索的历史

每个重要变更都会被记录在按项目划分的变更日志中，包含时间戳、改动的文件、和摘要。在开始新任务之前，Codemate 可以搜索这个历史，了解最近的上下文 — 谁做了什么改动、为什么。

#### 4. 复合效应

这些系统一起在每个任务启动时注入到 Codemate 的上下文窗口：

```
新任务启动
  → 从 .codemate/lessons.md 加载经验    （我们知道什么可行）
  → 加载最近的变更日志                    （最近发生了什么变化）
  → 搜索项目记忆                          （我们知道的其他一切）
  → Agent 从所有这些构建上下文
  → Agent 执行任务
  → Agent 写入新经验、更新记忆、追加到变更日志
```

10 次会话后，Codemate 了解你的项目结构、团队的规范、之前导致 bug 的模式、以及可行的模式。50 次会话后，它成为真正的项目专家。

### 其他功能

- **双内置 Agent** — 用 `Tab` 切换：`build`（默认，全权限）和 `plan`（只读，执行 bash 前会询问）
- **不绑定提供商** — 支持通过 [Codemate Zen](https://codemate.ai/zen) 使用 Claude、OpenAI、Google 或本地模型
- **内置 LSP 支持** — 开箱即用的代码智能
- **客户端/服务器架构** — 后端可无头运行，支持从任意前端（TUI、Web、桌面）驱动
- **插件系统** — 通过 `@codemate-ai/plugin` 扩展
- **100% 开源**

### 安装

```bash
# 直接安装 (YOLO)
curl -fsSL https://codemate.ai/install | bash

# 软件包管理器
npm i -g codemate-ai@latest        # 也可使用 bun/pnpm/yarn
scoop install codemate             # Windows
choco install codemate             # Windows
brew install anomalyco/tap/codemate # macOS 和 Linux（推荐，始终保持最新）
brew install codemate              # macOS 和 Linux（官方 brew formula，更新频率较低）
sudo pacman -S codemate            # Arch Linux (Stable)
paru -S codemate-bin               # Arch Linux (Latest from AUR)
mise use -g codemate               # 任意系统
nix run nixpkgs#codemate           # 或用 github:anomalyco/codemate 获取最新 dev 分支
```

> [!TIP]
> 安装前请先移除 0.1.x 之前的旧版本。

### 桌面应用程序 (BETA)

Codemate 也提供桌面版应用。可直接从 [发布页 (releases page)](https://github.com/anomalyco/codemate/releases) 或 [codemate.ai/download](https://codemate.ai/download) 下载。

| 平台                  | 下载文件                              |
| --------------------- | ------------------------------------- |
| macOS (Apple Silicon) | `codemate-desktop-darwin-aarch64.dmg` |
| macOS (Intel)         | `codemate-desktop-darwin-x64.dmg`     |
| Windows               | `codemate-desktop-windows-x64.exe`    |
| Linux                 | `.deb`、`.rpm` 或 AppImage            |

```bash
# macOS (Homebrew Cask)
brew install --cask codemate-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/codemate-desktop
```

#### 安装目录

安装脚本按照以下优先级决定安装路径：

1. `$CODEMATE_INSTALL_DIR` - 自定义安装目录
2. `$XDG_BIN_DIR` - 符合 XDG 基础目录规范的路径
3. `$HOME/bin` - 如果存在或可创建的用户二进制目录
4. `$HOME/.codemate/bin` - 默认备用路径

```bash
# 示例
CODEMATE_INSTALL_DIR=/usr/local/bin curl -fsSL https://codemate.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://codemate.ai/install | bash
```

### 文档

更多配置说明请查看我们的 [**官方文档**](https://codemate.ai/docs)。

### 参与贡献

如有兴趣贡献代码，请在提交 PR 前阅读 [贡献指南 (Contributing Docs)](./CONTRIBUTING.md)。

### 常见问题 (FAQ)

#### 这和 Claude Code 有什么不同？

功能上很相似，关键差异：

- 100% 开源。
- 不绑定特定提供商。推荐使用 [Codemate Zen](https://codemate.ai/zen) 的模型，但也可搭配 Claude、OpenAI、Google 甚至本地模型。模型迭代会缩小差异、降低成本，因此保持 provider-agnostic 很重要。
- 内置 LSP 支持。
- 聚焦终端界面 (TUI)。Codemate 由 Neovim 爱好者和 [terminal.shop](https://terminal.shop) 的创建者打造，会持续探索终端的极限。
- 客户端/服务器架构。可在本机运行，同时用移动设备远程驱动。TUI 只是众多潜在客户端之一。

---

**加入我们的社区** [飞书](https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=738j8655-cd59-4633-a30a-1124e0096789&qr_code=true) | [X.com](https://x.com/codemate)