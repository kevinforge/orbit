# Orbit Quickstart

This guide is for first-time Orbit users.

## What Orbit Does

Orbit is a local-first workspace for coordinating digital employees powered by
Claude Code, Codex, or CodeBuddy through the Agent Client Protocol (ACP).
The sidebar shows each employee's configurable display name. The built-in
software development team contains four employees:

- `@范同经:` clarifies goals, scope, and acceptance criteria.
- `@甄架构:` designs solutions and evaluates implementation risk.
- `@蔡一平:` edits files, runs commands, and verifies changes.
- `@田小坑:` validates behavior and reports regressions.

Every conversation has an interaction mode, selected from the composer:
普通对话 (direct chat with one employee), 简单协作 (lightweight collaboration,
the default for new conversations), and 复杂协作 (supervised collaboration).
复杂协作 adds an internal supervisor backed by the selected runtime; it is not
configured as a fifth employee.

For the complete public terminology and routing rules, see
[Terminology And Routing](TERMINOLOGY_AND_ROUTING.md).

## Step 0: Check Prerequisites

Orbit requires Node.js 22 or newer and at least one supported runtime:

```powershell
node --version
npm --version
```

Install the vendor runtime you plan to use. Orbit includes the ACP adapters it
needs and does not require users to install protocol adapters separately.
Orbit will show the vendor setup guide for a missing runtime in the employee
settings panel.

## Step 1: Start Orbit

From the project directory:

```powershell
npm ci
npm run build
npm run dev
```

Open `http://localhost:4317`.

## Step 2: Create A Workspace

1. Choose **New workspace**.
2. Select the local project directory.
3. Choose the **software development team** template.
4. After creation, the workspace and a new conversation appear in the sidebar.

The template enables the four built-in employees and assigns available
runtimes. You can rename, disable, remove, or add employees from settings.

## Step 3: Check Employees And Runtimes

1. Open the digital employee settings from the sidebar.
2. Confirm each enabled employee has a unique display name.
3. Confirm the selected runtime is available.
4. Rename an employee when a name better fits your workflow.
5. Save the configuration.

Only the display name is used in public assignment markers. Internal ids are
used only for persistence and runtime bookkeeping.

## Step 4: Send Your First Task

Type an assignment with the exact display name shown in the sidebar:

```text
@甄架构: Please inspect this project structure and propose a small implementation plan.
```

To send independent work in parallel:

```text
@蔡一平: Implement the fix. @田小坑: Prepare the regression checklist.
```

Plain mentions without a colon are references and do not start work. In 简单协作
and 复杂协作 a message may assign several employees; in 普通对话 it may assign
exactly one.

## Step 5: Switch Interaction Modes

Use the mode menu in the conversation composer to switch between the three
interaction modes at any time:

- 普通对话: talk to exactly one employee. `@display-name:` picks the employee;
  later messages without a marker continue with the same employee. Handoff
  markers in replies are plain text and never start other employees.
- 简单协作: assign work with `@display-name:`; employees hand off to each other
  only when genuinely needed.
- 复杂协作: describe a goal without a marker and the built-in supervisor
  decomposes, schedules, tracks, and drives it to closure.

Switching only affects the next message you send; runs already in progress keep
their own mode. Digital employee sessions are shared across modes, so switching
never loses conversation memory.

## Troubleshooting

### A Runtime Is Missing

Install the command shown in the settings panel, complete that runtime's own
login flow, then click **re-detect runtime environment**.

### An Assignment Does Not Start

Check that the marker uses an enabled employee's exact display name and ends
with `:`. Check that task text follows the marker.

### A Collaboration Chain Stops

Orbit limits automatic handoff depth to protect the conversation from loops.
Send a new explicit assignment to continue after the depth limit.

## Further Reading

- [Terminology And Routing](TERMINOLOGY_AND_ROUTING.md)
- [Architecture](ARCHITECTURE.md)
- [Local Data](DATA_DIRECTORY.md)
