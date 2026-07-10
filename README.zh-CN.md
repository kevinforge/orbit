# Orbit

Orbit 是一个本地优先的数字员工协作工作台，可以在相互隔离的工作区和会话中协调多个 CLI 后端数字员工。

## 安装

安装公开 npm 包：

```powershell
npm install -g @kevinforge/orbit
```

也可以安装与你的操作系统匹配的 GitHub Release 发布包：

```powershell
npm install -g .\orbit-<version>-windows-x64.tgz
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

Orbit 负责协调 CLI 后端数字员工。数字员工至少需要一个可用的运行时 CLI：

| 运行时 | 安装方式 |
|--------|----------|
| Claude Code | `npm install -g @anthropic-ai/claude-code` |
| Codex | `npm install -g @openai/codex` |
| CodeBuddy | `npm install -g @tencent-ai/codebuddy-code` |

## 功能

- 五个内置数字员工模板：产品经理（`pm`）、架构师（`architect`）、开发（`developer`）、测试（`tester`）、监督者（`supervisor`）
- 通过 UI 创建和配置自定义数字员工
- 为每个数字员工配置文件访问、命令执行、依赖安装和 git 操作权限
- 支持空白工作区和多数字员工协作工作区模板
- 支持多会话、后台执行和正在工作的数字员工状态展示
- 支持明确指派、员工交接和每个数字员工独立任务队列
- 协作洞察：任务结果、协作规模、执行时间线和耗时趋势
- 数字员工回复支持 Markdown
- 会话可在多次运行之间持久化

## 许可证与安全

Orbit 使用 [MIT License](LICENSE) 开源。安全问题请按照 [SECURITY.md](SECURITY.md) 中的方式报告。

## 支持

Bug 报告、功能请求、安全报告和支持范围请见 [SUPPORT.md](https://github.com/kevinforge/orbit/blob/main/SUPPORT.md)。

## 本地数据

Orbit 将本地产品数据存储在 `~/.orbit` 下。数据布局、备份、恢复和重置说明见 [docs/DATA_DIRECTORY.md](docs/DATA_DIRECTORY.md)。

## 术语与路由

公开产品术语和 `@developer:` 这类指派标记规则见 [docs/TERMINOLOGY_AND_ROUTING.md](docs/TERMINOLOGY_AND_ROUTING.md)。

## 贡献

开发流程见 [CONTRIBUTING.md](CONTRIBUTING.md)，发布验证见 [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md)。1.0 正式版说明见 [docs/RELEASE_NOTES_v1.0.0.md](docs/RELEASE_NOTES_v1.0.0.md)。
