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

Commit message hygiene is mandatory:

- The first line must be the real conventional subject, such as
  `fix: allow agent handoff final answers (#38)`.
- Never make `@`, `@agent`, `@agent:`, `wip`, or `temp` the commit subject.
- If multiple `-m` flags are used, remember that the first `-m` becomes the
  subject. Put detailed notes in later `-m` flags only.
- Before pushing, run `git log -1 --format=%s`. If the subject is wrong, amend
  or squash before pushing.

For every non-trivial change:

```text
request or issue -> feature branch -> failing tests -> implementation -> npm run test -> npm run build -> commit -> push -> draft PR -> CI -> human merge
```

## Engineering & Product Principles

`AGENTS.md` is the source of truth for working principles (Think Before Coding, Engineering Principles, Product Principles). The essentials, restated for every change:

- **Smallest correct change.** Minimum code, no speculative features or abstractions; every changed line traces to the request. Reuse existing utilities and patterns rather than introducing new ones.
- **Verify, do not assert.** Prefer a failing test that reproduces the bug or proves the feature, then make it pass. Run `npm run test` and `npm run build` before committing, and report what actually passed — never claim "done" while a check fails or was skipped.
- **Do not break the user's flow.** Never leave an agent stuck or swallow an error silently; interruption, cancellation, and failure must leave recoverable state.
- **Local-first is a promise.** Data loss (messages, sessions, agent/workspace configs) is a serious bug; file writes must not corrupt on crash.
- **Speak the user's language.** User-facing text uses product terms (数字员工) and stays consistent in EN and ZH; never leak internal codewords (`run`, `supervisor`, `routeState`) into user-visible messages.

## Build & Run Commands

```powershell
npm install                  # Install dependencies
npm run dev                  # Start dev server (port 4317), Vite dev server (port 5173) proxies API calls to it
npm run build                # Type-check + Vite UI build + Bun compile standalone binary (dist/bin/orbit)
npm run build:all            # Build standalone binaries for all platforms (Windows, Linux, macOS x64/ARM64)
npm run test                 # Run all tests
npm run test:glob            # Alternative: run tests via glob pattern
npm run smoke:start          # Start built binary and verify GET /api/state
npm run smoke:port-conflict  # Verify occupied ORBIT_PORT exits with a recovery hint
```

Run a single test file:
```powershell
node --test --import tsx tests/mention-router.test.ts
```

Port is configurable via `ORBIT_PORT` env var (default 4317).

## Build Output

- `dist/bin/orbit.exe` (Windows) or `dist/bin/orbit` — standalone executable with embedded Bun runtime
- `dist/ui/` — UI static assets
- `--bytecode --minify --sourcemap=none` — source code compiled to binary bytecode for protection

See `docs/standalone-build.md` for distribution and installation instructions.

## Architecture Overview

Orbit is a local-first chat control surface that coordinates multiple digital employees in one shared conversation. Users type messages with `@agent:` assignment syntax; the system routes tasks to employees, manages run queues, and streams results to a React UI via SSE.

### Tech Stack

- TypeScript (strict, ESM, `--noEmit` only), Node.js ES2022
- React 19 + Vite 8 (single-page UI, no router or state library; tdesign-react desktop components)
- Raw `node:http` server (no Express/Koa)
- Node.js built-in test runner (`node --test`)
- All three runtimes run as ACP v1 child processes: Claude Code via `claude-agent-acp`, Codex via `codex-acp` (both bundled adapters, resolved by `bundled-runtime.ts` with user PATH fallback), and CodeBuddy via `codebuddy --acp`

### Core Data Flow

```
User message (POST /api/messages)
  → MessageRouter → mention-router (parses @agent: markers)
    → RunManager (per-agent serial queue)
      → AgentSession → buildAgentContext() → selected ACP runtime adapter (Claude Code, Codex, or CodeBuddy)
        → EventBus → SseHub → browser (EventSource)
        → RunManager classifies activities (tool.started, etc.)
          → on completion: next queued run starts, agent replies can trigger further routing
```

The user message's approval mode (`ask` | `full-access`) follows the entire handoff chain for all runtimes. `AgentSession` exposes pending ACP permission requests and elicitations through state/SSE; `POST /api/permissions/resolve` and `POST /api/elicitations/resolve` resume the blocked request.

Agent replies can contain `@other_agent:` assignments, enabling delegation chains capped at depth 10.

### Key Modules

- **`src/server/index.ts`** — Composition root: wires all components, HTTP routes, starts server
- **`src/server/conversation-context.ts`** — Per-conversation context (messages, agents, run manager, message router)
- **`src/shared/types.ts`** — All shared type definitions for the system
- **`src/core/message-router.ts`** + **`mention-router.ts`** — Message routing and @mention parsing
- **`src/core/run-manager.ts`** — Per-agent FIFO run queue, lifecycle events, activity classification
- **`src/core/acp-runtime.ts`** — Shared ACP v1 runtime core (JSON-RPC transport, session lifecycle, streamed update mapping)
- **`src/core/acp-runner-registry.ts`** — Maps runtime kinds to their ACP runner definitions
- **`src/core/acp-connection-pool.ts`** — Reusable ACP process pool (TTL and idle-cap bounded)
- **`src/core/acp-output-guard.ts`** — Keeps ACP progress chatter out of final answers
- **`src/core/claude-acp-runtime.ts`** — Claude Code ACP adapter
- **`src/core/codex-acp-runtime.ts`** — Codex ACP adapter
- **`src/core/codebuddy-acp-runtime.ts`** — CodeBuddy ACP adapter (spawns `codebuddy --acp`)
- **`src/core/bundled-runtime.ts`** — Resolves Orbit-bundled ACP adapter executables before PATH fallback
- **`src/core/agent-runtime.ts`** — Shared runtime interface for all ACP adapters
- **`src/core/agent-config-store.ts`** — Persistent employee configuration (load/save/reset via JSON file) and `AGENT_TEAM_TEMPLATES`
- **`src/core/agent-context-builder.ts`** — Builds private system prompt injected into each agent run
- **`src/core/agent-history-builder.ts`** — Builds scoped conversation history (messages since agent's last completed run)
- **`src/core/session-store.ts`** — Per-employee ACP session persistence with transport metadata
- **`src/core/agent-profiles.ts`** — Internal supervisor (监工) profile and default employee profiles
- **`src/core/channel-watch.ts`** — Trigger service that schedules employees on unassigned/blocked/failed channel events
- **`src/core/agent-session.ts`** — Manages one agent's lifecycle (idle/running/error/stopped)
- **`src/core/agent-registry.ts`** — Owns AgentSession instances, exposes agent state
- **`src/core/message-store.ts`** — Persisted message shards, manifest recovery, and cursor pagination
- **`src/core/event-bus.ts`** — Typed pub/sub event bus for runtime events
- **`src/core/terminal-transcript-store.ts`** — Per-agent terminal output logging with ANSI stripping
- **`src/core/workspace-store.ts`** — Workspace resolution and metadata (path-based isolation)
- **`src/core/conversation-store.ts`** — Conversation CRUD and metadata
- **`src/core/claude-output-detector.ts`** — Detects tool.started/completed/failed from Claude stream events
- **`src/core/ansi-text-extractor.ts`** — Strips ANSI codes and extracts readable text
- **`src/core/agent-prompt.ts`** — Prompt templates for agent role instructions
- **`src/core/migrate-channel-layer.ts`** — One-time migration for flattening legacy directory structure
- **`src/core/workspace-config-store.ts`** — Workspace-level system prompt and rules persistence
- **`src/core/workspace-presets.ts`** + **`workspace-agent-presets.ts`** — Built-in workspace setup templates aligned with employee team templates
- **`src/core/attachment-store.ts`** — Image attachment drafts (pending upload) and permanent per-conversation storage
- **`src/core/global-config-store.ts`** — Global settings persistence (e.g., run logs)
- **`src/core/runtime-probe.ts`** — Probes runtime availability for setup guidance
- **`src/core/work-analysis.ts`** — Workspace task, collaboration, outcome, and duration aggregation
- **`src/server/workspace-work-analysis.ts`** — Bounded history loading for collaboration insights

### UI Module

- **`src/ui/App.tsx`** — Main single-page React app (conversation, employees, workspaces, composer)
- **`src/ui/TaskDetailDrawer.tsx`** — Task/run detail drawer with execution timeline
- **`src/ui/WorkAnalysisPanel.tsx`** — Collaboration insights panel
- **`src/ui/styles.css`** — "Warm Observatory" design system (CSS custom properties, no Tailwind)
- **`src/ui/markdown-renderer.ts`** — Markdown→HTML with code block headers (language label + copy button)
- **`src/ui/url-guard.ts`** — Allows only http(s) external URLs to guard against `javascript:`/`data:` XSS

### Digital Employee Teams

Employee configuration is fully user-editable per workspace (`agents.json`). `AGENT_TEAM_TEMPLATES` in `agent-config-store.ts` seeds the built-in software development team:

| ID | Name | Runtime | Role |
|---|---|---|---|
| requirements | 范同经 | codex | Clarify requirements, scope, and acceptance criteria |
| solution | 甄架构 | codex | Design solutions and evaluate risk |
| implementation | 蔡一平 | claude-code | Implement and verify changes |
| verification | 田小坑 | codebuddy | Validate results and report regressions |

Users can rename employees, edit prompts, add or remove employees (`PUT /api/agents`), or apply a whole team template (`POST /api/agents/apply-team`). The supervisor (监工) that coordinates 复杂协作 (supervised) mode is internal (`agent-profiles.ts`), not user-configurable; ids `all`, `user`, and `supervisor` are reserved. Per-employee permission settings no longer exist — the user message's approval mode applies to the entire handoff chain.

### API Surface

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/state` | Full state snapshot |
| POST | `/api/messages` | Send user message (`{ content: string }`) |
| GET | `/api/messages?before=<id>&limit=<n>` | Load older messages for the active conversation |
| POST | `/api/permissions/resolve` | Resolve a pending ACP permission request |
| POST | `/api/elicitations/resolve` | Resolve a pending ACP elicitation |
| POST | `/api/conversation/interrupt` | Stop all tasks in the active conversation: queued runs are discarded, running runs cancel |
| POST | `/api/runs/:id/cancel` | Cancel a queued or running employee task |
| POST | `/api/attachments/drafts` | Upload an image draft attachment for the active conversation |
| GET | `/api/attachments/drafts/:workspaceId/:conversationId/:id` | Fetch a draft attachment (composer preview) |
| DELETE | `/api/attachments/drafts/:workspaceId/:conversationId/:id` | Delete a draft attachment |
| GET | `/api/attachments/:workspaceId/:conversationId/:id` | Fetch a committed attachment |
| GET | `/api/agents` | List employee configurations |
| GET | `/api/agent-teams` | List digital employee team templates |
| PUT | `/api/agents` | Update employee configurations |
| POST | `/api/agents/reset` | Reset employees to default configuration |
| POST | `/api/agents/apply-team` | Apply a team template to the workspace |
| POST | `/api/runtimes/probe` | Probe runtime availability |
| GET | `/api/workspace-config` | Get workspace-level prompt and rules |
| PUT | `/api/workspace-config` | Update workspace-level prompt and rules |
| GET | `/api/workspace-presets` | List built-in workspace setup templates |
| GET | `/api/global-config` | Get global settings |
| PUT | `/api/global-config` | Update global settings |
| GET | `/api/work-analysis?days=<n>` | Build workspace collaboration insights |
| GET | `/api/workspaces` | List workspaces |
| POST | `/api/workspaces` | Create workspace |
| PUT | `/api/workspaces/:id` | Update workspace |
| DELETE | `/api/workspaces/:id` | Delete workspace |
| POST | `/api/workspaces/:id/switch` | Switch active workspace |
| POST | `/api/workspaces/pick-directory` | Open the native directory picker |
| GET | `/api/conversations` | List conversations for the active workspace |
| GET | `/api/workspaces/:id/conversations` | List conversations for any workspace |
| POST | `/api/conversations` | Create conversation |
| PUT | `/api/conversations/:id` | Update conversation |
| PUT | `/api/conversations/:id/interaction-mode` | Set interaction mode (`direct` / `collaborative` / `supervised`) |
| DELETE | `/api/conversations/:id` | Delete conversation |
| POST | `/api/conversations/:id/switch` | Switch active conversation |
| GET | `/events` | SSE stream of all runtime events |
| GET | `/*` | Static files from `dist/ui/` |

### Key Patterns

- **EventBus pub/sub**: `SseHub`, `TerminalTranscriptStore`, and `RunManager` all subscribe to `RuntimeEvent` variants on a shared bus
- **Per-agent serial queue**: Each employee runs one task at a time (one ACP run per employee); additional tasks queue automatically
- **Private context injection**: Each agent prompt is wrapped with a private routing context block; leaked markers are stripped from replies. Precedence: app fixed rules → workspace config → agent role instruction
- **Multi-conversation parallel**: Multiple conversations can run agents simultaneously via a context map with LRU eviction
- **In-memory state**: Messages and agent state live in memory per conversation context; file-based persistence for messages, sessions, and transcripts

### Data Directory Structure

```
~/.orbit/
├── conversations/{workspaceId}/conversations.json
├── conversations/{workspaceId}/{conversationId}/messages/
│   ├── manifest.json
│   └── YYYY-MM-DD.ndjson
├── conversations/{workspaceId}/{conversationId}/attachments/
│   └── <attachmentId>.<ext>   (committed image attachments)
├── transcripts/{workspaceId}/{conversationId}/{agentId}/
│   └── YYYY-MM-DD-<sequence>.log
├── sessions/{workspaceId}/{runtime}/{channelId}/{conversationId}/{agentId}.json
│   ({runtime} is claude-code | codex | codebuddy; stores ACP session ids and transport metadata)
├── tmp/attachments/{workspaceId}/{conversationId}/
│   └── <draftId>.<ext>        (upload drafts pending send)
├── workspaces/{workspaceId}/
│   ├── workspace.json
│   ├── agents.json
│   └── config.json         (workspace-level systemPrompt and rules)
└── last-active.json
```

### UI Design System ("Warm Observatory")

The UI uses a warm cream + deep teal design system, implemented entirely in CSS custom properties. No dark mode support.

**Design tokens** (all in `:root` CSS variables):
- **Surfaces**: `--bg-base: #f5f3ef` (warm cream), `--bg-sidebar: #eeebe5`, `--bg-surface: #ffffff`
- **Accent**: `--accent: #0f766e` (deep teal), `--secondary: #c2410c` (burnt sienna for inline code)
- **Shadows**: 5-tier warm-tinted system (`--shadow-xs` through `--shadow-xl`)
- **Typography**: Plus Jakarta Sans (Google Fonts import), no Inter/Roboto
- **Animations**: Custom cubic-bezier easing (`--ease-out`, `--ease-spring`)

When modifying UI: use CSS variables, never hardcode colors. Keep styling in `styles.css`; JSX lives in `App.tsx`, `TaskDetailDrawer.tsx`, and `WorkAnalysisPanel.tsx`. Reuse tdesign-react components where a desktop-style control fits.

### Routing Rules

- `@agent:` with a colon assigns work; plain `@agent` is just a reference
- Multiple assignments in one message are allowed
- Self-assignments are ignored
- Route depth capped at 10 to prevent infinite delegation loops
