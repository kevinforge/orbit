# Orbit

Orbit is a local-first collaboration workspace for coordinating multiple CLI-backed digital employees across isolated workspaces and conversations.

## Install

Install the public npm package:

```powershell
npm install -g @kevinforge/orbit
```

You can also install a GitHub Release package that matches your operating
system:

```powershell
npm install -g .\orbit-<version>-windows-x64.tgz
```

You can also run Orbit from a source checkout:

```powershell
npm ci
npm run build
npm run dev
```

Do not run `npm install -g orbit` against the public npm registry. That package
name is owned by an unrelated project and can fail at startup with
`ERR_PACKAGE_PATH_NOT_EXPORTED` for `uuid/v1`.

## Run

```powershell
orbit
```

Open `http://localhost:4317`.

New to Orbit? Start with the [quickstart](docs/QUICKSTART.md). Chinese readers can use the [Chinese quickstart](docs/QUICKSTART.zh-CN.md).

## Requirements

Orbit coordinates CLI-backed digital employees. The digital employees require at least one supported runtime CLI:

| Runtime | Install |
|---------|---------|
| Claude Code | `npm install -g @anthropic-ai/claude-code` |
| Codex | `npm install -g @openai/codex` |
| CodeBuddy | `npm install -g @tencent-ai/codebuddy-code` |

## Features

- Five built-in digital employee templates: product manager (`pm`), architect, developer, tester, and supervisor
- Custom digital employee creation and configuration via UI
- Per-employee permissions for file access, commands, dependency installs, and git operations
- Workspace templates for blank or multi-employee collaboration setups
- Multiple conversations with background execution and visible running employees
- Explicit assignments, handoffs, and per-employee run queues
- Collaboration Insights for task outcomes, employee collaboration, execution timelines, and duration trends
- Markdown rendering for employee replies
- Session persistence across runs

## License And Security

Orbit is released under the [MIT License](LICENSE). Please report security
issues through the policy in [SECURITY.md](SECURITY.md).

## Support

See [SUPPORT.md](https://github.com/kevinforge/orbit/blob/main/SUPPORT.md) for
bug reports, feature requests, security reporting, and support expectations.

## Local Data

Orbit stores local product data under `~/.orbit`. See
[docs/DATA_DIRECTORY.md](docs/DATA_DIRECTORY.md) for the data layout, backup,
restore, and reset guidance.

## Terminology And Routing

See [docs/TERMINOLOGY_AND_ROUTING.md](docs/TERMINOLOGY_AND_ROUTING.md) for the
public product terms and `@developer:` style assignment marker rules.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and
[docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md) for release
verification. The 1.0 release notes are in
[docs/RELEASE_NOTES_v1.0.0.md](docs/RELEASE_NOTES_v1.0.0.md).
