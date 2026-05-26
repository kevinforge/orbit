# Orbit

[English](./README.md)

Orbit 是一个本地优先的 Agent 协作控制台，用一个共享频道协调多个 Claude Code Agent 工作。

当前版本刻意保持克制，先验证核心协作闭环，再考虑在线同步、自定义 Agent 和多设备协作。

## 当前能力

- 一个本地频道：`Orbit P0`
- 四个内置 Agent：`@pm:`、`@architect:`、`@developer:`、`@tester:`
- 使用带冒号的显式派活语法，例如：`@developer: 检查当前项目`
- 支持一条频道消息里同时给多个 Agent 派活
- 每个 Agent 有独立运行队列，长任务不会阻塞整个频道
- 使用 Claude Code CLI 的非交互式 stream JSON 输出
- Agent 回复支持 Markdown 渲染
- 可折叠的 Activity 面板，用于展示工具和命令执行过程
- 会话持久化，Agent 在多次运行间保留对话上下文
- 频道历史注入，Agent 能看到上次完成后其他人的发言
- 本地 HTTP 服务和 SSE 实时推送

## 暂不包含

- 自定义创建 Agent
- 持久化数据库存储
- 在线同步或多设备支持
- Orbit 内置 GitHub PR 自动化
- 泛化工作流引擎或依赖调度器

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
npm run dev
```

打开 `http://localhost:4317`。

Windows PowerShell 下可以用下面的命令重启本地服务，并先释放默认端口：

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
