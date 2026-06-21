# Changelog

> 中文版本请见 [CHANGELOG.zh-CN.md](./CHANGELOG.zh-CN.md).

---

## v0.9.5 — 2026-06-21

### New things you can do

- **Understand how work gets done.** The new Collaboration Insights page shows
  completed and in-progress tasks, participating digital employees, completion
  trends, end-to-end duration, and a per-run execution timeline that makes
  sequential and parallel work visible.
- **See work continue across conversations.** Conversations keep running in the
  background, and the sidebar identifies which digital employees are active in
  each conversation.
- **Follow handoffs clearly.** Agent cards now show where an assignment came
  from, making multi-employee delegation chains easier to inspect.

### Improvements & fixes

- **More reliable coordination.** Supervisor-only work is included in task
  analysis, supervisor follow-ups retain the triggering message in context, and
  dependency-aware workspace rules avoid assigning sequential work in parallel.
- **Better task outcomes.** Cancelling an intermediate queued run no longer
  marks an otherwise completed task as cancelled; genuine final cancellation,
  failure, and recovery remain visible on the timeline.
- **Queues keep moving.** Cancelling a running task immediately starts the next
  queued task for that employee.
- **Actionable runtime failures.** CLI crashes preserve useful failure clues
  instead of falling back to a generic transcript message.
- **Safer local history.** Message-shard recovery and retention were hardened
  against malformed or missing files, while user-facing lifecycle text no
  longer leaks internal codewords.
- **Clearer setup.** Runtime installation guidance and release-package install
  instructions now match the commands shown in Orbit.

---

## v0.9.4 — 2026-06-14

### Fixes & reliability

- **Starts even when its port is taken.** If Orbit's port (4317) is already in
  use — usually because a previous Orbit didn't exit cleanly — it now closes
  that leftover process and reuses the port, or picks the next free port and
  tells you which one. No more "port in use" dead end.
- **No more stuck tasks after a restart.** Runs that were mid-flight or queued
  when Orbit last stopped are now clearly marked as interrupted (with a prompt
  to resend), instead of spinning forever as "running".
- **More reliable startup.** A port-detection edge case on higher port numbers
  was corrected so the recovery above works consistently.

---

## v0.9.3 — 2026-06-09

### New things you can do

- **Paste images into the chat.** Drop or paste images (PNG / JPEG / WebP)
  straight into the message box, preview them before sending, and the agent
  you're talking to receives them alongside your text.
- **Copy an agent in one click.** A new copy button clones any agent's setup
  into a fresh, switched-off template — handy for creating variations without
  re-entering everything.
- **Actually stop a running agent.** The interrupt button now hard-stops the
  live agent process (not just the queue), so a runaway task ends at once and
  the agent is free for new work.

### Smoother every-day use

- **Jump straight to an agent's settings.** Hover any agent and click the gear
  icon to open that agent's configuration directly.
- **Clearer guidance when a tool is missing.** When a CLI (Claude Code, Codex,
  or CodeBuddy) isn't installed, you get a prominent hint and an install button
  instead of a tiny link.
- **macOS folder picker.** Choosing a workspace folder works on macOS as well
  as Windows.
- **Tidier long messages.** Long code blocks and links no longer break the
  message layout.
- **Conversations stay where you put them.** Clicking a conversation no longer
  bumps it to the top of the list.
- **A consistently Chinese interface.** The whole app — including the agent
  settings page — is now in Chinese. The wording "数字员工" (digital employee)
  replaces the older "智能体".

### Fixes & reliability

- **Cleaner Codex replies.** Codex's internal "commentary" no longer leaks
  into the answer you see, and messages handed off between agents are kept
  correctly in the conversation history.
- **Quieter interrupt feedback.** Stopping a collaboration no longer prints a
  confusing internal message; the button simply shows its "已打断"
  (interrupted) state.
- **Settings sync everywhere.** Changing an agent's configuration now updates
  it across every conversation in the workspace, immediately.
- **Optional transcript logging.** A new workspace setting lets you turn off
  terminal-transcript recording when you don't need it.
- **A smarter coordinator.** Another agent mentioning `@user:` no longer
  wrongly silences the coordinator. Only one coordinator is allowed per
  conversation, and the built-in PM role was strengthened into a true product
  owner.
- **Stronger attachment security.** Uploaded images are checked by their real
  file signature (not just the label), draft attachments are capped per
  conversation, and file handling no longer blocks the app.

---

## v0.9.2 — 2026-06-04

### New things you can do

- **Meet the coordinator.** Add a dedicated coordinator (supervisor) agent that
  can automatically step in when a message isn't addressed to anyone, or when
  an agent gets stuck — keeping work moving without you watching over it.
- **Stop the chain, start something new.** When agents are delegating back and
  forth automatically, a new interrupt button halts the follow-up chain on the
  spot so you can give a fresh instruction right away. The task currently
  running still finishes and shows its result.

### Improvements

- **Agents understand each other better.** The private context handed to each
  agent was reorganized into clear, structured sections, which improves the
  quality of collaboration and reduces confusion.
- **History that doesn't grow forever.** Messages and terminal transcripts are
  now split into time-based shards and aged out automatically by age and count.
  Older messages load on demand via a "load earlier messages" button, so
  long-running conversations stay fast and bounded.

---

## v0.9.1 — 2026-06-02

### New things you can do

- **Per-workspace instructions & rules.** Give each workspace its own system
  prompt and rules, so agents adopt the right context automatically without
  you repeating yourself.
- **Cancel agent runs.** A cancel button drops tasks waiting in an agent's
  queue — or stops one that's running — and the queue correctly moves on to the
  next task.

### Improvements & fixes

- **Reliable Codex answers.** Codex's final answers are now extracted robustly
  even when its output arrives in awkward chunks, and the compact layout got
  tighter and cleaner.
- **Permissions stick around.** Agent permission settings are now saved
  properly, and when a required CLI isn't installed Orbit clearly marks that
  agent as unavailable.

---

## v0.9.0 — 2026-06-01

**Orbit's first public release** — a local-first chat control surface that
coordinates multiple CLI-backed agents (Claude Code, Codex, CodeBuddy) inside
one shared conversation.

- **One channel, many agents.** Assign work with `@agent:` (the colon means
  "go do this"), reference someone with a plain `@agent`, or broadcast to
  everyone with `@all:`.
- **Four built-in agents.** `@pm:`, `@architect:`, `@developer:`, and
  `@tester:` are ready out of the box, each with the right permissions — only
  the developer can write files, commit, and install dependencies.
- **Custom agents.** Create and configure your own agents from the UI,
  including their permissions.
- **Workspaces & conversations.** Organize work into isolated workspaces and
  conversations, each keeping its own history.
- **Orderly task queues.** Each agent runs one task at a time and queues the
  rest automatically.
- **Picks up where you left off.** Sessions persist across runs, so agents can
  resume previous work.
- **Readable replies.** Agent responses render as Markdown with
  syntax-highlighted code blocks, and tool activity is visible as it happens.
