# Orbit v1.2.0 Release Notes

Status: stable release. This release brings the ACP work process into each
digital employee reply card and keeps completed conversations lightweight.

Orbit is a local-first workspace for coordinating CLI-backed digital employees
across isolated workspaces and conversations.

## Release Summary

This release focuses on:

- Ordered ACP process narration, native Plan snapshots, and tool calls inside
  each employee reply card.
- Full live tool details while a task is running, with a collapsed process
  section after completion.
- Durable refresh behavior that keeps process narration and adjacent tool-group
  counts without storing raw tool inputs, names, or results.
- Consistent support across Claude Code, Codex, and CodeBuddy ACP runtimes,
  including CodeBuddy response-boundary detection.
- Bounded terminal-run retention so completed activity does not grow in memory.
- 普通对话 as the default for new conversations, with 简单协作 and 复杂协作
  available from the composer.

## Install

### Public npm

Install the stable package from the owned npm scope:

```bash
npm install -g @kevinforge/orbit@1.2.0
```

After installation, start Orbit:

```bash
orbit
```

Then open `http://localhost:4317`.

Do not run `npm install -g orbit` for this project. The public `orbit` package
name is already occupied by an unrelated package. The scoped package keeps the
CLI command as `orbit`.

### GitHub Release Artifacts

Download the package that matches your operating system from the GitHub Release,
then install it with npm:

```powershell
npm install -g .\orbit-1.2.0-windows-x64.tgz
```

On Linux or macOS, use the matching `.tgz` artifact name:

```bash
npm install -g ./orbit-1.2.0-<platform>.tgz
```

### Source Checkout

```bash
git clone https://github.com/kevinforge/orbit.git
cd orbit
npm ci
npm run build
npm run dev
```

## Supported Platforms

The release packaging workflow targets:

- Windows x64
- Linux x64
- macOS x64
- macOS ARM64

## Runtime Prerequisites

Orbit coordinates local CLI-backed digital employees. Install and authenticate
at least one supported runtime CLI before assigning work to employees:

| Runtime | Install |
| --- | --- |
| Claude Code | `npm install -g @anthropic-ai/claude-code` |
| Codex | `npm install -g @openai/codex` |
| CodeBuddy | `npm install -g @tencent-ai/codebuddy-code` |

Claude Code, Codex, and CodeBuddy are optional choices. A digital employee
cannot run until its selected runtime CLI is available and authenticated.

## What Changed Since 1.1.0

### Process visibility

- ACP process text and tool events now render in their original order.
- The live process timeline shows the latest tool while work is running and
  allows users to expand a group to inspect all tool invocations.
- The final answer is rendered separately from the process timeline as soon as
  it starts streaming.
- Completed reply cards keep full process details on the current page, while a
  refresh restores only compact persisted summaries and process narration.

### Runtime and lifecycle reliability

- Claude Code, Codex, and CodeBuddy share the same process presentation contract.
- CodeBuddy's native agent phase metadata separates multiple model responses
  even when it reuses one ACP message ID.
- Native Plans are shown directly above the process timeline in the reply card.
- Completed, failed, and cancelled runs release raw in-memory activity after
  settlement while preserving a bounded short-lived cancellation lookup.

### Product and contributor experience

- New conversations default to 普通对话; the composer can switch to 简单协作 or
  复杂协作 without changing employee session identity.
- Added the `find-simplifications` and `simplify-code` project Skills.
- Removed the separate task details drawer in favor of one coherent reply-card
  process surface.

## Security And Governance

- License: MIT.
- Security reports: see `SECURITY.md`.
- Community standards: see `CODE_OF_CONDUCT.md`.
- Contribution workflow: see `CONTRIBUTING.md`.
- Dependency license baseline: see `docs/DEPENDENCY_LICENSES.md`.

## Known Limitations

- Users need at least one installed and authenticated runtime CLI before a
  digital employee can run.
- Private license enforcement remains only as an explicit opt-in via
  `ORBIT_REQUIRE_LICENSE=true`; the default public build remains unblocked.
- Platform binary and restart-recovery evidence is produced by the GitHub
  Actions release workflow and should be checked on the published release.

## Verification Evidence

| Check | Status | Evidence |
| --- | --- | --- |
| `npm run release:check:strict` | Passed locally | Release metadata and governance references passed for v1.2.0 |
| `npm run test` | Passed locally | Full repository test suite |
| `npx tsc --noEmit` | Passed locally | TypeScript check |
| Vite production build | Passed locally | UI production bundle built successfully |
| `npm audit --audit-level=moderate` | Release preflight | Local command before tag |
| Standalone binary build | Release workflow | GitHub Actions builds with Bun on each target runner |
| npm package contents | Release workflow | Each platform package is smoke-tested and inspected |
| GitHub Release and npm publish | Release workflow | Tag workflow evidence |

## Documentation

- `README.md`
- `README.zh-CN.md`
- `docs/QUICKSTART.md`
- `docs/QUICKSTART.zh-CN.md`
- `docs/ARCHITECTURE.md`
- `docs/DATA_DIRECTORY.md`
- `docs/TERMINOLOGY_AND_ROUTING.md`
- `docs/RELEASE_DECISIONS.md`
- `docs/RELEASE_CHECKLIST.md`
- `docs/STABILITY_VERIFICATION.md`
- `SECURITY.md`
- `CODE_OF_CONDUCT.md`
- `CONTRIBUTING.md`
