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
  digital employee has an id, display name, runtime, system prompt, permissions,
  and optional triggers.
- **Runtime**: the command-line tool that powers a digital employee. Orbit
  currently supports Claude Code, Codex, and CodeBuddy.
- **Supervisor**: a coordinator-role digital employee. It watches the
  conversation and can assign work, but it is configured without file, command,
  dependency-install, or git permissions.
- **Assignment marker**: an `@id:` marker that tells Orbit which digital
  employee should receive work.
- **Handoff**: a digital employee reply that creates a new assignment marker for
  another digital employee.
- **Run queue**: each digital employee processes one run at a time; additional
  assigned work waits in that employee's queue.

Prefer **digital employee** in public docs and UI copy. Use **agent** only when
referring to code-level types, file names, or compatibility with existing source
modules.

## Default Routing Markers

The default templates use stable ids. The display names can be localized, but
routing uses the id inside the marker.

| Marker | Default role | Typical use |
| --- | --- | --- |
| `@pm:` | Product manager | Clarify requirements, scope, acceptance criteria, and product tradeoffs. |
| `@architect:` | Architect | Inspect code, design implementation boundaries, and review technical risk. |
| `@developer:` | Developer | Edit files, run commands, implement changes, and verify locally. |
| `@tester:` | Tester | Validate behavior, reproduce bugs, and report regressions. |
| `@supervisor:` | Supervisor | Coordinate the conversation and decide next assignments. |
| `@all:` | All enabled digital employees | Send the same task to every enabled digital employee except the sender. |

Custom digital employees use their configured id. If you create a custom id
`docs-reviewer`, assign work with `@docs-reviewer:`.

## Routing Rules

- `@id:` with a colon assigns work to an enabled digital employee.
- Plain `@id` without a colon is a reference only and does not start work.
- `@all:` expands to all currently enabled digital employees, excluding the
  sender when a digital employee sends it.
- Multiple assignment markers can appear in one message. Each assigned digital
  employee receives the full message as context.
- Unknown `@id:` markers are ignored. They do not create work and do not block
  known assignments in the same message.
- An empty assignment such as `@developer:` with no task text is blocked.
- A digital employee's self-assignment is ignored. For example, a developer
  reply containing only `@developer:` does not schedule another developer run.
- Agent-to-agent handoff chains are capped at routing depth 10. When the chain
  would exceed that limit, Orbit posts a system message and waits for a manual
  next step.

## Examples

Assign one task:

```text
@developer: Add validation for the settings form, then run the relevant tests.
```

Ask for planning before implementation:

```text
@architect: Review the login flow and propose a small implementation plan.
```

Assign independent work in parallel:

```text
@developer: Implement the fix. @tester: Prepare the regression checklist.
```

Mention another digital employee without assigning work:

```text
The previous idea from @architect makes sense to me.
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
@tester: The developer changed the attachment cleanup path. Please run the
regression checklist for draft deletion and conversation deletion.
```

Do not use a plain mention when you want work to start:

```text
Ready for @tester to check this.
```

That sentence is only a reference. Use `@tester:` when the tester should run.

## Troubleshooting Routing

- If no work starts, check that the marker has a colon and uses an enabled
  digital employee id.
- If only one of several assignments starts, check whether the other id is
  disabled or unknown.
- If Orbit says an assignment is empty, add task text after every `@id:`.
- If a collaboration chain stops at the depth limit, send a new user message
  with the next explicit assignment.
