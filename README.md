# Orbit

Orbit is a local-first chat control surface for coordinating multiple CLI-backed agents in one shared channel.

## Install

Install the release package provided by your administrator:

```powershell
npm install -g .\orbit-<version>.tgz
```

Install Orbit from the release tarball or private registry package provided by
your administrator. Do not run `npm install -g orbit` against the public npm
registry: that package name is owned by an unrelated project and can fail at
startup with `ERR_PACKAGE_PATH_NOT_EXPORTED` for `uuid/v1`.

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
- Multiple agent assignments in one message
- Per-agent run queue
- Workspace work analysis for completed tasks, employee collaboration, and duration trends
- Markdown rendering for agent replies
- Session persistence across runs
