# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Required GitHub Workflow

Claude Code must follow the repository workflow in `AGENTS.md`.

Current boundary:

- Agents may create issues, create branches, edit code, run tests, commit, push, open draft PRs, inspect CI, and push CI fixes.
- Agents must not merge PRs into `main`.
- Agents must not push directly to `main`.
- Agents must not force push, delete `main`, bypass CI, or auto-merge without explicit user approval.
- The user owns the final `Squash and merge` decision.

Because this is currently a private repository on a no-cost GitHub setup, branch protection may show as not enforced. Treat the workflow as mandatory anyway.

For every non-trivial change:

```text
request or issue -> feature branch -> failing tests -> implementation -> npm run test -> npm run build -> commit -> push -> draft PR -> CI -> human merge
```

## Build & Run Commands

```powershell
npm install                  # Install dependencies
npm run dev                  # Start dev server (port 4317), Vite dev server (port 5173) proxies API calls to it
npm run build                # Type-check with tsc --noEmit, then build UI with Vite to dist/ui/
npm run test                 # Run all tests
npm run test:glob            # Alternative: run tests via glob pattern
```

Run a single test file:
```powershell
node --test --import tsx tests/mention-router.test.ts
```

Port is configurable via `ORBIT_PORT` env var (default 4317).

## Architecture Overview

Orbit is a local-first chat control surface that coordinates multiple Claude Code CLI agents in one shared channel. Users type messages with `@agent:` assignment syntax; the system routes tasks to agents, manages run queues, and streams results to a React UI via SSE.

### Tech Stack

- TypeScript (strict, ESM, `--noEmit` only), Node.js ES2022
- React 19 + Vite 8 (UI in a single `App.tsx`, no router or state library)
- Raw `node:http` server (no Express/Koa)
- Node.js built-in test runner (`node --test`)
- Claude Code CLI spawned as child process in non-interactive `stream-json` mode

### Core Data Flow

```
User message (POST /api/messages)
  → ChannelRouter → mention-router (parses @agent: markers)
    → RunManager (per-agent serial queue)
      → AgentSession → buildChannelContext() → claude CLI (stream-json)
        → EventBus → SseHub → browser (EventSource)
        → RunManager classifies activities (tool.started, etc.)
          → on completion: next queued run starts, agent replies can trigger further routing
```

Agent replies can contain `@other_agent:` assignments, enabling delegation chains capped at depth 5.

### Key Modules

- **`src/server/index.ts`** — Composition root: wires all components, HTTP routes, starts server
- **`src/shared/types.ts`** — All shared type definitions for the system
- **`src/core/channel-router.ts`** + **`mention-router.ts`** — Message routing and @mention parsing
- **`src/core/run-manager.ts`** — Per-agent FIFO run queue, lifecycle events, activity classification
- **`src/core/claude-cli-runtime.ts`** — Spawns `claude --print --output-format stream-json`, parses stdout
- **`src/core/codex-cli-runtime.ts`** — Spawns Codex CLI in JSONL mode, parses output
- **`src/core/codebuddy-cli-runtime.ts`** — Spawns CodeBuddy CLI in stream-json mode, parses output
- **`src/core/agent-runtime.ts`** — Shared runtime interface for all CLI adapters
- **`src/core/agent-config-store.ts`** — Persistent agent configuration (load/save/reset via JSON file)
- **`src/core/channel-context-builder.ts`** — Builds private system prompt injected into each Claude run
- **`src/core/channel-history.ts`** — Builds scoped channel history (messages since agent's last completed run)
- **`src/core/session-store.ts`** — Per-agent session persistence for `--resume`
- **`src/core/agent-profiles.ts`** — Four built-in agent profiles (pm, architect, developer, tester)
- **`src/core/agent-session.ts`** — Manages one agent's lifecycle (idle/running/error/stopped)
- **`src/core/agent-registry.ts`** — Owns AgentSession instances, exposes agent state
- **`src/core/message-store.ts`** — Message persistence (in-memory + optional file-based storage)
- **`src/core/event-bus.ts`** — Typed pub/sub event bus for runtime events
- **`src/core/terminal-transcript-store.ts`** — Per-agent terminal output logging with ANSI stripping
- **`src/core/workspace-store.ts`** — Workspace resolution and metadata (path-based isolation)
- **`src/core/claude-output-detector.ts`** — Detects tool.started/completed/failed from Claude stream events
- **`src/core/ansi-text-extractor.ts`** — Strips ANSI codes and extracts readable text
- **`src/core/agent-prompt.ts`** — Prompt templates for agent role instructions

### UI Module

- **`src/ui/App.tsx`** — Single-page React app (all UI in one file, no router)
- **`src/ui/styles.css`** — "Warm Observatory" design system (CSS custom properties, no Tailwind)
- **`src/ui/markdown-renderer.ts`** — Markdown→HTML with code block headers (language label + copy button)

### Built-in Agents

| ID | Can Write Files | Can Run Commands | Can Install Deps |
|---|---|---|---|
| pm | No | No | No |
| architect | No | Yes | No |
| developer | Yes | Yes | Yes |
| tester | No | Yes | No |

The developer agent creates feature branches, commits, pushes, and opens draft PRs. Other agents cannot git commit. Profiles are hardcoded in `agent-profiles.ts`.

### API Surface

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/state` | Full state snapshot |
| POST | `/api/messages` | Send user message (`{ content: string }`) |
| GET | `/api/agents` | List agent configurations |
| PUT | `/api/agents` | Update agent configurations |
| POST | `/api/agents/reset` | Reset agents to default configuration |
| GET | `/events` | SSE stream of all runtime events |
| GET | `/*` | Static files from `dist/ui/` |

### Key Patterns

- **EventBus pub/sub**: `SseHub`, `TerminalTranscriptStore`, and `RunManager` all subscribe to `RuntimeEvent` variants on a shared bus
- **Per-agent serial queue**: Each agent runs one CLI process at a time; additional tasks queue automatically
- **Private context injection**: Each agent prompt is wrapped with a private routing context block; leaked markers are stripped from replies
- **In-memory state**: All state (messages, agent statuses, queued runs) lives in memory with no persistence layer

### UI Design System ("Warm Observatory")

The UI uses a warm cream + deep teal design system, implemented entirely in CSS custom properties. No dark mode support.

**Design tokens** (all in `:root` CSS variables):
- **Surfaces**: `--bg-base: #f5f3ef` (warm cream), `--bg-sidebar: #eeebe5`, `--bg-surface: #ffffff`
- **Accent**: `--accent: #0f766e` (deep teal), `--secondary: #c2410c` (burnt sienna for inline code)
- **Shadows**: 5-tier warm-tinted system (`--shadow-xs` through `--shadow-xl`)
- **Typography**: Plus Jakarta Sans (Google Fonts import), no Inter/Roboto
- **Animations**: Custom cubic-bezier easing (`--ease-out`, `--ease-spring`)

When modifying UI: use CSS variables, never hardcode colors. Keep all changes in `styles.css`. JSX changes in `App.tsx` only.

### Routing Rules

- `@agent:` with a colon assigns work; plain `@agent` is just a reference
- Multiple assignments in one message are allowed
- Self-assignments are ignored
- `@all` is explicitly unsupported
- Route depth capped at 5 to prevent infinite delegation loops
