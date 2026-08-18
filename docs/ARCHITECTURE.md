# Orbit Architecture

Orbit is a local-first agent collaboration app. The current implementation runs one local HTTP server, one React UI, and multiple CLI-backed agent runs on the user's machine.

## Runtime Flow

```text
React UI
  -> POST /api/messages
  -> MessageStore
  -> MessageRouter
  -> RunManager
  -> AgentRegistry / AgentSession
  -> Runtime adapter
  -> Claude Code ACP, Codex ACP, or CodeBuddy ACP
  -> Runtime stream events
  -> MessageStore + TerminalTranscriptStore
  -> SSE
  -> React UI
```

The runtime no longer uses PTY sessions or CLI hooks. A run is considered complete when the selected runtime turn returns a clean final answer.

## Core Modules

| Path | Responsibility |
| --- | --- |
| `src/server/index.ts` | Local HTTP routes, SSE wiring, message intake |
| `src/server/sse-hub.ts` | Server-Sent Events client management |
| `src/server/static-server.ts` | Static UI serving |
| `src/core/agent-profiles.ts` | Built-in employee templates and config-to-profile conversion |
| `src/core/agent-config-store.ts` | Persistent agent configuration (load/save/reset/validate) |
| `src/core/agent-registry.ts` | Owns agent sessions and exposes agent state |
| `src/core/agent-session.ts` | Starts one runtime adapter run, tracks status, and owns pending permission and elicitation decisions |
| `src/core/agent-runtime.ts` | Shared runtime adapter contract |
| `src/core/acp-runtime.ts` | Shared ACP v1 client, session, approval, elicitation, cancellation, and activity mapping |
| `src/core/acp-runner-registry.ts` | Single registry for built-in ACP runtime definitions, instances, and availability probes |
| `src/core/acp-output-guard.ts` | Bounded NDJSON frame and stderr diagnostics handling |
| `src/core/acp-connection-pool.ts` | Conversation-isolated ACP process reuse with idle TTL eviction |
| `src/core/claude-acp-runtime.ts` | Starts the external Claude Code ACP adapter |
| `src/core/codex-acp-runtime.ts` | Starts the external Codex ACP adapter and maps approval modes to Codex agent modes |
| `src/core/codebuddy-acp-runtime.ts` | Runs CodeBuddy through ACP v1 and maps session updates into Orbit events |
| `src/core/run-manager.ts` | Per-agent run queue and lifecycle events |
| `src/core/message-router.ts` | Routes user and agent messages containing explicit assignments |
| `src/core/mention-router.ts` | Parses `@display-name:` assignment markers |
| `src/core/agent-context-builder.ts` | Builds private context passed into each agent run |
| `src/core/agent-history-builder.ts` | Builds scoped channel history for each agent run |
| `src/core/workspace-config-store.ts` | Load/save per-workspace configuration (systemPrompt, rules) |
| `src/core/conversation-store.ts` | Conversation metadata persistence per workspace |
| `src/core/message-store.ts` | Workspace-persisted channel messages, shard manifests, and pagination |
| `src/core/work-analysis.ts` | Aggregates message trees into task outcomes, collaboration, timelines, and duration metrics |
| `src/server/workspace-work-analysis.ts` | Loads workspace conversation history for `GET /api/work-analysis` |
| `src/core/session-store.ts` | Per-agent backend session persistence, including transport metadata |
| `src/core/workspace-store.ts` | Workspace CRUD, isolation, and user directory persistence |
| `src/core/terminal-transcript-store.ts` | Workspace-persisted runtime activity transcript segments |
| `src/core/history-retention.ts` | Best-effort cleanup for old message shards and transcript segments |
| `src/core/claude-output-detector.ts` | Clean final answer validation and stream event mapping |
| `src/server/conversation-context.ts` | Bundles per-conversation runtime state (stores, agents, router) |
| `src/ui/App.tsx` | Chat UI, agent buttons, composer, workspace/conversation selectors |

## Agents

Digital employees are configured via `AgentConfigStore` and persisted per-workspace in `~/.orbit/workspaces/<workspace-id>/agents.json`. The software development team template seeds four employees:

| Routing marker | Display name | Default runtime |
| --- | --- | --- |
| `@范同经:` | 范同经 | `codex` |
| `@甄架构:` | 甄架构 | `codex` |
| `@蔡一平:` | 蔡一平 | `claude-code` |
| `@田小坑:` | 田小坑 | `codebuddy` |

These defaults can be modified, disabled, or removed through the settings UI. Custom employees can be added with any of the supported runtimes and their own system prompt. Only enabled employees participate in routing.

### Two-Layer Model

- **`AgentConfig`** (`src/shared/types.ts`): Persistence and UI model containing an internal id, display name, description, runtime, systemPrompt, enabled state, and optional triggers.
- **`AgentProfile`** (`src/shared/types.ts`): Runtime model used by `AgentRegistry` and `AgentSession` �?includes the resolved workspace cwd.

`configsToProfiles()` in `agent-profiles.ts` converts enabled `AgentConfig` entries to `AgentProfile` instances. The system prompt describes each employee's responsibilities; there is no role field or per-employee permission matrix.

### Config Store

`AgentConfigStore` (`src/core/agent-config-store.ts`) handles:
- **load**: Reads `agents.json`, returns seed defaults if missing or corrupted
- **save**: Validates then writes with atomic file swap
- **reset**: Restores the built-in software development team configs
- **validateAgentConfigs**: Checks internal id and display-name format, uniqueness, reserved names, runtime validity, systemPrompt, and trigger settings

### Runtime Refresh

When config is saved or reset, the server calls `refreshEnabledAgents()` which:
1. Filters to enabled configs, converts to profiles
2. Stops all current agent sessions
3. Creates a new `AgentRegistry` and starts fresh sessions
4. Disposes the old `RunManager` (unsubscribes from EventBus)
5. Creates a new `RunManager` and `MessageRouter` with the updated agent set

This ensures routing and run dispatch use the current agent configuration. A 409 response is returned if any agent is currently running.

## Routing Rules

- Only `@display-name:` with a colon assigns work. The display name is configurable; the internal id is never used in public markers.
- Plain `@agent` mentions are references and do not trigger routing.
- Unknown `@xx:` mentions are silently ignored (no error, no routing).
- Direct mode routes to exactly one employee and never routes handoffs from employee replies.
- Collaborative and supervised modes can assign work to multiple employees and route employee handoffs.
- Supervised mode also enables the built-in supervisor for unassigned goals, progress checks, and failure recovery.
- Each assigned agent receives the full channel message as context.
- Self-assignments are ignored in modes where employee handoffs are enabled.
- Existing assignments in the same channel message are treated as already scheduled.

The three mode rules are built into Orbit and apply to both built-in and custom teams. They do not depend on workspace prompts or rules.

### Route Depth

Agent-to-agent routing chains are capped at a fixed depth of 10. Each agent reply that contains new assignments increments the chain depth. When a message would exceed the limit, routing is blocked and a system message is posted.

### Workspace Configuration

Each workspace can have workspace-level settings (`WorkspaceConfig`) that apply to all agent runs in all conversations within that workspace:

- `systemPrompt`: Shared user-authored context injected into every employee run after Orbit's fixed mode rules.
- `rules`: User-authored workspace rules rendered as bullet points in the employee context.

Stored at `~/.orbit/workspaces/<workspaceId>/config.json`. Can be updated at runtime via `PUT /api/workspace-config`.

### Prompt Assembly Precedence

The final agent prompt is assembled in this order:

1. **Orbit fixed context** (employee identity, available employees, and the current built-in interaction mode rules)
2. **Final answer rules** (output format constraints)
3. **Workspace system prompt** (from `WorkspaceConfig.systemPrompt`, if set)
4. **Workspace rules** (from `WorkspaceConfig.rules`, if set)
5. **Employee instruction** (`AgentConfig.systemPrompt`)
6. **Channel history** (scoped messages since agent's last completed run)
7. **Current task** (the routed message content)

Workspace prompts inject optional shared user context across all employees, while each employee retains its own task-specific instruction. They do not define or replace Orbit's three interaction modes. Complex collaboration uses a separate internal supervisor profile, and its persisted runtime session is retained when the conversation switches to another mode.

`WorkspaceConfigStore` (`src/core/workspace-config-store.ts`) manages load/save with atomic writes and graceful fallback to defaults when the file is missing or corrupted.

## Channel History

Each agent run receives a scoped history of channel messages since that agent's last completed run. This lets agents see what other agents (and the user) said while they were idle, complementing the `--resume` flag which preserves each agent's own CLI session.

`buildHistoryForAgent` in `src/core/agent-history-builder.ts` builds the history:

- Scans messages from newest to oldest, starting after the agent's last `status: "done"` message
- Skips system messages, messages still running, and routed source messages
- Splits eligible messages into two groups: "older" and "recent" (last 6)
- Recent entries are kept in full (no per-entry truncation)
- Older entries are truncated to 500 characters with a `[truncated: original message was N chars]` marker
- Caps total history at 12000 characters (`MAX_HISTORY_CHARS`)
- Returns entries in chronological order

The history is injected between `[Orbit Context]` and `[Full channel message]` in the prompt built by `agent-context-builder.ts`.

## Session Persistence

Each agent's backend session ID is persisted via `src/core/session-store.ts`. Session records are namespaced by runtime, channel, conversation, and agent so switching an agent between Codex, Claude Code, and CodeBuddy does not reuse an incompatible session ID. Records also identify the transport and protocol version when available. On subsequent runs, ACP runtimes prefer `session/resume` when advertised and otherwise use `session/load`; load-time history notifications are ignored because Orbit's message store remains the canonical conversation history. If restoration fails (e.g. session expired), the store is cleared and the run retries with a new session.

Session files are stored under `~/.orbit/sessions/<workspaceId>/<runtime>/<channelId>/<conversationId>/<agentId>.json`, namespaced by runtime, channel, conversation, and agent.

## Workspace Isolation

Each project directory gets its own isolated workspace via `src/core/workspace-store.ts`:

- **Workspace ID**: deterministic 12-char hex derived from the project's absolute cwd using SHA-256. On Windows the path is lowercased before hashing to handle case-insensitive filesystems; on Linux/macOS the original case is preserved.
- **Data directory**: `~/.orbit/` organized by data type, with workspace as an isolation dimension:
  - `workspaces/<workspace-id>/workspace.json` - metadata (id, name, path, createdAt, lastOpenedAt)
  - `workspaces/<workspace-id>/agents.json` - per-workspace agent configurations (`AgentConfigStore`)
  - `sessions/<workspace-id>/<runtime>/<channelId>/<conversationId>/<agentId>.json` - per-agent session records (`SessionStore`)
  - `conversations/<workspace-id>/<conversationId>/messages/manifest.json` - message shard index (`MessageStore`)
  - `conversations/<workspace-id>/<conversationId>/messages/<YYYY-MM-DD>.ndjson` - persisted channel message shards (`MessageStore`)
  - `workspaces/<workspace-id>/config.json` - workspace configuration (`WorkspaceConfigStore`)
  - `conversations/<workspace-id>/conversations.json` - conversation metadata (`ConversationStore`)
  - `transcripts/<workspace-id>/<conversationId>/<agentId>/<YYYY-MM-DD>-<sequence>.log` - per-agent terminal transcript segments (`TerminalTranscriptStore`)
  - `last-active.json` - last active workspace and conversation for restart recovery
- **Lifecycle**: on startup, the server checks `last-active.json` for the previously active workspace/conversation. Switching does not stop active work; running conversation contexts remain alive in the context map.

## Workspace & Conversation Management

The server keeps one active UI pointer while retaining multiple live conversation contexts through `src/server/conversation-context.ts`:

- **ConversationContext**: bundles per-conversation runtime state (MessageStore, TerminalTranscriptStore, AgentRegistry, RunManager, MessageRouter).
- **Context map**: contexts are keyed by workspace and conversation, created lazily, and retained while users switch elsewhere so work can continue in the background.
- **LRU bound**: up to 10 inactive contexts are retained; idle contexts may be evicted, but contexts with running agents are never evicted.
- **WorkspaceStore CRUD**: list, create, update, delete workspaces. Deleting a workspace removes its live contexts and persisted data.
- **ConversationStore**: manages conversation metadata per workspace at `conversations/<workspaceId>/conversations.json`.
- **Running summaries**: `/api/state` reports active employees for all retained contexts so the sidebar can identify background work.

Codex ACP uses the user's normal Codex home. Orbit does not create per-agent `CODEX_HOME` directories; agent-level continuity is handled by the session store above, which passes each agent's saved session ID back to the adapter on the next run.

## Runtime Transports

Orbit runs each backend through a runtime adapter. Codex uses:

```text
codex-acp
```

Claude Code uses:

```text
claude-agent-acp
```

CodeBuddy uses:

```text
codebuddy --acp
```

All three runtimes use ACP v1 over newline-delimited JSON-RPC on stdio. Runtime events are converted into:

- final assistant text
- tool/activity events
- runtime output for diagnostics

ACP message chunks are grouped by assistant message ID. Orbit keeps visible progress in runtime output, ignores hidden thought chunks, and stores only the explicit final phase or the last main assistant message as the chat result. Each newline-delimited JSON frame is bounded independently, so long tasks remain supported while a malformed or unbounded frame only fails its own run. Stderr is retained in a bounded diagnostic tail.

The ACP runner registry is the single source for built-in runtime definitions, instances, and availability probes. A successfully completed turn releases its adapter process into an idle pool for a short TTL. Reuse is restricted to the same conversation, employee, workspace, command, and approval mode. Sessions remain independent, and a failed, cancelled, interrupted, or unhealthy process is destroyed instead of returned to the pool. Shutdown drains the pool explicitly.

Backend sessions are restored through ACP when they are not already loaded in a reused process. Cancellation uses `session/cancel` before Orbit terminates an unresponsive process after a short grace period. ACP permission requests are controlled by the message's approval mode; no bypass-permissions CLI flag is used. Codex starts in `agent` mode for "ask" and `agent-full-access` for "full access". Orbit advertises ACP plan updates and elicitation support for form and URL modes. Native plan snapshots are stored as run activity and displayed in the task drawer.

The composer stores an `ApprovalMode` on each user message, and `RunManager` copies it to result messages so downstream handoffs preserve the same choice. In `ask` mode, `AgentSession` publishes a `permission.requested` event and keeps the ACP request pending until the local HTTP approval endpoint resolves it. In `full-access` mode, ACP requests are approved automatically for that task. Both modes select ACP one-time decisions only. Interrupting or stopping a run rejects and clears any pending request. Permission and elicitation requests also expire after 30 minutes so abandoned agent turns cannot wait forever. Elicitation uses separate `elicitation.requested` and `elicitation.resolved` events and `/api/elicitations/resolve`, so user input is not treated as a security approval.

## Activity Stream

Activity events are derived from runtime stream output or ACP session updates and shown in the chat card:

- run accepted / started / completed / failed
- tool started / completed / failed
- native ACP plan updated / removed
- runtime produced output

The UI keeps running activities expanded and scrolls to the latest event. Completed cards are collapsed by default and can be expanded manually.

## State

Agent statuses and run queues are in memory. Messages and terminal transcripts are persisted to the workspace data directory and survive server restarts.

Messages are stored as daily NDJSON shards with a manifest. `MessageStore` automatically migrates the legacy `messages.json` file when a conversation is opened, loads only the most recent shards on startup, and exposes cursor pagination through `GET /api/messages?before=<message-id>&limit=50`.

Terminal transcripts are stored as per-agent log segments. Segments roll when they exceed `ORBIT_TRANSCRIPT_MAX_BYTES`, and startup only returns the latest tail for each agent to keep `/api/state` bounded.

On startup, `history-retention.ts` runs best-effort cleanup. It skips the active conversation, removes expired message shards while keeping the latest shards, and removes expired transcript segments while keeping each agent's latest segment. Cleanup failures are logged and do not block startup.

Retention and load limits can be tuned with:

- `ORBIT_HISTORY_RETAIN_DAYS`
- `ORBIT_TRANSCRIPT_RETAIN_DAYS`
- `ORBIT_TRANSCRIPT_MAX_BYTES`
- `ORBIT_TRANSCRIPT_TAIL_BYTES`
- `ORBIT_MESSAGE_RECENT_SHARDS`

## Collaboration Insights

`GET /api/work-analysis` builds workspace-scoped task metrics from persisted message trees without loading every historical shard. A task is anchored to its originating user message (or the highest in-window ancestor for long-running work) and includes:

- completed, running, failed, and cancelled outcomes
- unique participating digital employees and multi-employee collaboration rate
- end-to-end duration from task creation to the final outcome
- per-run offsets and durations for sequential/parallel timeline rendering

Completed-task median duration excludes running, failed, and cancelled tasks. Cancelling an intermediate queued branch does not override a later successful outcome.

## Future Extension Points

- Add persistent SQLite storage behind `MessageStore` and transcript storage if shard files stop scaling.
- Add runtime adapters for other agent backends.
- Add richer queue controls: retry, pause, and priority.
- Add branch/PR workflow integration as a separate layer, not inside the runtime adapter.
