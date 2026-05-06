<pre align="center">
 ███   ███  ████  █████ █   █  ███  █████ █████ 
█     █   █ █   █ █     ██ ██ █   █   █   █     
█     █   █ █   █ ████  █ █ █ █████   █   ████  
█     █   █ █   █ █     █   █ █   █   █   █     
 ███   ███  ████  █████ █   █ █   █   █   █████ 
</pre>
<p align="center">开源的 AI Coding Agent。</p>
<p align="center">
  <a href="https://codemate.ai/discord"><img alt="Discord" src="https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord" /></a>
  <a href="https://www.npmjs.com/package/codemate_agent"><img alt="npm" src="https://img.shields.io/npm/v/codemate_agent?style=flat-square" /></a>
  <a href="https://github.com/Wholiver/codemate/actions/workflows/publish.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/Wholiver/codemate/publish.yml?style=flat-square&branch=dev" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a>
</p>

[![Codemate Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://codemate.ai)

---

### 安装

```bash
# npm（推荐）
npm i -g codemate_agent@latest

# 软件包管理器
npm i -g codemate_agent@latest     # 也可使用 bun/pnpm/yarn
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

Codemate 的安装包发布在 npm：[codemate_agent](https://www.npmjs.com/package/codemate_agent)。桌面端二进制可从 [发布页 (releases page)](https://github.com/Wholiver/codemate/releases) 下载。

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

#### 安装目录（npm）

使用 npm 全局安装时，可通过 npm prefix 控制二进制安装目录。

```bash
# 示例
npm_config_prefix=/usr/local npm i -g codemate_agent@latest
npm_config_prefix=$HOME/.local npm i -g codemate_agent@latest
```

### Agents

Codemate 内置两种 Agent，可用 `Tab` 键快速切换：

- **build** - 默认模式，具备完整权限，适合开发工作
- **plan** - 只读模式，适合代码分析与探索
  - 默认拒绝修改文件
  - 运行 bash 命令前会询问
  - 便于探索未知代码库或规划改动

另外还包含一个 **general** 子 Agent，用于复杂搜索和多步任务，内部使用，也可在消息中输入 `@general` 调用。

了解更多 [Agents](https://codemate.ai/docs/agents) 相关信息。

### 文档

更多配置说明请查看我们的 [**官方文档**](https://codemate.ai/docs)。

### 参与贡献

如有兴趣贡献代码，请在提交 PR 前阅读 [贡献指南 (Contributing Docs)](./CONTRIBUTING.md)。

### 基于 Codemate 进行开发

如果你在项目名中使用了 “codemate”（如 “codemate-dashboard” 或 “codemate-mobile”），请在 README 里注明该项目不是 Codemate 团队官方开发，且不存在隶属关系。

### 常见问题 (FAQ)

#### 这和 OPENCODE、Claude Code 有什么不同？

| 与 OPENCODE 对比 | 与 Claude Code 对比 |
| --- | --- |
| - 客户端/服务器架构，支持多客户端。<br>- 更强调终端优先 (TUI)，由 [terminal.shop](https://terminal.shop) 团队打造。<br>- 内置长期记忆与自学习闭环。 | - 100% 开源。<br>- 不绑定单一提供商：可用 Claude、OpenAI、Google 或本地模型（也推荐 [Codemate Zen](https://codemate.ai/zen)）。<br>- 开箱即用的 LSP 支持。 |

---

**加入我们的社区** [飞书](https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=738j8655-cd59-4633-a30a-1124e0096789&qr_code=true) | [X.com](https://x.com/codemate)
