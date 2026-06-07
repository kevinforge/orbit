# Orbit

[English](./README.md)

Orbit 是一个本地优先的 Agent 协作控制台，用一个共享频道协调多个 CLI 后端 Agent 工作。

当前版本刻意保持克制，先验证核心协作闭环，再考虑在线同步和多设备协作。

## 当前能力

- 一个本地频道：`Orbit P0`
- 可在数字员工区域的 `+` 按钮中配置 Agent
- 四个内置 Agent：`@pm:`、`@architect:`、`@developer:`、`@tester:`
- 支持创建、编辑、启用/禁用、删除自定义 Agent
- 每个 Agent 可配置权限（读写/运行/安装/git 提交、允许的目录）
- 使用带冒号的显式派活语法，例如：`@developer: 检查当前项目`
- 支持一条频道消息里同时给多个 Agent 派活
- 每个 Agent 有独立运行队列，长任务不会阻塞整个频道
- 支持 Codex、Claude Code 和 CodeBuddy CLI 非交互式输出
- Agent 回复支持 Markdown 渲染
- 可折叠的 Activity 面板，用于展示工具和命令执行过程
- 会话持久化，Agent 在多次运行间保留对话上下文
- 每个 Agent 的运行时目录在 `.orbit/` 下隔离，避免 CLI 后端共享不兼容的本地会话
- 频道历史注入，Agent 能看到上次完成后其他人的发言
- 工作区级配置：每个工作区可配置共享系统提示词和规则
- 固定最大路由深度（默认 10），阻断消息包含深度信息
- 本地 HTTP 服务和 SSE 实时推送
- 独立可执行文件，源码编译为字节码保护

## 暂不包含

- 持久化数据库存储
- 在线同步或多设备支持
- Orbit 内置 GitHub PR 自动化
- 泛化工作流引擎或依赖调度器

## 安装

```powershell
npm install -g orbit
```

## 启动

```powershell
orbit
```

打开 `http://localhost:4317`。

## 开发模式

本地开发使用：

```powershell
npm install
npm run dev
```

## 环境要求

Orbit 协调 CLI 后端 Agent，Agent 需要以下运行时：

| 运行时 | 安装方式 |
|--------|----------|
| Claude Code | `npm install -g @anthropic-ai/claude-code` |
| Codex | `npm install -g @openai/codex` |
| CodeBuddy | 参考官方文档 |

### Agent 配置

Agent 可以通过数字员工区域的 `+` 按钮配置，也可以直接编辑配置文件：

```
~/.orbit/workspaces/<workspace-id>/agents.json
```

默认内置四个 Agent：`pm`、`architect`、`developer`、`tester`。可以在界面中添加、编辑、禁用或删除 Agent。禁用的 Agent 不参与路由——`@disabled_agent:` 这样的引用不会触发运行。

每个 Agent 配置包含：
- **id**：唯一标识符（字母数字、连字符、下划线）
- **name**：显示名称
- **description**：Agent 用途的简短描述
- **role**：`pm`、`architect`、`developer`、`tester`、`general` 之一
- **runtime**：`claude-code`、`codex` 或 `codebuddy`
- **systemPrompt**：每次运行时注入的系统提示词
- **permissionProfile**：读写/运行/安装/git 提交权限及允许的目录
- **enabled**：Agent 是否启用
- **ui.label**：可选显示标签覆盖

配置修改保存后立即生效。如果有 Agent 正在运行，保存会被拒绝并返回 409 响应。

**API 端点：**
- `GET /api/agents` — 列出所有 Agent 配置
- `PUT /api/agents` — 保存 Agent 配置（会先验证）
- `POST /api/agents/reset` — 恢复默认配置

### 工作区配置

每个工作区可以有工作区级别的设置，存储在：

```
~/.orbit/workspaces/<workspace-id>/config.json
```

工作区配置字段：

- **systemPrompt**（字符串，可选）：注入到该工作区每次 Agent 运行中的提示词，
  位于 Orbit 固定规则之后、Agent 角色指令之前。
- **rules**（字符串数组，可选）：注入到每次 Agent 运行中的工作区级规则列表，
  每条规则以项目符号形式渲染。

路由深度固定为 10，不可配置。

无自定义配置时，所有字段使用默认值（空提示词、空规则列表），
现有工作区和对话无需更改即可继续使用。

**API 端点：**
- `GET /api/workspace-config` — 获取当前工作区的配置
- `PUT /api/workspace-config` — 更新工作区配置（验证字段类型）

### 存储与保留

消息持久化在 `~/.orbit/conversations/<workspace-id>/<conversation-id>/messages/`，以每日 NDJSON 分片加 `manifest.json` 存储。打开对话时自动迁移现有的 `messages.json` 文件。

终端日志持久化在 `~/.orbit/transcripts/<workspace-id>/<conversation-id>/<agent-id>/`，以滚动日志分片存储。

服务器通过 `GET /api/state` 返回最近消息；更早的消息可通过 `GET /api/messages?before=<message-id>&limit=50` 加载。

可选环境变量：

- `ORBIT_PORT` — 服务端口（默认：4317）
- `ORBIT_MESSAGE_RECENT_SHARDS`
- `ORBIT_HISTORY_RETAIN_DAYS`
- `ORBIT_TRANSCRIPT_RETAIN_DAYS`
- `ORBIT_TRANSCRIPT_MAX_BYTES`
- `ORBIT_TRANSCRIPT_TAIL_BYTES`

## 验证

```powershell
npm run test
npm run build
```

## 目录结构

```text
src/
  core/      Agent 运行时、路由、队列、消息、输出清理
  server/    本地 HTTP/SSE 服务
  shared/    前后端共享 TypeScript 类型
  ui/        React 前端
tests/       Node 测试
docs/        架构文档
```

## 文档

- [架构说明](./docs/ARCHITECTURE.md)
- [贡献规范](./CONTRIBUTING.md)
- [Agent 工作流程](./AGENTS.md)
- [npm 包说明](./docs/standalone-build.md)