# Orbit Architecture

Orbit is a local-first agent collaboration app. The current implementation runs one local HTTP server, one React UI, and multiple ACP-backed agent runs on the user's machine.

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
| `src/ui/App.tsx` | Chat UI, agent buttons, composer, workspace/conversation selectors, and the reply-card process region (live plan board and ordered text/tool timeline; settled collapsed 执行过程) |

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

### Model Selection

Each digital employee can pin a preferred model when its runtime advertises
model selection through ACP session config options. The flow is:

- When the digital employee settings panel opens, or when the user manually
   refreshes the list, Orbit creates a temporary ACP connection for each
   distinct runtime and reads `session/new` config options without sending a
   prompt. The temporary connection is destroyed after discovery and does not
   create an Orbit employee session or conversation record.
- A manual refresh is scoped to the employee id and runtime currently selected
   in the settings form, so it also works before a runtime change or a newly
   added employee has been saved. The response carries this target snapshot
   separately from the persisted agent configs; the UI merges only model state
   and keeps all unsaved form edits.

1. On connection initialization Orbit declares the `session.configOptions`
   client capability. New, resumed, and restored sessions return the runtime's
   `configOptions`, from which Orbit extracts the `category: "model"` select
   option into an `AgentModelStateSnapshot`. Probe snapshots contain the
   available choices only; the current value is reported only by a real
   employee session and is never copied from a probe session to other
   employees using the same runtime.
2. Snapshots are persisted per workspace in
   `~/.orbit/workspaces/<workspace-id>/agent-model-state.json` — deliberately
   outside `agents.json`, so saving team configs never overwrites them — and
   published on the SSE stream as `agent.model_state` events for the settings
   UI.
3. User preferences live in `agents.json` under `model.preferredModelId` and
   are gated by `runtimeKind`: switching an employee's runtime never applies a
   preference recorded for a different runtime.
4. `runAcp()` applies the preference after the session is established and
   before the prompt is sent. If the preferred model is missing from the
   runtime's list, or the `session/set_config_option` call fails, Orbit posts
   a notice in the conversation and keeps running with the current model; the
   session is never discarded and the run never fails because of it. Pooled
   connections that are reused without an RPC response fall back to the last
   known snapshot for the same decision.

All three runtimes (claude-code, codex, codebuddy) expose a `model` select
option today. The settings UI keeps a runtime-level refresh action visible
even before the first successful probe, and distinguishes loading, unsupported,
and failed discovery states so a failed probe can be retried.

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
8. **Current attachments** (typed list of the source message's image/file attachments, if any)

Workspace prompts inject optional shared user context across all employees, while each employee retains its own task-specific instruction. They do not define or replace Orbit's three interaction modes. Complex collaboration uses a separate internal supervisor profile, and its persisted runtime session is retained when the conversation switches to another mode.

### Supervisor Configuration

The built-in supervisor used by 复杂协作 is configurable per conversation through
`ConversationInfo.supervisorConfig`:

```ts
type SupervisorConfig = {
  runtime: AgentRuntimeKind;
  model?: AgentModelPreference;
};
```

- **Runtime** — which of Claude Code, Codex, or CodeBuddy runs the supervisor.
  Changing it cancels the supervisor's queued or running checks and rebuilds its
  session. Other employees and message history are unaffected.
- **Model** — a preference recorded with the runtime it was chosen under, so a
  preference is ignored once the runtime changes (model value ids are not
  portable across runtimes). Changing only the model does **not** cancel work or
  rebuild the session; the new preference is applied lazily when the supervisor's
  next run starts, matching how regular employee preferences behave.

The supervisor keeps its internal id across all conversations, so its model
snapshot is stored per conversation (`supervisor:<conversation-id>` in
`agent-model-state.json`) and `agent.model_state` events for it carry a
`conversationId` so page-scoped SSE delivery filters them correctly.

Configuration is reachable from the collaboration mode menu before or after
enabling 复杂协作, and is saved through
`PUT /api/conversations/:id/supervisor-config?workspaceId=...&conversationId=...`.
Conversations recorded before this field existed keep only `supervisionRuntime`;
`ConversationStore` maps it to `{ runtime: supervisionRuntime }` on read and new
writes use `supervisorConfig` only.

`WorkspaceConfigStore` (`src/core/workspace-config-store.ts`) manages load/save with atomic writes and graceful fallback to defaults when the file is missing or corrupted.

## Channel History

Each agent run receives a scoped history of channel messages since that agent's last completed run. This lets agents see what other agents (and the user) said while they were idle, complementing ACP session restore, which preserves each agent's own backend session across runs.

`buildHistoryForAgent` in `src/core/agent-history-builder.ts` builds the history:

- Scans messages from newest to oldest, starting after the agent's last `status: "done"` message
- Skips system messages, messages still running, and routed source messages
- Splits eligible messages into two groups: "older" and "recent" (last 6)
- Recent entries are kept in full (no per-entry truncation)
- Older entries are truncated to 500 characters with a `[truncated: original message was N chars]` marker
- Caps total history at 12000 characters (`MAX_HISTORY_CHARS`)
- Returns entries in chronological order

The history is injected between `[Orbit Context]` and `[Full channel message]` in the prompt built by `agent-context-builder.ts`.

## Attachments

Messages can carry attachments (images plus PDF/text/code files) managed by
`src/core/attachment-store.ts` under `~/.orbit`. Uploads are validated against
the shared extension registry (`src/shared/attachment-registry.ts`): images
are verified by magic numbers, PDF must start with `%PDF-`, and text/code
types rely on the extension whitelist plus size limits. Composer uploads are
drafts under `tmp/attachments`; sending a message commits drafts into
`conversations/<ws>/<conv>/attachments`, re-validating the stored bytes and
failing the whole message (with drafts preserved and partial copies rolled
back) when one is missing or a copy fails. A single message is capped at five
attachments of 5 MB each and 20 MB in total; the combined cap is checked
against the bytes read back from disk before anything is copied, so a rejected
message stays retryable. The two caps cannot both be reached at once — five
full-size files would be 25 MB — so a message is either five smaller
attachments or a few large ones. The combined cap exists because images are
inlined into the ACP prompt as base64; it applies to every kind today, so
five 5 MB text files are rejected even though only their URI reaches the
runtime. Draft creation counts and writes inside one
per-conversation critical section, so concurrent uploads cannot each read a
stale count and slip past the 20-draft cap.

Composing an attachment-only first message is possible on a workspace without
any conversation yet: the composer creates the conversation through
`POST /api/conversations` before uploading, because drafts are stored per
conversation and the upload target must already exist. History retention
(`src/core/history-retention.ts`) reclaims permanent attachments once the only
message shard referencing them is removed, and prunes the display-name index
with them. The reconciliation only runs for a conversation that actually lost a
shard in that pass — deliberately, so startup does not read every shard — so
attachments orphaned before this existed are reclaimed the next time that
conversation loses a shard rather than by a one-off sweep.

Serving an attachment back to the UI resolves the user's original filename from
`attachments/index.json` (`src/core/attachment-filename-index.ts`) instead of
scanning every message shard; entries missing from the index — attachments
committed before it existed — are read from history once and then backfilled.

Delivery to runtimes keeps the full server-validated attachment metadata
intact along `run-manager.ts` → `agent-session.ts` → `AgentRuntimeRunOptions.attachments`.
The shared ACP runtime (`src/core/acp-runtime.ts`) maps it to content blocks:
images become native `image` blocks when the runtime advertises
`promptCapabilities.image`; everything else — including images on runtimes
without that capability, plus PDF/text/code files — travels as `resource_link`
blocks (an ACP v1 baseline content type, no capability negotiation needed)
whose URI, name, MIME type, and size come from the committed
`MessageAttachment` metadata, never from client-supplied values. URIs are
generated with Node's `pathToFileURL()` so spaces and non-ASCII path segments
survive on every platform. The `<current-attachments>` section of the agent
prompt lists attachments with kind, name, and size only — marked as untrusted
user data that must not be executed — while structured content blocks are the
primary transport. A message may contain attachments without any text; when a
selected employee marker is the only visible text, the attachment remains the
task input. The HTTP layer serves images inline and every other kind as a
generic `application/octet-stream` download with `nosniff` (see
`src/server/attachment-response.ts`).

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

The server retains multiple live conversation contexts through `src/server/conversation-context.ts`. Each browser page owns its workspace and conversation through URL query parameters; the server's active pointer is retained only as a compatibility fallback for older clients and restart recovery:

- **ConversationContext**: bundles per-conversation runtime state (MessageStore, TerminalTranscriptStore, AgentRegistry, RunManager, MessageRouter).
- **Context map**: contexts are keyed by workspace and conversation, created lazily, and retained while pages switch elsewhere so work can continue in the background. Core runtime events carry both identifiers, and SSE subscriptions filter by the page scope.
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
- process text (`process.text` activity events)
- tool/activity events
- runtime output for diagnostics

ACP message chunks are grouped into model responses. Claude Code and Codex group by assistant message ID (Codex marks `final_answer` phases explicitly and treats `commentary` as process narration); CodeBuddy reuses one top-level message ID per turn, so its adapter watches the `phase` field in `session_info_update._meta["codebuddy.ai/agentPhase"]` and increments a response index on each `model_requesting`/`model_streaming` boundary, falling back to a single group when phases are absent. Orbit ignores hidden thought chunks, and the final answer is the explicit final phase or the last main assistant message group; earlier groups become process text. Each newline-delimited JSON frame is bounded independently, so long tasks remain supported while a malformed or unbounded frame only fails its own run. Stderr is retained in a bounded diagnostic tail.

The ACP runner registry is the single source for built-in runtime definitions, instances, and availability probes. A successfully completed turn releases its adapter process into an idle pool for a 30-minute TTL. Reuse is restricted to the same conversation, employee, workspace, command, and approval mode, and the proxy environment (`HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY`, including lowercase variants) participates in the reuse key, so toggling the system proxy always starts a fresh connection instead of reusing one bound to the old route. Sessions remain independent, and a failed, cancelled, interrupted, or unhealthy process is destroyed instead of returned to the pool; destruction unbinds the session first, terminates the process tree, and rejects every pending ACP request so a destroyed lease never lingers. A connection whose stdout transport ends — whether the process exited or the runtime dropped the transport while still running — is treated as dead: pending ACP requests are rejected with diagnostics that carry the runtime display name, pid, and exit code or a transport-closed note instead of hanging on the JSON-RPC race, and the connection is never reused. Shutdown drains the pool explicitly.

Backend sessions are restored through ACP when they are not already loaded in a reused process. A resume failure is classified before it surfaces: transport drops, timeouts, and process exits are recoverable, so the connection is destroyed and replaced once and the same session id is retried on the fresh connection; thread-store conflicts, active writers, and corrupt or unknown sessions are unrecoverable, so the run degrades to a new runtime session — the replacement session id is settled and persisted while the Orbit conversation, message history, employee configuration, and collaboration context stay untouched, and a process note explains that the original runtime session could not be recovered. Unclassified errors fail the run unchanged rather than guessing. Cancellation first sends `session/cancel` and waits a 10-second grace period; a runtime that ignores the request (or whose `prompt` promise never settles) is then force-collected: the connection is destroyed, the process tree is terminated, every pending ACP request is rejected, the session id is settled, late session updates are dropped, and the run still ends as a typed cancellation so the employee returns to idle and the next queued task starts instead of the run staying in "cancelling" forever. A failed `session/cancel` request skips the grace period and force-collects immediately. ACP permission requests are controlled by the message's approval mode; no bypass-permissions CLI flag is used. Codex starts in `agent` mode for "ask" and `agent-full-access` for "full access". Orbit advertises ACP plan updates and elicitation support for form and URL modes. Native plan snapshots are carried on the run and displayed on the reply card's plan board. CodeBuddy has no native plan updates; its `TaskCreate`/`TaskUpdate` tool completions carry the full post-operation task snapshot in `_meta["codebuddy.ai/rawResponse"].todos`, which the adapter projects into the same `plan.updated` items snapshot (`plan.id = "codebuddy-tasks"`) right after the shared `tool.completed` event — `pending`/`in_progress`/`completed` map through unchanged, `deleted` entries disappear, `in_progress` prefers `activeForm`, and priority defaults to `medium`. A malformed snapshot keeps the existing plan instead of clearing it. CodeBuddy 2.132.0 provides no reliable final-answer signal (`model_done` may still be followed by tool calls and Stop-Hook continuations), so its reply body settles only when the ACP prompt response arrives; the adapter never derives `isFinal` from `model_done`, `idle`, or text heuristics.

The composer stores an `ApprovalMode` on each user message, and `RunManager` copies it to result messages so downstream handoffs preserve the same choice. In `ask` mode, `AgentSession` publishes a `permission.requested` event and keeps the ACP request pending until the local HTTP approval endpoint resolves it. In `full-access` mode, ACP requests are approved automatically for that task. Both modes select ACP one-time decisions only. Interrupting or stopping a run rejects and clears any pending request. Permission and elicitation requests also expire after 30 minutes so abandoned agent turns cannot wait forever. Elicitation uses separate `elicitation.requested` and `elicitation.resolved` events and `/api/elicitations/resolve`, so user input is not treated as a security approval.

## Activity Stream

Activity events are derived from runtime stream output or ACP session updates and shown inside the reply card:

- run accepted / started / completed / failed
- tool started / completed / failed
- native ACP plan updated / removed
- runtime produced output
- `process.text` — runtime-explicit process narration with two semantics: incremental `text` deltas for streaming, and `snapshot: true` for a settlement snapshot. Live deltas carry their progress/answer stream and ACP answer-group identity. Settlement snapshots are consumed inside `RunManager`: they only record which answer group becomes the final reply and are never forwarded to the UI as `run.activity` events, so removing the final answer never becomes a separate client-visible event.

Plan updates keep only the latest snapshot on the run. Process text and tool lifecycle events share one ordered, in-memory timeline. Adjacent tools form a compact execution group whose summary follows the newest tool, remains on the final tool after completion, and expands to show every invocation. While a run is live, the reply card shows the plan followed by this low-emphasis timeline on the same background as the reply body. The reply body shows a placeholder (`正在处理`, `等待处理`, or `正在取消`) until a runtime explicitly marks a final-answer phase; from that point, the latest final-answer group is shown in the body and the process region becomes collapsed while continuing to receive that group. All streaming text — including answer deltas that will become the final reply — remains in the ordered process timeline (`text → tools → text`) until the terminal message update settles the run. After the run settles (completed, failed, cancelled, interrupted, or permission rejected), the timeline remains in the collapsed `执行过程` section and the settled reply body carries the final reply.

Raw tool activity and tool results are live-only: they flow through the in-memory run state and the `run.activity` SSE event to the currently open page and are never persisted. At settlement, Orbit writes a compact ordered `processTimeline` — derived from a copy of the live activity with the settled answer group removed — containing process-text segments and count/failure summaries for adjacent tool groups, plus the final Plan snapshot. This preserves the text/tool interleaving and aggregate counts across a refresh without storing tool names, inputs, or results. Settlement messages use explicit `null` values when either `processTimeline` or `plan` is absent, while `undefined` still means an intermediate update did not address the field. Their terminal `message.updated` event sets `settleTransientActivity` and carries the settlement snapshot's `excludedAnswerGroup` (an explicit ACP answer-group id, where the empty string is a valid group for unscoped answers): clients settle in that single update — the reply body receives the final answer, the status switches to the terminal state, and exactly that group is removed from the live activity while the current page's process text and full tool details are retained. The body swap and the process cleanup therefore never appear as two separate renders. When no settlement snapshot arrived — failure, interruption, or cancellation — the field is omitted so partial answer text is never discarded; after a refresh, the absent live activity falls back to the durable summary. Terminal runs are removed from the in-memory run index after their message and lifecycle events are published; a bounded five-minute run-id index preserves the API's `409 not_cancellable` response for immediate retries without retaining the run payload. While a run is active, `/api/state` overlays its in-memory ordered activity and Plan onto the stored message projection — the in-memory activity keeps the final-answer deltas until the terminal event, so the projection never shows a settlement gap — letting users switch away and back to restore the full live timeline without writing raw tool activity to disk.

## Message Rendering

Agent replies are rendered as markdown in the UI (`src/ui/markdown-renderer.ts`). Link hrefs are sanitized to a small protocol allowlist; rejected hrefs fall back to plain text instead of dead empty anchors, and CJK characters that GFM autolink swallows into a trailing URL are stripped back into the body text. Local paths — drive-letter paths, `~/`, absolute POSIX paths, and `file:///` hrefs, as explicit links or bare path tokens — render as clickable entries carrying a `data-path` attribute instead of a navigable URL; bare POSIX paths require at least two segments so ordinary slash-separated words are left alone.

Clicking an entry calls `POST /api/local-path/reveal`. The endpoint (`src/server/local-path-reveal.ts`) expands `~`, strips `:line`/`:line:col` suffixes, resolves the path with `fs.realpath`, and only reveals paths inside a configured workspace; files are selected in the system file manager (`explorer /select,`, `open -R`, or the parent directory via `xdg-open`) while directories are opened directly. Out-of-workspace paths are refused with 403, and the UI falls back to a toast with the path copied to the clipboard.

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
