# Orbit

[Chinese](./README.zh-CN.md)

Orbit is a local-first chat control surface for coordinating multiple CLI-backed agents in one shared channel.

The current version is intentionally small. It validates the core workflow before adding online sync, custom agents, or multi-device collaboration.

## Features

- One local channel: `Orbit P0`
- Configurable agents with management UI (the `+` button in the agents section)
- Four built-in agents by default: `@pm:`, `@architect:`, `@developer:`, `@tester:`
- Custom agent creation, editing, enable/disable, and delete
- Per-agent configurable permissions (read/write/run/install/git commit, allowed directories)
- Explicit assignment syntax with a colon, for example `@developer: inspect the current project`
- Multiple agent assignments in one channel message
- Per-agent run queue, so long-running work does not block the whole channel
- Codex, Claude Code, and CodeBuddy CLI runtimes using non-interactive output
- Markdown rendering for agent replies
- Collapsible activity panel showing tool and command progress
- Session persistence so agents retain conversation context across runs
- Per-agent runtime homes under `.orbit/` so CLI backends do not share incompatible local sessions
- Channel history injection so agents see what others said since their last run
- Workspace-level configuration: shared system prompt and rules per workspace
- Fixed maximum routing depth (default 10) with depth info in blocking messages
- Local HTTP server with Server-Sent Events

## Not Included Yet

- Persistent database storage
- Online sync or multi-device support
- GitHub PR workflow automation inside Orbit
- General workflow engine or dependency scheduler

## Requirements

- Node.js
- npm
- Codex CLI, Claude Code CLI, and CodeBuddy CLI available on `PATH`

## Install

```powershell
npm install
```

## Run

```powershell
npm run dev
```

Open `http://localhost:4317`.

### Agent Configuration

Agents are configured via the agent manager (`+` in the agents section) or by
editing the config file directly:

```
~/.orbit/workspaces/<workspace-id>/agents.json
```

By default, four agents are seeded: `pm`, `architect`, `developer`, `tester`.
You can add, edit, disable, or remove agents through the UI. Disabled agents
are excluded from routing — mentions like `@disabled_agent:` will not trigger
runs.

Each agent config includes:
- **id**: Unique identifier (alphanumeric, hyphens, underscores)
- **name**: Display name
- **description**: Short description of the agent's purpose
- **role**: One of `pm`, `architect`, `developer`, `tester`, `general`
- **runtime**: `claude-code`, `codex`, or `codebuddy`
- **systemPrompt**: System prompt injected into each run
- **permissionProfile**: Read/write/run/install/git commit permissions and allowed directories
- **enabled**: Whether the agent is active
- **ui.label**: Optional display label override

Changes take effect immediately after save. If any agent is currently running,
save is blocked with a 409 response until the run completes.

**API endpoints:**
- `GET /api/agents` — list all agent configs
- `PUT /api/agents` — save agent configs (validates first)
- `POST /api/agents/reset` — restore default configs

### Workspace Configuration

Each workspace can have workspace-level settings stored in:

```
~/.orbit/workspaces/<workspace-id>/config.json
```

Workspace config fields:

- **systemPrompt** (string, optional): A prompt injected into every agent run
  in the workspace, after Orbit's fixed rules and before the agent's role instruction.
- **rules** (string[], optional): A list of workspace-level rules injected into
  every agent run. Each rule is rendered as a bullet point.

Route depth is fixed at 10 and not configurable.

Without custom configuration, all fields use their defaults (empty prompt, empty
rules), so existing workspaces and conversations continue to work unchanged.

**API endpoints:**
- `GET /api/workspace-config` — get workspace config for the active workspace
- `PUT /api/workspace-config` — update workspace config (validates field types)

To restart the local service on Windows PowerShell and clear the default port first:

```powershell
cd <project-dir>; $p = Get-NetTCPConnection -LocalPort 4317 -State Listen -ErrorAction SilentlyContinue; if ($p) { Stop-Process -Id $p.OwningProcess -Force }; npm run dev
```

## Verify

```powershell
npm run test
npm run build
npm run pack:check
```

`npm run pack:check` validates the npm package boundary. The published package
is intentionally limited to the CLI launcher in `bin/` and built artifacts in
`dist/`; source files, tests, docs, sourcemaps, screenshots, local `.orbit`
state, and packaging scripts must not be included.

## Local Package Smoke Test

Use this flow to test the same package shape that users will install from npm:

```powershell
# In the orbit project directory:

npm install
npm run test
npm run build
npm run pack:check

npm pack
npm install -g .\orbit-0.9.0.tgz

orbit
```

Open `http://localhost:4317` after `orbit` starts.

To inspect the package contents without creating a tarball:

```powershell
npm pack --dry-run --json --ignore-scripts
```

To remove the local global install after testing:

```powershell
npm uninstall -g orbit
```

## Repository Layout

```text
src/
  core/      Agent runtime, routing, queueing, messages, output cleanup
  server/    Local HTTP/SSE server
  shared/    Shared TypeScript types
  ui/        React UI
tests/       Node test suite
docs/        Architecture documentation
```

## Documentation

- [Architecture](./docs/ARCHITECTURE.md)
- [Contributing](./CONTRIBUTING.md)
- [Agent Workflow](./AGENTS.md)
