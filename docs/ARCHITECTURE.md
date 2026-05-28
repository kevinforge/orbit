# Orbit Architecture

Orbit is a local-first agent collaboration app. The current implementation runs one local HTTP server, one React UI, and multiple CLI-backed agent runs on the user's machine.

## Runtime Flow

```text
React UI
  -> POST /api/messages
  -> MessageStore
  -> ChannelRouter
  -> RunManager
  -> AgentRegistry / AgentSession
  -> Runtime adapter
  -> Codex, Claude Code, or CodeBuddy CLI
  -> CLI stream events
  -> MessageStore + TerminalTranscriptStore
  -> SSE
  -> React UI
```

The runtime no longer uses PTY sessions or CLI hooks. A run is considered complete when the selected CLI child process exits and returns a clean final answer.

## Core Modules

| Path | Responsibility |
| --- | --- |
| `src/server/index.ts` | Local HTTP routes, SSE wiring, message intake |
| `src/server/sse-hub.ts` | Server-Sent Events client management |
| `src/server/static-server.ts` | Static UI serving |
| `src/core/agent-profiles.ts` | Built-in role definitions and permission profiles |
| `src/core/agent-registry.ts` | Owns agent sessions and exposes agent state |
| `src/core/agent-session.ts` | Starts one runtime adapter run and tracks status |
| `src/core/agent-runtime.ts` | Shared runtime adapter contract |
| `src/core/claude-cli-runtime.ts` | Spawns Claude Code CLI and parses stream JSON output |
| `src/core/codex-cli-runtime.ts` | Spawns Codex CLI and parses JSONL output |
| `src/core/codebuddy-cli-runtime.ts` | Spawns CodeBuddy CLI and parses stream JSON output |
| `src/core/run-manager.ts` | Per-agent run queue and lifecycle events |
| `src/core/channel-router.ts` | Routes user and agent messages containing explicit assignments |
| `src/core/mention-router.ts` | Parses `@agent:` assignment markers |
| `src/core/channel-context-builder.ts` | Builds private context passed into each agent run |
| `src/core/channel-history.ts` | Builds scoped channel history for each agent run |
| `src/core/message-store.ts` | Workspace-persisted channel messages |
| `src/core/session-store.ts` | Per-agent session persistence for `--resume` |
| `src/core/workspace-store.ts` | Workspace isolation and user directory persistence |
| `src/core/terminal-transcript-store.ts` | Workspace-persisted runtime activity transcripts |
| `src/core/claude-output-detector.ts` | Clean final answer validation and stream event mapping |
| `src/ui/App.tsx` | Chat UI, agent buttons, composer, markdown, activity panel |

## Agents

The current build has four fixed agents:

| Agent | Role |
| --- | --- |
| `@pm:` | Product manager |
| `@architect:` | Architect |
| `@developer:` | Developer |
| `@tester:` | Tester |

Agent profiles are defined in `src/core/agent-profiles.ts`. They are intentionally hardcoded for now to keep the first local product loop simple. Each profile has a `runtime` value. Defaults are:

| Agent | Default runtime |
| --- | --- |
| `@pm:` | `codex` |
| `@architect:` | `codex` |
| `@developer:` | `claude-code` |
| `@tester:` | `codebuddy` |

`ORBIT_AGENT_RUNTIMES` can override selected agents at startup:

```text
ORBIT_AGENT_RUNTIMES=developer=codex,tester=claude-code
```

## Routing Rules

- Only `@agent:` with a colon assigns work.
- Plain `@agent` mentions are references and do not trigger routing.
- Unknown placeholders such as `@agent:` are treated as normal text.
- A message can assign work to multiple agents.
- Each assigned agent receives the full channel message as context.
- Agent replies can also contain assignments, but self-assignments are ignored.
- Existing assignments in the same channel message are treated as already scheduled.

This is not a general workflow engine. It is a lightweight team-channel routing model.

## Channel History

Each agent run receives a scoped history of channel messages since that agent's last completed run. This lets agents see what other agents (and the user) said while they were idle, complementing the `--resume` flag which preserves each agent's own CLI session.

`buildHistoryForAgent` in `src/core/channel-history.ts` builds the history:

- Scans messages from newest to oldest, starting after the agent's last `status: "done"` message
- Skips system messages, messages still running, and routed source messages
- Caps total history at 2000 characters, individual entries at 500 characters
- Returns entries in chronological order

The history is injected between `[Orbit Context]` and `[Full channel message]` in the prompt built by `channel-context-builder.ts`.

## Session Persistence

Each agent's CLI session ID is persisted via `src/core/session-store.ts`. Session records are namespaced by runtime, channel, conversation, and agent so switching an agent between Codex, Claude Code, and CodeBuddy does not reuse an incompatible session ID. On subsequent runs, the runtime adapter passes the corresponding resume option so the agent retains its own prior conversation context. If resumption fails (e.g. session expired), the store is cleared and the run retries without resuming.

Session files are stored under `~/.orbit/sessions/<workspaceId>/<runtime>/<channelId>/<conversationId>/<agentId>.json`, namespaced by runtime, channel, conversation, and agent.

## Workspace Isolation

Each project directory gets its own isolated workspace via `src/core/workspace-store.ts`:

- **Workspace ID**: deterministic 12-char hex derived from the project's absolute cwd using SHA-256. On Windows the path is lowercased before hashing to handle case-insensitive filesystems; on Linux/macOS the original case is preserved.
- **Data directory**: `~/.orbit/` organized by data type, with workspace as an isolation dimension:
  - `workspaces/<workspace-id>/workspace.json` — metadata (id, name, path, createdAt, lastOpenedAt)
  - `sessions/<workspace-id>/<runtime>/<channelId>/<conversationId>/<agentId>.json` — per-agent session records (`SessionStore`)
  - `channels/<workspace-id>/<channelId>/<conversationId>/messages.json` — persisted channel messages (`MessageStore`)
  - `transcripts/<workspace-id>/<channelId>/<conversationId>/<agentId>.log` — per-agent terminal transcripts (`TerminalTranscriptStore`)
- **Lifecycle**: on startup, the server calls `WorkspaceStore.resolve(cwd)` which creates the workspace directory and metadata on first run, or updates `lastOpenedAt` on subsequent runs.

The current implementation does not migrate data from the legacy `.orbit/` directory inside the project. Old session data there is ignored once this version is active.

Codex uses the user's normal Codex CLI home. Orbit does not create per-agent `CODEX_HOME` directories; agent-level continuity is handled by the session store above, which passes each agent's own saved session ID back to the runtime on the next run.

## CLI Runtimes

Orbit runs each backend through a runtime adapter. Codex uses:

```text
codex exec --json --cd <cwd> --sandbox danger-full-access --dangerously-bypass-approvals-and-sandbox -
```

Claude Code uses:

```text
claude --print --verbose --output-format stream-json --include-partial-messages --permission-mode bypassPermissions
```

CodeBuddy uses:

```text
codebuddy --print --output-format stream-json --include-partial-messages --permission-mode bypassPermissions
```

The user prompt is written to stdin. Stream JSON events are converted into:

- final assistant text
- tool/activity events
- runtime output for diagnostics

Because this mode exits after each run, Orbit does not need a Stop hook or a terminal input endpoint.

## Activity Stream

Activity events are derived from Claude stream JSON output and shown in the chat card:

- run accepted / started / completed / failed
- tool started / completed / failed
- runtime produced output

The UI keeps running activities expanded and scrolls to the latest event. Completed cards are collapsed by default and can be expanded manually.

## State

Agent statuses and run queues are in memory. Messages and terminal transcripts are persisted to the workspace data directory and survive server restarts.

This keeps P0 simple. Persistent storage should be added behind existing stores rather than mixed into UI or runtime code.

## Future Extension Points

- Replace hardcoded profiles with user-defined agents.
- Add persistent SQLite storage behind `MessageStore` and transcript storage (currently JSON/log files).
- Add runtime adapters for other agent backends.
- Add richer queue controls: cancel, retry, pause, and priority.
- Add branch/PR workflow integration as a separate layer, not inside the runtime adapter.
