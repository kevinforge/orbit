# Orbit Quickstart

This guide is for first-time Orbit users. Follow the steps in order.

## What Orbit Does

Orbit is a local-first workspace for coordinating CLI-backed agents. The sidebar uses Chinese display names with stable ids in parentheses:

- 产品经理（pm）
- 架构师（architect）
- 开发（developer）
- 测试（tester）
- 监督者（supervisor）

Message routing still uses the fixed `@id:` marker:

- `@pm:` asks the product manager to clarify requirements and scope.
- `@architect:` asks the architect to inspect code, design a plan, and review risk.
- `@developer:` asks the developer to edit code, run commands, and verify changes.
- `@tester:` asks the tester to validate behavior and report issues.
- `@supervisor:` asks the supervisor to coordinate the conversation toward completion.
- `@all:` sends a task to all currently enabled agents.

For first-time use, choose the multi-agent collaboration workspace template. Orbit will enable a useful default set of agents for collaborative development.

## Step 0: Check Prerequisites

First check whether Node.js and at least one agent runtime are already installed. If they are already available, you can skip the matching install steps.

Open PowerShell or your terminal:

```powershell
node --version
npm --version
```

If `node --version` prints `v20.x.x` or newer, and `npm --version` prints a version, Node.js and npm are ready.

If Node.js is missing or older than 20:

1. Open https://nodejs.org/
2. Download the LTS version. Use Node.js 20 or newer.
3. Install it with the default options.
4. Close your terminal and open a new one.
5. Run `node --version` and `npm --version` again.

Orbit provides the web workspace. The actual work is performed by CLI runtimes. You only need at least one runtime to start; you do not need to install all three up front.

Check your runtimes:

```powershell
claude --version
codex --version
codebuddy --version
```

If at least one command prints a version, you can continue. Missing runtimes can be installed later from the Orbit UI prompts.

If none of the commands work, install at least one runtime:

| Runtime | Common use | Install |
| --- | --- | --- |
| Claude Code | Development and supervision | `npm install -g @anthropic-ai/claude-code` |
| OpenAI Codex | Product, architecture, general work | `npm install -g @openai/codex` |
| CodeBuddy | Testing or custom agents | `npm install -g @tencent-ai/codebuddy-code` |

If npm installs hang, time out, or cannot download packages, your network may not be able to reach the npm registry reliably. Use a network/proxy that can access npm, or temporarily switch to a mirror:

```powershell
npm config set registry https://registry.npmmirror.com
```

If you are on a company proxy, configure npm or your shell proxy settings before running `npm install -g ...`.

After installing a runtime, run the version check again, for example `codebuddy --version`. Then run that CLI directly in your terminal and complete its own login or authorization flow. Orbit can only use CLIs that already work on your machine.

## Step 1: Install Orbit

Open PowerShell or your terminal:

```powershell
npm install -g orbit
```

After installation, get your machine ID:

```powershell
orbit --machine-id
```

Orbit prints a machine ID and creates the license directory. The output explains where to place `license.json`.

Send the machine ID to your administrator. After they give you `license.json`, place it here:

```text
C:\Users\YourName\.orbit\license.json
```

On macOS or Linux, the path is usually:

```text
~/.orbit/license.json
```

The filename must be exactly `license.json`.

## Step 2: Start Orbit

After placing the license file, run:

```powershell
orbit
```

When Orbit starts successfully, it prints a browser URL. Open:

```text
http://localhost:4317
```

## Step 3: Create Your First Workspace

A workspace is the local project folder you want Orbit to work on.

1. Open the Orbit page.
2. Click the `+` next to Workspace in the sidebar.
3. Choose a local project folder.
4. If Orbit asks you to choose a template, first-time users should choose multi-agent collaboration.
5. After creation, the workspace and a new conversation appear in the sidebar.

The multi-agent collaboration template enables 架构师（architect）, 开发（developer）, 测试（tester）, and 监督者（supervisor） by default, and assigns them to an available runtime. A blank workspace keeps agents disabled so you can configure them yourself.

## Step 4: Check Agents and Runtimes

If no agents are enabled:

1. Click the `+` next to Agents.
2. Turn on the agents you need.
3. New users should enable at least 开发（developer）; for collaborative flow, also enable 架构师（architect）, 测试（tester）, and 监督者（supervisor）.
4. Check that each agent runtime is available.
5. Click Save.

If Orbit says a runtime is missing, use the install link shown in the UI. After installation or login, return to Orbit and click re-detect runtime environment.

## Step 5: Send Your First Task

Type a message with an `@agent-id:` marker and press Enter. Use the id in parentheses, not the display name.

Example:

```text
@architect: Please inspect this project structure, explain what it does in beginner-friendly language, and tell me where to start if I want to add a feature.
```

Or ask the developer to make a small change:

```text
@developer: Please add local startup steps to the README. Keep the change small, run relevant checks, and tell me which files changed.
```

If the supervisor is enabled, you can also describe the goal without an explicit agent:

```text
Please add login form validation to this project. Evaluate the plan first, then implement, then test.
```

## Troubleshooting

### There Is No `.orbit` Directory

Run:

```powershell
orbit --machine-id
```

Orbit will create the directory and print the exact location for `license.json`.

### `orbit` Says `license.json` Was Not Found

Run:

```powershell
orbit --machine-id
```

Send the machine ID to your administrator, get `license.json`, and place it at:

```text
C:\Users\YourName\.orbit\license.json
```

Then run:

```powershell
orbit
```

### A Runtime Is Missing

Check the CLI in your terminal:

```powershell
claude --version
codex --version
codebuddy --version
```

You only need to check the runtime you use. After installing or logging in, return to Orbit and click re-detect runtime environment.

### Where Does Orbit Store Data?

Orbit stores local data under `~/.orbit`, including workspaces, conversations, messages, run records, and the license file. On Windows this is usually:

```text
C:\Users\YourName\.orbit
```
