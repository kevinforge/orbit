# Orbit

Orbit 是一个本地优先的 Agent 协作控制台，用一个共享频道协调多个 CLI 后端 Agent 工作。

## 安装

```powershell
npm install -g orbit
```

## 启动

```powershell
orbit
```

打开 `http://localhost:4317`。

## 环境要求

Orbit 协调 CLI 后端 Agent，Agent 需要以下运行时：

| 运行时 | 安装方式 |
|--------|----------|
| Claude Code | `npm install -g @anthropic-ai/claude-code` |
| Codex | `npm install -g @openai/codex` |
| CodeBuddy | 参考官方文档 |

## 功能

- 四个内置 Agent：`@pm:`、`@architect:`、`@developer:`、`@tester:`
- 通过 UI 创建和配置自定义 Agent
- 每个 Agent 可配置权限（读写/运行/安装/git 提交）
- 支持一条消息同时给多个 Agent 派活
- 每个 Agent 有独立运行队列
- Agent 回复支持 Markdown 渲染
- 会话持久化，Agent 在多次运行间保留对话上下文