# Terminology And Routing

This document defines Orbit's public product terms and message routing markers.
Use these terms in docs, issues, PRs, screenshots, and user-facing copy.

## Product Terms

- **Workspace**: a local project directory registered in Orbit. A workspace has
  its own conversations, digital employee settings, workspace rules, sessions,
  attachments, and transcripts.
- **Conversation**: a chat thread inside one workspace. Conversations can keep
  running digital employee work in the background while you view another
  conversation.
- **Digital employee**: an enabled CLI-backed worker configured in Orbit. Each
  digital employee has an internal id, a user-configurable display name, a
  runtime, a system prompt, and optional triggers.
- **Runtime**: the command-line tool that powers a digital employee. Orbit
  currently supports Claude Code, Codex, and CodeBuddy.
- **Interaction mode**: the per-conversation collaboration mode, selected from
  the composer before or during a conversation: 普通对话 (direct chat with one
  digital employee), 简单协作 (lightweight collaboration), or 复杂协作
  (supervised collaboration). New conversations start in 简单协作.
- **Supervisor**: the built-in coordinator enabled by 复杂协作. It decomposes
  the goal, schedules digital employees, tracks progress, recovers from
  failures, and drives the task to closure. It is not a user-configured digital
  employee.
- **Assignment marker**: an `@display-name:` marker that tells Orbit which
  digital employee should receive work. The name is the configured display name,
  not the internal id.
- **Handoff**: a digital employee reply that creates a new assignment marker for
  another digital employee. Handoffs only start work in 简单协作 and 复杂协作.
- **Run queue**: each digital employee processes one run at a time; additional
  assigned work waits in that employee's queue.

Prefer **digital employee** in public docs and UI copy. Use **agent** only when
referring to code-level types, file names, or compatibility with existing source
modules.

## Interaction Modes

| Mode | Who receives work | Handoffs | Supervisor |
| --- | --- | --- | --- |
| 普通对话 | Exactly one digital employee, chosen by `@display-name:`; later messages without a marker continue with the same employee | Never routed — markers in replies are plain text | No |
| 简单协作 | The employee named by `@display-name:` | Allowed when genuinely needed | No |
| 复杂协作 | The supervisor decomposes an unassigned goal; `@display-name:` sets a starting point | Allowed | Yes — tracks progress, recovers failures, closes the task |

Switching the mode only affects the next user message: runs already in progress
or queued keep the mode they were started with. The digital employee session
(its conversation memory) is shared across all three modes, so switching modes
never loses context.

These mode rules are built into Orbit and apply to custom teams as well as the
built-in templates. They do not depend on editable workspace prompts or rules.

## Routing Markers

The built-in software development team starts with the following display names.
Users can rename each employee; after renaming, the new exact name is used in
the marker and in chat history.

| Marker | Typical use |
| --- | --- |
| `@范同经:` | Clarify requirements, scope, acceptance criteria, and product tradeoffs. |
| `@甄架构:` | Inspect code, design implementation boundaries, and review technical risk. |
| `@蔡一平:` | Edit files, run commands, implement changes, and verify locally. |
| `@田小坑:` | Validate behavior, reproduce bugs, and report regressions. |

Custom digital employees use their configured display name. If you rename an
employee to `文档审查`, assign work with `@文档审查:`. Internal ids are never
used as public assignment markers.

## Routing Rules

- `@display-name:` with a colon assigns work to an enabled digital employee.
- Plain `@display-name` without a colon is a reference only and does not start work.
- Multiple assignment markers can appear in one message (简单协作 and 复杂协作).
  Each assigned digital employee receives the full message as context. In
  普通对话 a message may assign only one employee; Orbit asks you to keep a
  single marker.
- Unknown `@display-name:` markers are ignored. They do not create work and do
  not block known assignments in the same message.
- An empty assignment such as `@蔡一平:` with no task text is blocked.
- A digital employee's self-assignment is ignored. For example, a reply from
  `蔡一平` containing only `@蔡一平:` does not schedule another run.
- Agent-to-agent handoff chains are capped at routing depth 10. When the chain
  would exceed that limit, Orbit posts a system message and waits for a manual
  next step.

## Examples

Assign one task:

```text
@蔡一平: Add validation for the settings form, then run the relevant tests.
```

Ask for planning before implementation:

```text
@甄架构: Review the login flow and propose a small implementation plan.
```

Assign independent work in parallel (简单协作 or 复杂协作):

```text
@蔡一平: Implement the fix. @田小坑: Prepare the regression checklist.
```

Mention another digital employee without assigning work:

```text
The previous idea from @甄架构 makes sense to me.
```

Start a goal without naming an employee (复杂协作 — the supervisor coordinates):

```text
Ship the login improvements discussed above and report the result.
```

## Handoffs

In 简单协作 and 复杂协作, digital employees can hand work to each other by
replying with assignment markers. A useful handoff should include enough context
for the next digital employee to act without guessing:

```text
@田小坑: The implementation employee changed the attachment cleanup path. Please run the
regression checklist for draft deletion and conversation deletion.
```

Do not use a plain mention when you want work to start:

```text
Ready for @田小坑 to check this.
```

That sentence is only a reference. Use `@田小坑:` when that employee should run.

In 普通对话, handoff markers are never routed: any `@display-name:` marker in a
digital employee reply is shown as plain text, and the conversation stays with
the employee the user is talking to.

## Troubleshooting Routing

- If no work starts, check that the marker has a colon and uses an enabled
  digital employee display name.
- If only one of several assignments starts, check whether the other display
  name is disabled or unknown.
- If Orbit says an assignment is empty, add task text after every
  `@display-name:`.
- If a collaboration chain stops at the depth limit, send a new user message
  with the next explicit assignment.
- If Orbit asks you to name a digital employee first (简单协作), or to keep a
  single marker (普通对话), follow the hint or switch the interaction mode.
