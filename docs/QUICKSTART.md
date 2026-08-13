# Orbit Quickstart

This guide is for first-time Orbit users.

## What Orbit Does

Orbit is a local-first workspace for coordinating CLI-backed digital employees.
The sidebar shows each employee's configurable display name. The built-in
software development team contains four employees:

- `@范同经:` clarifies goals, scope, and acceptance criteria.
- `@甄架构:` designs solutions and evaluates implementation risk.
- `@蔡一平:` edits files, runs commands, and verifies changes.
- `@田小坑:` validates behavior and reports regressions.

Collaboration supervision is a per-conversation mode. It adds an internal
coordinator backed by the selected runtime and is not configured as a fifth
employee.

For the complete public terminology and routing rules, see
[Terminology And Routing](TERMINOLOGY_AND_ROUTING.md).

## Step 0: Check Prerequisites

Orbit requires Node.js 22 or newer and at least one supported runtime:

```powershell
node --version
npm --version
```

Install the runtime you plan to use. Orbit will show the exact install command
for missing runtimes in the employee settings panel.

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

Plain mentions without a colon are references and do not start work. Use
`@all:` to send one task to every enabled employee.

## Step 5: Use Collaboration Supervision

Turn on collaboration supervision in the conversation composer when you want
Orbit to coordinate unassigned user messages and follow-up work. You can turn
it off and on again across the same conversation; the supervision runtime and
internal context are managed per conversation.

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
