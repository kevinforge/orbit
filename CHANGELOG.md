# Changelog

> 中文版本请见 [CHANGELOG.zh-CN.md](./CHANGELOG.zh-CN.md).

---

## Unreleased

No notable changes yet.

---

## v1.3.0 — 2026-09-02

### New things you can do

- **Attach files to a conversation.** Upload images, PDFs, text, Markdown, and
  common source/config files from the composer, then preview or download them
  from message history. Images are delivered natively when the runtime supports
  them; other files are shared as local ACP resource links.
- **Use each runtime's native slash commands.** Type `/` in direct mode or after
  an explicit employee marker to discover, filter, page through, and complete
  commands announced over ACP.
- **Choose the supervisor runtime and model.** Each conversation can configure
  which supported runtime and model powers the supervisor without changing the
  digital employee team.
- **Visit the Orbit product website.** The repository now includes a dedicated
  landing page and GitHub Pages deployment workflow.

### Improvements & fixes

- Conversation page context is isolated so late events and async responses from
  a previous page cannot overwrite the active conversation.
- Attachment storage now includes bounded drafts, filename recovery, safe
  download handling, retention cleanup, and image-only message routing.
- CodeBuddy task snapshots appear in the existing plan board, while native
  command discovery handles cold starts, retries, large command lists, and
  announcement/probe races.
- Mention and slash-command menus now preserve IME composition, Enter/Tab
  completion, Shift+Enter newlines, Esc dismissal, and keyboard paging.
- Streamed final answers no longer flash between the process timeline and reply
  body while runtime settlement is still pending.
- Website build dependencies were refreshed, including Vite, Wrangler, and the
  Cloudflare Vite plugin.

---

## v1.2.0 — 2026-08-21

### New things you can do

- **See the work behind every answer.** ACP process narration, native plans, and
  ordered tool calls now appear inside the digital employee reply card.
- **Keep the full live process visible.** While a task is running, the process
  timeline streams in order and tool groups can be expanded to inspect every
  invocation.
- **Use a lighter completed view.** Completed cards collapse the process region
  by default; after a refresh, durable process text and compact tool counts are
  restored without persisting raw tool inputs or results.

### Improvements & fixes

- All three ACP runtimes are covered: Claude Code, Codex, and CodeBuddy. CodeBuddy
  response boundaries are detected from its native agent phase metadata.
- Native Plan snapshots now live on the reply card instead of a separate task
  details drawer.
- Terminal runs release their full in-memory activity after settlement while
  retaining a bounded short-lived cancellation result.
- New conversations start in 普通对话, with 简单协作 and 复杂协作 available from
  the composer.
- Added the `find-simplifications` and `simplify-code` project Skills.

---

## v1.1.0 — 2026-08-19

### New things you can do

- **One protocol for every runtime.** Claude Code, Codex, and CodeBuddy all run
  over Agent Client Protocol (ACP) v1. The Claude Code (`claude-agent-acp`) and
  Codex (`codex-acp`) adapters ship bundled with Orbit, so no extra adapter
  install is needed; CodeBuddy connects through `codebuddy --acp`.
- **Approve work in the conversation.** Permission requests from digital
  employees surface as approval cards in chat. The message's approval mode
  (`ask` or full access) follows the entire handoff chain.
- **Answer structured questions.** Employees can ask structured elicitation
  questions in chat, and their native plans are surfaced while they work.
- **Pick a collaboration mode per conversation.** 普通对话 (direct),
  简单协作 (collaborative), and 复杂协作 (supervised) modes replace the old
  always-on routing. New conversations start in 简单协作, and the mode can be
  switched mid-conversation without losing employee session context.
- **Delegate to a built-in supervisor.** 复杂协作 enables the internal
  supervisor (监工) that decomposes goals, schedules employees, tracks
  progress, recovers from failures, and drives the task to closure.
- **Build your own digital employee team.** Employees are fully editable:
  rename them, rewrite their prompts, add or remove them, or apply the built-in
  software development team template (范同经 / 甄架构 / 蔡一平 / 田小坑).
  Per-employee permission settings were removed in favor of the message-level
  approval mode.
- **Stop everything at once.** Stopping a conversation discards queued tasks
  and moves running tasks through an explicit cancelling state until the
  runtime settles, preserving partial output instead of mixing it into the
  next task.

### Improvements & fixes

- **Redesigned collaboration workspace.** A desktop-style UI with a task
  detail drawer, execution timelines, and a clearer composer (built with
  tdesign-react).
- **Safer rendering.** External links in employee output only open http(s)
  URLs, guarding against `javascript:` and `data:` URLs; ACP progress chatter
  no longer leaks into final answers.
- **More reliable supervision.** The stop button stays visible while the
  supervisor runs, user messages sent during a supervised run are queued, and
  interaction expiry timers fire reliably in CI environments.

---

## v1.0.0 — 2026-07-08

### New things you can do

- **Open source 1.0.** Orbit 1.0.0 is publicly installable and auditable under
  the MIT license, with governance files (`SECURITY.md`,
  `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`) and public npm/GitHub Release
  distribution.
- **No license file required by default.** Standalone startup works without
  `license.json`; private licensed builds opt in with
  `ORBIT_REQUIRE_LICENSE=true`.

### Improvements & fixes

- **Install from npm or Release artifacts.** The package publishes as
  `@kevinforge/orbit` with standalone binaries for Windows x64, Linux x64, and
  macOS x64/ARM64.
- **Recover from runtime errors.** An employee in `error` state can be retried
  by sending a normal unassigned message in the same conversation.
- **Clearer upstream busy signals.** Claude Code `529 overloaded` failures are
  summarized as an upstream model service busy condition.
- **Documented local data.** `docs/DATA_DIRECTORY.md` covers layout, backup,
  restore, and reset of `~/.orbit`; `docs/TERMINOLOGY_AND_ROUTING.md` defines
  product terms and assignment markers.

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
