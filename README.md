# Orbit

Orbit is a local-first chat control surface for coordinating multiple CLI-backed agents in one shared channel.

## Install

```powershell
npm install -g orbit
```

## Run

```powershell
orbit
```

Open `http://localhost:4317`.

## Requirements

Orbit coordinates CLI-backed agents. The agents require:

| Runtime | Install |
|---------|---------|
| Claude Code | `npm install -g @anthropic-ai/claude-code` |
| Codex | `npm install -g @openai/codex` |
| CodeBuddy | See official docs |

## Features

- Four built-in agents: `@pm:`, `@architect:`, `@developer:`, `@tester:`
- Custom agent creation and configuration via UI
- Per-agent permissions (read/write/run/install/git commit)
- Multiple agent assignments in one message
- Per-agent run queue
- Markdown rendering for agent replies
- Session persistence across runs