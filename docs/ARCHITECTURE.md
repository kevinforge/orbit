# Orbit Architecture

English / 简体中文

## Goal

Orbit P0 validates one local loop:

```text
User message
  -> selected or mentioned agent
  -> Claude Code CLI session
  -> clean final response
  -> chat message
```

The product is local-first. The server and both agents run on the user's machine.

## Runtime

```text
React UI
  -> POST /api/messages
  -> mention router
  -> AgentSession(agent1 | agent2)
  -> node-pty
  -> Claude Code CLI
  -> Claude Stop hook
  -> MessageStore
  -> SSE
  -> React UI
```

## Main Modules

| Path | Responsibility |
| --- | --- |
| `src/server/index.ts` | HTTP routes, SSE, message endpoint, Claude hook endpoint |
| `src/server/sse-hub.ts` | SSE client management |
| `src/server/static-server.ts` | Static UI serving |
| `src/core/agent-registry.ts` | Owns the two fixed agents |
| `src/core/agent-session.ts` | Starts Claude Code, sends prompts, detects completion |
| `src/core/mention-router.ts` | Parses `@agent1` and `@agent2` |
| `src/core/message-store.ts` | In-memory chat messages |
| `src/core/ansi-text-extractor.ts` | Basic terminal text cleanup |
| `src/core/claude-output-detector.ts` | Fallback Claude TUI output cleanup |
| `src/ui/App.tsx` | Chat UI, agent selection, `@` autocomplete, Markdown rendering |

## Completion

P0 uses Claude Code's `Stop` hook as the primary completion signal.

The hook script is:

```text
scripts/claude-stop-hook.mjs
```

It reads Claude Code hook JSON from stdin and posts the final assistant message to:

```text
POST /api/hooks/claude-stop
```

Fallback behavior still exists:

- `ORBIT_TURN_QUIET_MS` controls the quiet window
- Default: `180000` milliseconds
- `ORBIT_DISABLE_CLAUDE_STOP_HOOK=1` forces terminal-output completion fallback

## Agent Model

P0 agents are hardcoded:

```text
agent1
agent2
```

They are equal local Claude Code sessions. Work is assigned through `@agent1` or `@agent2` in the chat composer.

---

# Orbit 架构

## 目标

Orbit P0 只验证一个本地闭环：

```text
用户消息
  -> 选中或 @ 的 Agent
  -> Claude Code CLI 会话
  -> 干净的最终回复
  -> 聊天消息
```

产品本地优先。服务端和两个 Agent 都运行在用户本机。

## 运行链路

```text
React UI
  -> POST /api/messages
  -> mention router
  -> AgentSession(agent1 | agent2)
  -> node-pty
  -> Claude Code CLI
  -> Claude Stop hook
  -> MessageStore
  -> SSE
  -> React UI
```

## 主要模块

| 路径 | 职责 |
| --- | --- |
| `src/server/index.ts` | HTTP 路由、SSE、消息入口、Claude hook 入口 |
| `src/server/sse-hub.ts` | SSE 客户端管理 |
| `src/server/static-server.ts` | 静态前端资源服务 |
| `src/core/agent-registry.ts` | 管理两个固定 Agent |
| `src/core/agent-session.ts` | 启动 Claude Code、发送 prompt、判断完成 |
| `src/core/mention-router.ts` | 解析 `@agent1` 和 `@agent2` |
| `src/core/message-store.ts` | 内存聊天消息 |
| `src/core/ansi-text-extractor.ts` | 基础终端文本清洗 |
| `src/core/claude-output-detector.ts` | Claude TUI 兜底输出清洗 |
| `src/ui/App.tsx` | 聊天 UI、Agent 选择、`@` 候选、Markdown 渲染 |

## 完成判断

P0 优先使用 Claude Code `Stop` hook 作为完成信号。

hook 脚本：

```text
scripts/claude-stop-hook.mjs
```

它从 stdin 读取 Claude Code hook JSON，并把最终 assistant message 发送到：

```text
POST /api/hooks/claude-stop
```

兜底策略仍然保留：

- `ORBIT_TURN_QUIET_MS` 控制静默窗口
- 默认值：`180000` 毫秒
- `ORBIT_DISABLE_CLAUDE_STOP_HOOK=1` 可强制使用终端输出兜底完成判断

## Agent 模型

P0 写死两个 Agent：

```text
agent1
agent2
```

它们是两个对等的本地 Claude Code 会话。用户通过聊天输入框中的 `@agent1` 或 `@agent2` 分派工作。
