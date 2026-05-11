# Codemate 贡献指南

<sub><a href="./CONTRIBUTING.md">English</a> · 简体中文</sub>

感谢你为 Codemate 做贡献。

Codemate 当前处于 **Beta** 阶段，迭代节奏较快，因此我们更重视清晰、可审查、可验证的改动。

## 快速清单

- 基于 `dev` 分支开发（默认开发分支）。
- 保持改动聚焦、尽量小步提交。
- 检查命令在 package 目录执行（不要在仓库根目录跑测试）。
- PR 里写清楚验证步骤和结果。

## 本地开发启动

```bash
bun install
bun dev
```

本地 Web 调试（前后端分开）：

```bash
bun run --cwd packages/codemate --conditions=browser ./src/index.ts serve --port 4096
bun --cwd packages/app dev -- --port 4444
```

## 分支规则

- 贡献目标分支：`dev`
- 不要直接向 `main` 提交改动
- 生成 diff 时使用 `dev` / `origin/dev`

## 质量检查

提交 PR 前建议至少执行：

```bash
bun lint
bun typecheck
```

测试请在对应 package 目录执行：

```bash
bun --cwd packages/codemate test
bun --cwd packages/app test:unit
bun --cwd packages/core test
```

不要在仓库根目录跑测试（根目录 `bun test` 被刻意阻止）。

## 代码生成与迁移

重新生成 SDK/OpenAPI 相关产物：

```bash
./script/generate.ts
```

生成 SQLite 迁移：

```bash
bun --cwd packages/codemate run db generate --name <slug>
```

## 不要手改生成文件

示例：

- `packages/sdk/js/src/gen/*.ts`
- `packages/sdk/js/src/v2/gen/**/*.ts`
- `packages/codemate/src/provider/models-snapshot.js`
- `packages/codemate/src/provider/models-snapshot.d.ts`
- `packages/desktop/src/bindings.ts`
- `sst-env.d.ts`

请通过脚本重新生成，不要手动编辑。

## Commit 与 PR 要求

PR 标题和 commit message 建议使用 conventional commits：

- `feat: ...`
- `fix: ...`
- `docs: ...`
- `chore: ...`
- `refactor: ...`
- `test: ...`

同时请满足：

- 关联 issue（例如：`Fixes #123`）。
- 写明验证命令和结果。
- UI 改动附截图或视频。

## 评审期望

- 以正确性为先，不追求“花哨”实现。
- 除非有意变更并说明，否则保持现有行为不变。
- 命名与结构尽量与现有代码风格一致。

## 致谢

高质量的小步 PR，是这个项目最快的推进方式。
