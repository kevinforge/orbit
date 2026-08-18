# Orbit

Orbit 是一个本地优先的数字员工协作工作台，可以在相互隔离的工作区和会话中协调多个 CLI 后端数字员工。

## 安装

安装与你的操作系统匹配的发布包：

```powershell
npm install -g .\orbit-<version>-windows-x64.tgz
```

公开 npm 发布准备好之后，可以安装 scoped 包：

```powershell
npm install -g @kevinforge/orbit
```

也可以从源码运行：

```powershell
npm ci
npm run build
npm run dev
```

不要从公开 npm 安装 `orbit`。公开 npm 上的 `orbit` 是另一个无关项目，可能会在启动时报 `ERR_PACKAGE_PATH_NOT_EXPORTED` 和 `uuid/v1` 错误。

## 启动

```powershell
orbit
```

打开 `http://localhost:4317`。

第一次使用请阅读 [中文快速上手](docs/QUICKSTART.zh-CN.md)，英文版见 [Quickstart](docs/QUICKSTART.md)。

## 环境要求

Orbit 需要 Node.js 22 或更高版本，并且至少有一个可用的运行时：

| 运行时 | 安装方式 |
|--------|----------|
| Claude Code | 安装 Orbit 时已内置 ACP 适配器，只需准备 Claude Code 并完成登录 |
| Codex | 安装 Orbit 时已内置 ACP 适配器，只需准备 Codex 并完成登录 |
| CodeBuddy（需要支持 ACP） | `npm install -g @tencent-ai/codebuddy-code` |

## 功能

- 每个团队都支持三种内置会话模式：普通对话、简单协作，以及使用内置监工的复杂协作
- 内置“软件开发团队”模板，包含四个可自定义名称的数字员工，同时支持用户自定义团队
- 通过 UI 创建和配置自定义数字员工
- 每条消息可选择“向我审批”或“完全批准”，由数字员工职责和当前任务决定具体操作
- 支持空白和软件开发团队数字员工团队模板
- 支持多会话、后台执行和正在工作的数字员工状态展示
- 支持明确指派、员工交接和每个数字员工独立任务队列
- 协作洞察：任务结果、协作规模、执行时间线和耗时趋势
- 数字员工回复支持 Markdown
- 会话可在多次运行之间持久化
- Claude Code、Codex 和 CodeBuddy 使用原生 ACP v1 传输，支持结构化工具活动、人工审批、任务取消和结构化用户反问（表单与外部 URL）

## 许可证与安全

Orbit 使用 [MIT License](LICENSE) 开源。安全问题请按照 [SECURITY.md](SECURITY.md) 中的方式报告。

## 支持

Bug 报告、功能请求、安全报告和 1.0 RC 验证支持范围请见 [SUPPORT.md](https://github.com/kevinforge/orbit/blob/main/SUPPORT.md)。

## 本地数据

Orbit 将本地产品数据存储在 `~/.orbit` 下。数据布局、备份、恢复和重置说明见 [docs/DATA_DIRECTORY.md](docs/DATA_DIRECTORY.md)。

## 术语与路由

公开产品术语和使用自定义名称进行 `@名称:` 指派的规则见 [docs/TERMINOLOGY_AND_ROUTING.md](docs/TERMINOLOGY_AND_ROUTING.md)。

## 贡献

开发流程见 [CONTRIBUTING.md](CONTRIBUTING.md)，发布候选验证见 [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md)。首个 1.0 发布候选说明草稿在 [docs/RELEASE_NOTES_v1.0.0-rc.1.md](docs/RELEASE_NOTES_v1.0.0-rc.1.md)。
