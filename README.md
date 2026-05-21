# Orbit

English / 简体中文

Orbit is a local-first chat control surface for coordinating Claude Code agents from one channel.

P0 intentionally keeps the product small:

- One local channel
- Two fixed agents: `agent1` and `agent2`
- `@agent` routing from the composer
- Lightweight `@` autocomplete
- Long-running Claude Code CLI sessions managed through PTY
- Markdown rendering for agent replies
- Claude Code `Stop` hook support for clean turn completion

## Not Included In P0

- Custom agent creation
- Structured task boards or task cards
- Visible terminal panels in the main UI
- Multi-channel workspaces
- Multi-user collaboration
- Online sync or multi-device support

## Requirements

- Node.js
- npm
- Claude Code CLI available on `PATH`

## Install

```powershell
npm install
```

## Run

```powershell
npm run build
npm run dev
```

Open `http://localhost:4317`.

To restart the local service on Windows PowerShell and clear the default port first:

```powershell
cd D:\projects\claude-code-study\orbit; $p = Get-NetTCPConnection -LocalPort 4317 -State Listen -ErrorAction SilentlyContinue; if ($p) { Stop-Process -Id $p.OwningProcess -Force }; npm run dev
```

## Test

```powershell
npm run test
npm run build
```

## Repository Layout

```text
src/
  core/      Agent sessions, routing, message store, output cleanup
  server/    Local HTTP/SSE server
  shared/    Shared TypeScript types
  ui/        React UI
scripts/     Claude Code hook scripts
tests/       Node test suite
docs/        Minimal architecture documentation
```

## Documentation

- [Architecture](./docs/ARCHITECTURE.md)

---

# Orbit 简体中文

Orbit 是一个本地优先的 Agent 协作控制台，用一个聊天频道协调多个 Claude Code Agent。

P0 阶段刻意保持很小：

- 一个本地频道
- 两个固定 Agent：`agent1` 和 `agent2`
- 输入框支持 `@agent` 路由
- 输入 `@` 后出现轻量 Agent 候选
- 每个 Agent 背后是一个长期运行的 Claude Code CLI PTY 会话
- Agent 回复支持 Markdown 渲染
- 优先使用 Claude Code `Stop` hook 判断一轮回复结束

## P0 暂不包含

- 自定义创建 Agent
- 结构化任务看板或任务卡片
- 主界面中的可见终端面板
- 多频道工作区
- 多用户协作
- 在线同步或多设备支持

## 环境要求

- Node.js
- npm
- Claude Code CLI 已加入 `PATH`

## 安装

```powershell
npm install
```

## 启动

```powershell
npm run build
npm run dev
```

打开 `http://localhost:4317`。

Windows PowerShell 下一键重启本地服务，并先释放默认端口：

```powershell
cd D:\projects\claude-code-study\orbit; $p = Get-NetTCPConnection -LocalPort 4317 -State Listen -ErrorAction SilentlyContinue; if ($p) { Stop-Process -Id $p.OwningProcess -Force }; npm run dev
```

## 验证

```powershell
npm run test
npm run build
```

## 目录结构

```text
src/
  core/      Agent 会话、路由、消息存储、输出清洗
  server/    本地 HTTP/SSE 服务
  shared/    前后端共享 TypeScript 类型
  ui/        React 前端
scripts/     Claude Code hook 脚本
tests/       Node 测试
docs/        精简架构文档
```

## 文档

- [架构说明](./docs/ARCHITECTURE.md)
