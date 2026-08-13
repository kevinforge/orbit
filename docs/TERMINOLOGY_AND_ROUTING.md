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
- **Collaboration supervision**: a per-conversation mode that adds an internal
  coordinator backed by the runtime selected for that conversation. It is not a
  user-configured digital employee and can be turned on or off between runs.
- **Assignment marker**: an `@display-name:` marker that tells Orbit which
  digital employee should receive work. The name is the configured display name,
  not the internal id.
- **Handoff**: a digital employee reply that creates a new assignment marker for
  another digital employee.
- **Run queue**: each digital employee processes one run at a time; additional
  assigned work waits in that employee's queue.

Prefer **digital employee** in public docs and UI copy. Use **agent** only when
referring to code-level types, file names, or compatibility with existing source
modules.

## Routing Markers

The built-in software development team starts with the following display names.
Users can rename each employee; after renaming, the new exact name is used in
the marker and in chat history.

| Marker | Typical use |
| --- | --- |
| `@需求分析:` | Clarify requirements, scope, acceptance criteria, and product tradeoffs. |
| `@方案设计:` | Inspect code, design implementation boundaries, and review technical risk. |
| `@开发实现:` | Edit files, run commands, implement changes, and verify locally. |
| `@质量验证:` | Validate behavior, reproduce bugs, and report regressions. |
| `@all:` | Send the same task to every enabled digital employee except the sender. |

Custom digital employees use their configured display name. If you rename an
employee to `文档审查`, assign work with `@文档审查:`. Internal ids are never
used as public assignment markers.

## Routing Rules

- `@display-name:` with a colon assigns work to an enabled digital employee.
- Plain `@display-name` without a colon is a reference only and does not start work.
- `@all:` expands to all currently enabled digital employees, excluding the
  sender when a digital employee sends it.
- Multiple assignment markers can appear in one message. Each assigned digital
  employee receives the full message as context.
- Unknown `@display-name:` markers are ignored. They do not create work and do
  not block known assignments in the same message.
- An empty assignment such as `@开发实现:` with no task text is blocked.
- A digital employee's self-assignment is ignored. For example, a reply from
  `开发实现` containing only `@开发实现:` does not schedule another run.
- Agent-to-agent handoff chains are capped at routing depth 10. When the chain
  would exceed that limit, Orbit posts a system message and waits for a manual
  next step.

## Examples

Assign one task:

```text
@开发实现: Add validation for the settings form, then run the relevant tests.
```

Ask for planning before implementation:

```text
@方案设计: Review the login flow and propose a small implementation plan.
```

Assign independent work in parallel:

```text
@开发实现: Implement the fix. @质量验证: Prepare the regression checklist.
```

Mention another digital employee without assigning work:

```text
The previous idea from @方案设计 makes sense to me.
```

Ask all enabled digital employees to inspect the same context:

```text
@all: Review this release candidate plan and call out blockers.
```

## Handoffs

Digital employees can hand work to each other by replying with assignment
markers. A useful handoff should include enough context for the next digital
employee to act without guessing:

```text
@质量验证: The implementation employee changed the attachment cleanup path. Please run the
regression checklist for draft deletion and conversation deletion.
```

Do not use a plain mention when you want work to start:

```text
Ready for @质量验证 to check this.
```

That sentence is only a reference. Use `@质量验证:` when that employee should run.

## Troubleshooting Routing

- If no work starts, check that the marker has a colon and uses an enabled
  digital employee display name.
- If only one of several assignments starts, check whether the other display
  name is disabled or unknown.
- If Orbit says an assignment is empty, add task text after every
  `@display-name:`.
- If a collaboration chain stops at the depth limit, send a new user message
  with the next explicit assignment.
