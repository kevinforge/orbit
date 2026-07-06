# Orbit 1.0 Stability Verification

Use this guide when preparing `v1.0.0-rc.*` and `v1.0.0`. It turns the
stability release gate into repeatable checks with evidence that can be copied
into the release PR or release notes.

Run these checks on every officially supported operating system before the final
1.0 tag. For release candidates, record which platforms were verified and which
remain unverified.

## Evidence To Record

For each platform, record:

- Operating system and CPU architecture.
- Git commit or release artifact name.
- Node.js, npm, and Bun versions.
- Runtime CLIs installed: Claude Code, Codex, and CodeBuddy.
- Whether the app was started from source, a built binary, or an npm package.
- Commands run and their exit codes.
- Any screenshots or copied UI text for failures, cancelled runs, or recovery
  states.
- The `~/.orbit` backup location used during the check.

## Automated Baseline

Run these before manual stability checks:

```bash
npm run test
npm run build
npm audit --audit-level=moderate
npm run smoke:start
npm run smoke:port-conflict
npm pack --dry-run --json
```

Current automated coverage includes:

- `tests/message-store.test.ts` verifies `markAbandonedActiveRuns` marks
  persisted `running` and `queued` digital employee messages as `cancelled`
  after restart.
- `tests/run-manager.test.ts` verifies cancelling a running run starts the next
  queued run without stalling the queue.
- `tests/terminal-transcript-store.test.ts` verifies transcript persistence,
  segment rolling, locked-file retry behavior, and UTF-8-safe tail loading.
- `tests/work-analysis.test.ts` verifies cancelled, failed, running, and
  recovered task outcomes in Collaboration Insights.
- `scripts/smoke-start.mjs` starts the built app and waits for
  `GET /api/state` to return 200.
- `scripts/smoke-port-conflict.mjs` occupies a local port, starts Orbit with
  `ORBIT_PORT` set to that port, and verifies the startup failure names the
  occupied port plus the port override recovery path.
- Both smoke scripts run Orbit with an isolated temporary home directory so
  automated checks do not read, write, or race against the user's real
  `~/.orbit` data.

These tests do not replace cross-platform manual verification. They provide the
baseline that makes a manual failure easier to diagnose.

## Data Safety Setup

Back up `~/.orbit` before destructive checks.

Windows PowerShell:

```powershell
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
Copy-Item -Recurse -Force "$HOME\.orbit" "$HOME\orbit-backup-$stamp"
```

macOS or Linux:

```bash
stamp="$(date +%Y%m%d-%H%M%S)"
cp -a "$HOME/.orbit" "$HOME/orbit-backup-$stamp"
```

If the machine has no existing Orbit data, create a fresh workspace and note
that the check used new local data.

## Startup And Port Recovery

1. Start Orbit from the release candidate artifact or built binary.
2. Open `http://localhost:4317`.
3. Verify `GET /api/state` returns 200.
4. Stop Orbit and restart with a non-default port:

```bash
ORBIT_PORT=4318 orbit
```

On Windows PowerShell:

```powershell
$env:ORBIT_PORT = "4318"
orbit
```

5. Verify `http://localhost:4318/api/state` returns 200.
6. Start a second process on the same port and verify Orbit reports a clear
   startup error or recovers only when it can identify an Orbit-owned process.
7. Confirm no messages, workspace config, agent config, attachments, sessions,
   or transcripts were lost after the failed startup.

## Restart Recovery

1. Open a workspace with at least two enabled digital employees.
2. Send a task that starts one employee and queues another. Use explicit
   assignment markers such as `@developer:` and a follow-up handoff if needed.
3. While one employee is running and another is queued, kill the Orbit server
   process from the operating system.
4. Restart Orbit.
5. Open the same workspace and conversation.
6. Verify the previously running task is shown as interrupted or cancelled, not
   permanently running.
7. Verify the previously queued task is cancelled or recoverable, not
   permanently queued.
8. Send a new task to the same employee and confirm it starts normally.
9. Record the message text shown for the interrupted and queued tasks.

## Queue Cancellation

1. Start a long-running task for one employee.
2. Queue at least one additional task behind it for the same employee.
3. Cancel the queued task and verify it does not start after the active task
   completes.
4. Queue two tasks, cancel the running task, and verify the next eligible queued
   task starts.
5. Confirm the UI shows a recoverable final state for both cancellations.

## Local Data Persistence

1. Create or open a workspace.
2. Create a conversation with messages, at least one digital employee run,
   workspace rules, agent configuration changes, an attachment, and terminal
   transcript output if run logs are enabled.
3. Stop Orbit normally.
4. Start Orbit again.
5. Verify messages, sessions, workspace config, agent config, attachments, and
   transcripts still load.
6. Confirm deleting a conversation removes only that conversation's messages,
   sessions, attachments, and transcripts from `~/.orbit`.
7. Confirm deleting a workspace does not delete the source project directory.

See `docs/DATA_DIRECTORY.md` for the expected file layout.

## Background Conversations And Insights

1. Start a digital employee task in one conversation.
2. Switch to another conversation while the task is running.
3. Verify the sidebar still shows running activity for the background
   conversation.
4. Return to the original conversation and confirm live status and final output
   are still visible.
5. Open Collaboration Insights.
6. Verify it loads after a normal restart.
7. Verify it still loads after a cancelled, failed, or recovered task.

## Release Evidence Template

Copy this into the release PR or release notes for each platform:

```text
Platform:
Artifact or commit:
Node/npm/Bun:
Runtime CLIs:
Startup:
ORBIT_PORT:
Failed startup:
Restart recovery:
Queue cancellation:
Local data persistence:
Background conversations:
Collaboration Insights:
Known issues:
Evidence links:
```
