# Design: Agent Session Persistence via Claude CLI `--resume`

**Issue**: #2
**Status**: Draft
**Author**: @architect

---

## 1. Problem Statement

Each Orbit agent run is one-shot. `claude --print --output-format stream-json` is invoked with no prior conversation context. Follow-up assignments to the same agent lose all previous decisions, tool usage, and reasoning. Server restarts also erase any transient state.

Goal: Each built-in agent persists its Claude CLI `session_id` to disk and passes `--resume` on the next run, giving continuity within the same channel across runs and restarts.

## 2. Current State

### Data Flow (Before)

```
AgentSession.send(runId, prompt)
  → runClaudeCli({ agentId, cwd, prompt, onOutput })
    → claude --print --output-format stream-json --permission-mode bypassPermissions
    → one-shot, no prior context
```

### Key Files

| File | Current Responsibility |
|---|---|
| `claude-cli-runtime.ts` | Spawns CLI, parses stdout for final answer. No session awareness. |
| `agent-session.ts` | Manages one agent lifecycle. Calls `runClaudeCli` directly. No persistent state. |
| `agent-registry.ts` | Creates `AgentSession` instances. No session store. |
| `server/index.ts` | Composition root. Wires everything together. |
| `types.ts` | No `session_id` or `SessionRecord` types. |

### Claude CLI Flags (Relevant)

```
-r, --resume <session-id>    Resume a conversation by session ID
--session-id <uuid>          Use a specific session ID (not needed here)
--no-session-persistence     Disable session persistence (we want the default: on)
```

## 3. Proposed Design

### 3.1 New Module: `src/core/session-store.ts`

A file-backed store mapping `(channelId, agentId)` → session record.

```ts
export type SessionRecord = {
  agentId: string;
  channelId: string;
  sessionId: string;
  lastRunAt: string;   // ISO 8601
  runCount: number;
};
```

**API surface:**

```ts
export class SessionStore {
  constructor(baseDir?: string);
  // baseDir defaults to `.orbit/sessions` relative to cwd

  load(channelId: string, agentId: string): SessionRecord | null;
  save(channelId: string, agentId: string, record: SessionRecord): void;
  clear(channelId: string, agentId: string): void;
}
```

**Storage layout:**

```
.orbit/
  sessions/
    default/
      pm.json
      architect.json
      developer.json
      tester.json
```

Each file is written atomically (write to temp, rename) to avoid corruption on crash. Files are created lazily on first `save()`, not eagerly.

**Design decisions:**
- `load` returns `null` (not throws) for missing files — first run has no prior session.
- `save` creates parent directories if they don't exist.
- `clear` deletes the file — used when resume fails.
- No caching — disk reads on every `load` are fine for the volume (4 agents, <1 run/sec). A future optimization can add in-memory cache if needed.
- `baseDir` is injectable for testing (use `os.tmpdir()` in tests).

### 3.2 Modify: `src/core/claude-cli-runtime.ts`

#### 3.2.1 Add `sessionId` to `ClaudeCliRunOptions`

```ts
export type ClaudeCliRunOptions = {
  agentId: AgentId;
  cwd: string;
  prompt: string;
  resumeSessionId?: string;   // NEW: if set, pass --resume to CLI
  env?: NodeJS.ProcessEnv;
  onOutput?: (text: string) => void;
};
```

#### 3.2.2 Modify `buildClaudeCliArgs` to accept optional resume

```ts
export function buildClaudeCliArgs(options?: { resumeSessionId?: string }): string[] {
  const args = [
    "--print",
    "--verbose",
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--permission-mode", "bypassPermissions",
  ];
  if (options?.resumeSessionId) {
    args.push("--resume", options.resumeSessionId);
  }
  return args;
}
```

This is a **breaking signature change** for existing tests. Tests that assert on `buildClaudeCliArgs()` with no args must still pass (the parameter is optional).

#### 3.2.3 Capture `session_id` from stream-json output

Add a `sessionId` field to `ClaudeCliRunHandle`:

```ts
export type ClaudeCliRunHandle = {
  process: ChildProcessWithoutNullStreams;
  result: Promise<string>;
  sessionId: Promise<string | null>;  // NEW: resolved from stream
};
```

During stdout streaming, detect events containing `session_id`:

```ts
let capturedSessionId: string | null = null;
let sessionIdResolve: (value: string | null) => void;
const sessionIdPromise = new Promise<string | null>((resolve) => {
  sessionIdResolve = resolve;
});

child.stdout.on("data", (chunk: string) => {
  stdout += chunk;
  // ... existing readable text extraction ...

  // Try to extract session_id from JSON lines
  if (!capturedSessionId) {
    for (const line of chunk.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed);
        if (event.session_id && typeof event.session_id === "string") {
          capturedSessionId = event.session_id;
          sessionIdResolve(capturedSessionId);
        }
      } catch { /* not JSON, ignore */ }
    }
  }
});

// On close, resolve with null if no session_id was found
child.on("close", () => {
  if (!capturedSessionId) sessionIdResolve(null);
});
```

**Why resolve on close:** The `session_id` may appear in any event type. Rather than guessing which event, we scan all lines. If none is found by the time the process closes, we resolve `null` so the promise never hangs.

**Performance note:** JSON parsing of every stdout line adds negligible overhead — we already parse them in `extractClaudeCliFinalAnswer`. The early-return on `capturedSessionId` prevents redundant parsing after the first capture.

#### 3.2.4 Thread `resumeSessionId` through to CLI

In `runClaudeCli`, use `buildClaudeCliArgs({ resumeSessionId: options.resumeSessionId })` instead of `buildClaudeCliArgs()`.

### 3.3 Add: Session ID Extraction Helper

```ts
// In claude-cli-runtime.ts

export function extractSessionId(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed);
      if (typeof event.session_id === "string") {
        return event.session_id;
      }
    } catch { /* not JSON */ }
  }
  return null;
}
```

Exported for direct testing. Also used internally by the streaming capture (though the streaming path uses a different code path for early capture).

### 3.4 Modify: `src/core/agent-session.ts`

#### 3.4.1 Accept `SessionStore` + `channelId`

```ts
export type AgentSessionOptions = {
  id: AgentId;
  label: string;
  cwd: string;
  eventBus: EventBus;
  quietWindowMs?: number;
  sessionStore: SessionStore;   // NEW
  channelId: string;            // NEW: fixed "default" for now
};
```

#### 3.4.2 Session lifecycle in `send()`

```ts
async send(runId: string, prompt: string): Promise<string> {
  if (this.activeRun) {
    return Promise.reject(new Error(`${this.id} is already running`));
  }

  this.setStatus("running");

  const existingSession = this.options.sessionStore.load(
    this.options.channelId, this.id
  );

  const handle = runClaudeCli({
    agentId: this.id,
    cwd: this.options.cwd,
    prompt,
    resumeSessionId: existingSession?.sessionId ?? undefined,
    onOutput: (text) => {
      this.options.eventBus.publish({
        type: "terminal.chunk", agentId: this.id, runId, text
      });
    },
  });

  this.activeRun = { runId, child: handle.process };

  try {
    const result = await handle.result;
    const sessionId = await handle.sessionId;

    if (sessionId) {
      this.persistSession(sessionId);
    }

    this.activeRun = null;
    this.setStatus("idle");

    const cleaned = sanitizeAgentVisibleReply(result.trim());
    if (!isCleanFinalAnswer(cleaned)) {
      throw new Error("Agent did not return a clean final answer.");
    }
    return cleaned;
  } catch (error) {
    this.activeRun = null;
    this.setStatus("error");

    if (this.isResumeFailure(error, existingSession)) {
      this.options.sessionStore.clear(this.options.channelId, this.id);
      return this.retryWithoutResume(runId, prompt);
    }

    throw error;
  }
}
```

#### 3.4.3 Resume failure detection

```ts
private isResumeFailure(
  error: unknown,
  session: SessionRecord | null
): session is SessionRecord {
  if (!session) return false;

  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  // Conservative: only match clear session-not-found / expired markers
  return (
    lower.includes("session not found") ||
    lower.includes("session expired") ||
    lower.includes("could not resume") ||
    lower.includes("invalid session")
  );
}
```

**Design note:** The detector starts conservative. It only matches explicit resume-related error messages. Generic failures (network errors, API limits) are not retried.

#### 3.4.4 Retry without resume

```ts
private async retryWithoutResume(runId: string, prompt: string): Promise<string> {
  const handle = runClaudeCli({
    agentId: this.id,
    cwd: this.options.cwd,
    prompt,
    // No resumeSessionId — fresh session
    onOutput: (text) => {
      this.options.eventBus.publish({
        type: "terminal.chunk", agentId: this.id, runId, text
      });
    },
  });

  this.activeRun = { runId, child: handle.process };

  try {
    const result = await handle.result;
    const sessionId = await handle.sessionId;

    if (sessionId) {
      this.persistSession(sessionId);
    }

    this.activeRun = null;
    this.setStatus("idle");

    const cleaned = sanitizeAgentVisibleReply(result.trim());
    if (!isCleanFinalAnswer(cleaned)) {
      throw new Error("Agent did not return a clean final answer.");
    }
    return cleaned;
  } catch (retryError) {
    this.activeRun = null;
    this.setStatus("error");
    throw retryError;
  }
}
```

#### 3.4.5 Persist session helper

```ts
private persistSession(sessionId: string): void {
  const prev = this.options.sessionStore.load(
    this.options.channelId, this.id
  );
  this.options.sessionStore.save(this.options.channelId, this.id, {
    agentId: this.id,
    channelId: this.options.channelId,
    sessionId,
    lastRunAt: new Date().toISOString(),
    runCount: (prev?.runCount ?? 0) + 1,
  });
}
```

### 3.5 Modify: `src/core/agent-registry.ts`

Pass `SessionStore` and fixed `channelId` to each `AgentSession`:

```ts
export type AgentRegistryOptions = {
  profiles: AgentProfile[];
  eventBus: EventBus;
  sessionStore: SessionStore;   // NEW
};

export class AgentRegistry {
  constructor(private readonly options: AgentRegistryOptions) {
    // Create each AgentSession with sessionStore + channelId
  }
}
```

Or, alternatively, keep the existing constructor signature and add `sessionStore` + `channelId` as parameters. The simpler approach: add them to the constructor.

### 3.6 Modify: `src/server/index.ts`

Wire up `SessionStore`:

```ts
import { SessionStore } from "../core/session-store.ts";

const CHANNEL_ID = "default";  // fixed for now
const sessionStore = new SessionStore();  // uses .orbit/sessions/

const agents = new AgentRegistry(profiles, eventBus, sessionStore, CHANNEL_ID);
```

### 3.7 Modify: `.gitignore`

Add `.orbit/` to gitignore.

### 3.8 Types: `src/shared/types.ts`

No changes needed. `SessionRecord` is defined locally in `session-store.ts` since it's an implementation detail of the persistence layer. If other modules need it, we can move it to `types.ts`, but currently only `session-store.ts` and `agent-session.ts` reference it, and `agent-session.ts` imports from `session-store.ts`.

## 4. Test Plan

### 4.1 New test file: `tests/session-store.test.ts`

| Test | Description |
|---|---|
| `load returns null for missing file` | No prior session → null |
| `save then load round-trips` | Write a record, read it back, fields match |
| `save creates directories` | `.orbit/sessions/default/` created on first save |
| `clear removes the file` | After clear, load returns null |
| `save overwrites previous` | Two saves, second one wins |
| `custom baseDir` | Injected temp dir is used instead of `.orbit/` |

### 4.2 Modify: `tests/claude-cli-runtime.test.ts`

| Test | Description |
|---|---|
| `buildClaudeCliArgs without resume` | Same as current (backward compat) |
| `buildClaudeCliArgs with resume` | Includes `--resume <id>` at end |
| `extractSessionId from init event` | Parses `{ type: "system", session_id: "abc" }` |
| `extractSessionId returns null for no session` | Empty output → null |
| `extractSessionId returns first match` | Multiple events → first `session_id` wins |

### 4.3 New test file: `tests/agent-session.test.ts` (or extend existing)

| Test | Description |
|---|---|
| `send without prior session` | No resume flag, session_id captured and persisted |
| `send with prior session` | `--resume` flag passed, new session_id persisted |
| `resume failure clears and retries` | Mock CLI to fail with "session not found", verify clear + retry |
| `non-resume failure does not retry` | Mock CLI to fail with generic error, verify no retry |
| `retry only once` | Resume failure followed by another failure → throw, no second retry |

## 5. Implementation Order

Suggested sequence to keep each step testable and small:

1. **`.gitignore`** — Add `.orbit/` entry. (1 line)
2. **`types.ts`** — No changes needed yet.
3. **`session-store.ts`** — New module with `SessionRecord`, `load`, `save`, `clear`. Write tests.
4. **`claude-cli-runtime.ts`** — Add `resumeSessionId` to options, modify `buildClaudeCliArgs`, add `sessionId` promise to handle, add `extractSessionId`. Update tests.
5. **`agent-session.ts`** — Add `sessionStore`/`channelId` to options. Implement session load/persist/retry logic in `send()`. Write tests.
6. **`agent-registry.ts`** — Thread `sessionStore` + `channelId` through to `AgentSession`. Update registry tests.
7. **`server/index.ts`** — Create `SessionStore` instance, pass to registry. Smoke test.

## 6. Risk Assessment

| Risk | Likelihood | Mitigation |
|---|---|---|
| `session_id` field name/location differs from assumption | Medium | Write `extractSessionId` to scan all events for any field named `session_id`. Verify with a real CLI run before merging. |
| Resume fails for reasons other than "session not found" | Low | Conservative error matching. Only retry on explicit markers. Log all failures for observability. |
| File write corruption on crash | Low | Write to temp file, then rename (atomic on most FS). On Windows, `fs.renameSync` is atomic within same volume. |
| `--resume` changes CLI behavior in unexpected ways | Low | `--resume` only continues conversation context; it doesn't change permission model or output format. Still passes `--print` and `--output-format stream-json`. |
| Stale session IDs from old server versions | Low | The retry-on-failure mechanism handles this: if the session can't be resumed, we start fresh. |

## 7. Out of Scope (Explicit)

- Multi-channel support (`channelId` is fixed to `"default"`)
- Cross-agent session sharing
- Session summary or memory injection
- UI for viewing/resetting sessions
- Configurable session TTL
- Database persistence
- Changes to channel routing protocol

## 8. Acceptance Criteria Mapping

| Criterion | Design Section |
|---|---|
| `.orbit/` ignored by git | Section 3.7 |
| `session_id` persisted to `.orbit/sessions/default/{agent}.json` | Section 3.4.5 |
| `--resume` passed on next run | Section 3.4.2 |
| Server restart reads from disk | Section 3.1 (`load` reads from file) |
| Invalid/expired session → clear + retry once | Section 3.4.3 + 3.4.4 |
| Unrelated failures not retried | Section 3.4.3 (conservative matching) |
| Existing tests pass | Section 4.2 (backward compat for `buildClaudeCliArgs()`) |
| New tests cover session parsing, persistence, resume args, retry | Sections 4.1–4.3 |

## 9. Open Questions

1. **Actual `session_id` field location**: Need to verify by running `claude --print --output-format stream-json` with a test prompt and inspecting raw output. The parser is designed to scan all events regardless of type, so the exact location shouldn't matter, but a fixture in tests should match real output.

2. **`runId` reuse on retry**: When `send()` retries without resume, it reuses the same `runId`. This is correct — it's the same logical run from RunManager's perspective. The retry is transparent to the caller.

3. **Event publication on retry**: During retry, `terminal.chunk` events continue to publish under the same `runId`. This is correct — the UI should see a single continuous stream.
