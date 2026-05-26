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
  -> Claude Code or CodeBuddy CLI --print --output-format stream-json
  -> CLI stream events
  -> MessageStore + TerminalTranscriptStore
  -> SSE
  -> React UI
```

The runtime no longer uses PTY sessions or Claude Code hooks. A run is considered complete when the Claude CLI child process exits and returns a clean final answer.

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
| `src/core/codebuddy-cli-runtime.ts` | Spawns CodeBuddy CLI and parses stream JSON output |
| `src/core/run-manager.ts` | Per-agent run queue and lifecycle events |
| `src/core/channel-router.ts` | Routes user and agent messages containing explicit assignments |
| `src/core/mention-router.ts` | Parses `@agent:` assignment markers |
| `src/core/channel-context-builder.ts` | Builds private context passed into each agent run |
| `src/core/channel-history.ts` | Builds scoped channel history for each agent run |
| `src/core/message-store.ts` | In-memory channel messages |
| `src/core/session-store.ts` | Per-agent session persistence for `--resume` |
| `src/core/terminal-transcript-store.ts` | Runtime activity transcript storage |
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

Agent profiles are defined in `src/core/agent-profiles.ts`. They are intentionally hardcoded for now to keep the first local product loop simple. Each profile has a `runtime` value. Defaults use `claude-code`, and `ORBIT_AGENT_RUNTIMES` can override selected agents at startup:

```text
ORBIT_AGENT_RUNTIMES=developer=codebuddy,tester=codebuddy
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

Each agent's Claude CLI session ID is persisted via `src/core/session-store.ts`. On subsequent runs, the `--resume` flag is passed so the agent retains its own prior conversation context. If resumption fails (e.g. session expired), the store is cleared and the run retries without `--resume`.

## CLI Runtimes

Orbit runs Claude Code and CodeBuddy through non-interactive CLI mode via runtime adapters. Claude Code uses:

Orbit runs Claude Code through non-interactive CLI mode:

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

Current state is in memory:

- messages
- agent statuses
- queued runs
- activity transcripts

This keeps P0 simple. Persistent storage should be added behind existing stores rather than mixed into UI or runtime code.

## Future Extension Points

- Replace hardcoded profiles with user-defined agents.
- Add persistent SQLite storage behind `MessageStore` and transcript storage.
- Add runtime adapters for Codex CLI, CodeBuddy CLI, or other agent backends.
- Add richer queue controls: cancel, retry, pause, and priority.
- Add branch/PR workflow integration as a separate layer, not inside the runtime adapter.
