# Orbit

[Chinese](./README.zh-CN.md)

Orbit is a local-first chat control surface for coordinating multiple Claude Code agents in one shared channel.

The current version is intentionally small. It validates the core workflow before adding online sync, custom agents, or multi-device collaboration.

## Features

- One local channel: `Orbit P0`
- Four built-in agents: `@pm:`, `@architect:`, `@developer:`, `@tester:`
- Explicit assignment syntax with a colon, for example `@developer: inspect the current project`
- Multiple agent assignments in one channel message
- Per-agent run queue, so long-running work does not block the whole channel
- Claude Code and CodeBuddy CLI runtimes using non-interactive stream JSON output
- Markdown rendering for agent replies
- Collapsible activity panel showing tool and command progress
- Session persistence so agents retain conversation context across runs
- Channel history injection so agents see what others said since their last run
- Local HTTP server with Server-Sent Events

## Not Included Yet

- Custom agent creation
- Persistent database storage
- Online sync or multi-device support
- GitHub PR workflow automation inside Orbit
- General workflow engine or dependency scheduler

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
npm run dev
```

Open `http://localhost:4317`.

By default, every built-in agent uses Claude Code. To run selected agents through
CodeBuddy CLI, set `ORBIT_AGENT_RUNTIMES` before starting Orbit:

```powershell
$env:ORBIT_AGENT_RUNTIMES="developer=codebuddy,tester=codebuddy"; npm run dev
```

Supported runtime values are `claude-code` and `codebuddy`.

To restart the local service on Windows PowerShell and clear the default port first:

```powershell
cd D:\projects\claude-code-study\orbit; $p = Get-NetTCPConnection -LocalPort 4317 -State Listen -ErrorAction SilentlyContinue; if ($p) { Stop-Process -Id $p.OwningProcess -Force }; npm run dev
```

## Verify

```powershell
npm run test
npm run build
```

## Repository Layout

```text
src/
  core/      Agent runtime, routing, queueing, messages, output cleanup
  server/    Local HTTP/SSE server
  shared/    Shared TypeScript types
  ui/        React UI
tests/       Node test suite
docs/        Architecture documentation
```

## Documentation

- [Architecture](./docs/ARCHITECTURE.md)
- [Contributing](./CONTRIBUTING.md)
- [Agent Workflow](./AGENTS.md)
