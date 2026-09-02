# Orbit v1.3.0 Release Notes

Status: stable release. This release adds conversation file attachments,
ACP-native slash commands, per-conversation supervisor configuration, and a
dedicated Orbit product website.

Orbit is a local-first workspace for coordinating CLI-backed digital employees
across isolated workspaces and conversations.

## Release Summary

This release focuses on:

- File attachments that stay with the conversation and reach ACP runtimes as
  native images or local resource links.
- Native slash-command discovery, filtering, keyboard navigation, and delivery
  for Claude Code, Codex, and CodeBuddy when commands are announced over ACP.
- Conversation-isolated runtime state and configurable supervisor runtime/model
  preferences.
- Safer attachment retention, downloads, filename recovery, and async UI state
  landing.
- CodeBuddy task snapshots projected into Orbit's existing plan board.
- A dedicated product landing page deployed through GitHub Pages.

## Install

### Public npm

Install the stable package from the owned npm scope:

```bash
npm install -g @kevinforge/orbit@1.3.0
```

After installation, start Orbit:

```bash
orbit
```

Then open `http://localhost:4317`.

Do not run `npm install -g orbit` for this project. The public `orbit` package
name is occupied by an unrelated package. The scoped package keeps the CLI
command as `orbit`.

### GitHub Release Artifacts

Download the package that matches your operating system from the GitHub Release,
then install it with npm:

```powershell
npm install -g .\orbit-1.3.0-windows-x64.tgz
```

On Linux or macOS, use the matching `.tgz` artifact name:

```bash
npm install -g ./orbit-1.3.0-<platform>.tgz
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

## What Changed Since 1.2.0

### Conversation attachments

- The composer accepts images, PDFs, text, Markdown, and common source/config
  files, including messages that contain only attachments.
- Image-capable runtimes receive native image content. Other attachments are
  delivered as ACP `resource_link` blocks pointing to the local stored file.
- Messages retain display names and expose guarded preview/download endpoints.
- Draft uploads are bounded and expire automatically. History retention reclaims
  unreferenced permanent files while leaving active conversations untouched.

### Native commands and plans

- Typing `/` opens the selected employee's ACP-announced command list in direct
  mode; an explicit employee marker targets that employee in every mode.
- The menu supports name/description search, large scrollable lists, PgUp/PgDn,
  Enter/Tab completion, Esc dismissal, status feedback, and retry after probe
  failures.
- Cold-start probes populate the same authoritative command snapshot used by
  send-time routing. Runtime announcements win races against stale HTTP probe
  results.
- The server derives native-command delivery from message content, keeping the
  durable channel history and executed command aligned.
- CodeBuddy `Task` updates are mapped into the shared plan board instead of
  appearing as unrelated process text.

### Conversation and interaction reliability

- Runtime state, model snapshots, supervisor configuration, pending probes, and
  async UI landings are scoped to the active conversation.
- Each conversation can choose the supervisor runtime and model; changing the
  runtime rebuilds only the supervisor session for that conversation.
- Mention completion correctly handles Enter before the send path, while
  Shift+Enter, Esc re-opening, and IME composition keep their intended behavior.
- Reply text without a runtime final-answer mark stays in the process timeline
  until settlement, preventing a flash between the process and final body.

### Product website

- Added a dedicated Orbit landing page with responsive product content and an
  optimized collaboration demo.
- Added a GitHub Pages deployment workflow and refreshed the website dependency
  set used by React, Vite, Vinext, Cloudflare, and React Server Components
  tooling.
- Upgraded Vinext to remove the vulnerable `image-size` transitive dependency
  reported by Dependabot.

## Security And Governance

- License: MIT.
- Security reports: see `SECURITY.md`.
- Community standards: see `CODE_OF_CONDUCT.md`.
- Contribution workflow: see `CONTRIBUTING.md`.
- Dependency license baseline: see `docs/DEPENDENCY_LICENSES.md`.

## Known Limitations

- Users need at least one installed and authenticated runtime CLI before a
  digital employee can run.
- File attachments are local-first resources intended for runtimes on the same
  machine. Each file is limited to 5 MB; one message supports at most five files
  and 20 MB combined. Executables, scripts, and archives are rejected.
- Native slash commands depend on the runtime's ACP announcements. Probed command
  snapshots are in-memory and are discovered again after a server restart.
- CodeBuddy does not emit a distinct final-answer signal for task-driven turns,
  so final settlement still relies on its ACP stop reason.
- Private license enforcement remains only as an explicit opt-in via
  `ORBIT_REQUIRE_LICENSE=true`; the default public build remains unblocked.
- Platform binary and restart-recovery evidence is produced by the GitHub
  Actions release workflow and should be checked on the published release.

## Verification Evidence

| Check | Status | Evidence |
| --- | --- | --- |
| `npm run release:check:strict` | Passed locally | Release metadata and governance references passed for v1.3.0 |
| `npm run test` | Passed locally | Full repository test suite |
| `npm run build` | Passed locally | TypeScript, Vite UI, and standalone binary build |
| `npm audit --audit-level=moderate` | Passed locally | Dependency audit reported no moderate-or-higher vulnerabilities |
| `npm audit --audit-level=moderate` (`website/`) | Passed locally | Website dependency audit reported no vulnerabilities |
| `npm run build` (`website/`) | Passed locally | Vinext production website build |
| `npm run smoke:start` | Passed locally | Built standalone server startup and state endpoint |
| `npm run smoke:port-conflict` | Passed locally | Occupied-port startup behavior |
| `npm pack --dry-run --json` | Passed locally | Package payload inspected against the release allowlist |
| `npm publish --dry-run --access public --ignore-scripts` | Passed locally | Final registry payload validation |
| Four-platform packages and checksums | Release workflow | Native GitHub-hosted runners after tag push |
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
