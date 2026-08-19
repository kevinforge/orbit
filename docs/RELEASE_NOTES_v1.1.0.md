# Orbit v1.1.0 Release Notes

Status: stable release. This release unifies the three runtime adapters under
ACP v1, adds per-conversation collaboration modes with a built-in supervisor,
and redesigns the collaboration workspace.

Orbit is a local-first workspace for coordinating CLI-backed digital employees
across isolated workspaces and conversations. The 1.1 release makes every
runtime speak the same Agent Client Protocol, brings approval and elicitation
into the conversation, and introduces supervised collaboration.

## Release Summary

This release focuses on:

- One ACP v1 protocol for Claude Code, Codex, and CodeBuddy. The
  `claude-agent-acp` and `codex-acp` adapters ship bundled; CodeBuddy connects
  through `codebuddy --acp`.
- Permission approval cards and structured elicitation questions surfaced in
  chat, with the message-level approval mode (`ask` or full access) propagated
  along the full handoff chain.
- Per-conversation collaboration modes: 普通对话 (direct), 简单协作
  (collaborative), and 复杂协作 (supervised). New conversations start in
  简单协作 and the mode can be switched mid-conversation without losing
  employee session context.
- A built-in supervisor (监工) for 复杂协作 that decomposes goals, schedules
  employees, tracks progress, recovers from failures, and drives tasks to
  closure.
- Fully editable digital employee teams, including the built-in software
  development team template (范同经 / 甄架构 / 蔡一平 / 田小坑). Per-employee
  permission settings were removed in favor of the message-level approval mode.
- A redesigned desktop-style collaboration workspace with a task detail drawer,
  execution timelines, and a clearer composer built with tdesign-react.
- Safer rendering: external links in employee output only open http(s) URLs, and
  ACP progress chatter no longer leaks into final answers.
- More reliable supervision: the stop button stays visible while the supervisor
  runs, user messages sent during a supervised run are queued, and interaction
  expiry timers fire reliably in CI environments.

## Install

### Public npm

Install the stable package from the owned npm scope:

```bash
npm install -g @kevinforge/orbit@1.1.0
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
npm install -g .\orbit-1.1.0-windows-x64.tgz
```

On Linux or macOS, use the matching `.tgz` artifact name:

```bash
npm install -g ./orbit-1.1.0-<platform>.tgz
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

## What Changed Since 1.0.0

### New things you can do

- **One protocol for every runtime.** Claude Code, Codex, and CodeBuddy all run
  over Agent Client Protocol (ACP) v1. The Claude Code (`claude-agent-acp`) and
  Codex (`codex-acp`) adapters ship bundled with Orbit, so no extra adapter
  install is needed; CodeBuddy connects through `codebuddy --acp`.
- **Approve work in the conversation.** Permission requests from digital
  employees surface as approval cards in chat. The message's approval mode
  (`ask` or full access) follows the entire handoff chain.
- **Answer structured questions.** Employees can ask structured elicitation
  questions in chat, and their native plans are surfaced while they work.
- **Pick a collaboration mode per conversation.** 普通对话 (direct),
  简单协作 (collaborative), and 复杂协作 (supervised) modes replace the old
  always-on routing. New conversations start in 简单协作, and the mode can be
  switched mid-conversation without losing employee session context.
- **Delegate to a built-in supervisor.** 复杂协作 enables the internal
  supervisor (监工) that decomposes goals, schedules employees, tracks
  progress, recovers from failures, and drives the task to closure.
- **Build your own digital employee team.** Employees are fully editable:
  rename them, rewrite their prompts, add or remove them, or apply the built-in
  software development team template (范同经 / 甄架构 / 蔡一平 / 田小坑).
  Per-employee permission settings were removed in favor of the message-level
  approval mode.
- **Stop everything at once.** Stopping a conversation discards queued tasks
  and moves running tasks through an explicit cancelling state until the
  runtime settles, preserving partial output instead of mixing it into the
  next task.

### Improvements & fixes

- **Redesigned collaboration workspace.** A desktop-style UI with a task
  detail drawer, execution timelines, and a clearer composer (built with
  tdesign-react).
- **Safer rendering.** External links in employee output only open http(s)
  URLs, guarding against `javascript:` and `data:` URLs; ACP progress chatter
  no longer leaks into final answers.
- **More reliable supervision.** The stop button stays visible while the
  supervisor runs, user messages sent during a supervised run are queued, and
  interaction expiry timers fire reliably in CI environments.

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
- Multi-page workspace and same-session concurrency hardening continues in
  issue #116.

## Verification Evidence

Use this section as the release audit trail. Local evidence is completed before
the release PR is marked ready; workflow evidence is completed by GitHub Actions
before publishing the tag.

| Check | Status | Evidence |
| --- | --- | --- |
| `npm run release:check:strict` | Passed locally | Release metadata and governance references passed for v1.1.0 |
| `npm run test` | Passed locally | Full repository test suite passed |
| `npm run build` | Passed in CI | TypeScript and Vite build passed locally; standalone build completed in CI with Bun |
| `npm audit --audit-level=moderate` | Passed locally | 0 vulnerabilities after `npm audit fix` |
| npm package contains Windows x64, Linux x64, macOS x64, and macOS ARM64 binaries | Release workflow verification | Release artifacts and npm package payload |
| GitHub Actions CI result | PR verification | CI check on the release PR |
| Release workflow result for each platform package | Tag verification | GitHub Actions Release workflow |
| npm publish workflow result | Tag verification | GitHub Actions Release workflow |
| SHA256 checksums for release assets | Tag verification | `SHA256SUMS.txt` in the GitHub Release |
| Windows startup verification | Manual verification | `docs/STABILITY_VERIFICATION.md` evidence |
| Linux startup verification | Manual verification | `docs/STABILITY_VERIFICATION.md` evidence |
| macOS startup verification | Manual verification | `docs/STABILITY_VERIFICATION.md` evidence |
| Restart and queue recovery verification | Manual verification | `docs/STABILITY_VERIFICATION.md` evidence |
| Local data backup/restore verification | Manual verification | `docs/STABILITY_VERIFICATION.md` evidence |

## Documentation

- `README.md`
- `README.zh-CN.md`
- `docs/QUICKSTART.md`
- `docs/QUICKSTART.zh-CN.md`
- `docs/ARCHITECTURE.md`
- `docs/RELEASE_DECISIONS.md`
- `docs/DATA_DIRECTORY.md`
- `docs/STABILITY_VERIFICATION.md`
- `docs/TERMINOLOGY_AND_ROUTING.md`
- `docs/RELEASE_CHECKLIST.md`
- `docs/OPEN_SOURCE_READINESS.md`
- `SECURITY.md`
- `CODE_OF_CONDUCT.md`
- `CONTRIBUTING.md`
