# Orbit

Orbit is a local-first collaboration workspace for coordinating multiple CLI-backed digital employees across isolated workspaces and conversations.

## Install

Install a release package that matches your operating system:

```powershell
npm install -g .\orbit-<version>-windows-x64.tgz
```

You can also run Orbit from a source checkout:

```powershell
npm ci
npm run build
npm run dev
```

Do not run `npm install -g orbit` against the public npm registry unless this
project has explicitly announced npm ownership. That package name is owned by
an unrelated project and can fail at startup with
`ERR_PACKAGE_PATH_NOT_EXPORTED` for `uuid/v1`.

## Run

```powershell
orbit
```

Open `http://localhost:4317`.

New to Orbit? Start with the [quickstart](docs/QUICKSTART.md). 中文用户请看 [中文快速上手](docs/QUICKSTART.zh-CN.md).

## Requirements

Orbit coordinates CLI-backed agents. The agents require:

| Runtime | Install |
|---------|---------|
| Claude Code | `npm install -g @anthropic-ai/claude-code` |
| Codex | `npm install -g @openai/codex` |
| CodeBuddy | `npm install -g @tencent-ai/codebuddy-code` |

## Features

- Five built-in agent templates: 产品经理（pm）, 架构师（architect）, 开发（developer）, 测试（tester）, 监督者（supervisor）
- Custom agent creation and configuration via UI
- Per-agent permissions (read/write/run/install/git commit)
- Workspace templates for blank or multi-employee collaboration setups
- Multiple conversations with background execution and visible running employees
- Explicit assignments, handoffs, and per-agent run queues
- Collaboration Insights for task outcomes, employee collaboration, execution timelines, and duration trends
- Markdown rendering for agent replies
- Session persistence across runs
