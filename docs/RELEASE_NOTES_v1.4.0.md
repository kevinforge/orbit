# Orbit v1.4.0 Release Notes

Status: stable release. This release adds a read-only local file preview panel,
tightens bare POSIX path detection, hardens history retention against invalid
retention windows, and upgrades dependencies flagged by the security audit.

Orbit is a local-first workspace for coordinating CLI-backed digital employees
across isolated workspaces and conversations.

## Release Summary

This release focuses on:

- A read-only side panel that previews local files referenced from messages
  without leaving the conversation.
- Syntax highlighting, line numbers, and a resizable panel for text and code
  previews.
- Stricter bare POSIX path detection so slash-separated word groups stay plain
  text.
- History retention that falls back to the configured default window instead of
  deleting shards inside the intended window.
- Security upgrades for `fast-uri`, `hono`, `qs`, and the website toolchain.

## Install

### Public npm

Install the stable package from the owned npm scope:

```bash
npm install -g @kevinforge/orbit@1.4.0
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
npm install -g .\orbit-1.4.0-windows-x64.tgz
```

On Linux or macOS, use the matching `.tgz` artifact name:

```bash
npm install -g ./orbit-1.4.0-<platform>.tgz
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

## What Changed Since 1.3.0

### Local file preview

- Clicking a local file path in a message opens a read-only panel on the right of
  the shell instead of handing the file to the system file manager.
- Text and code render with `highlight.js` syntax coloring and a sticky
  line-number gutter; Markdown reuses the conversation renderer, and images and
  PDFs display inline.
- The panel can be resized by dragging its left edge (300-760px, capped by the
  viewport) and remembers the chosen width. `Esc` or the close button dismisses
  it, and clicking another file replaces its content.
- A folder button in the panel header locates the file in the file manager, and
  directory path entries keep opening there directly.
- The two preview endpoints reuse the reveal flow's path resolution: `~`
  expansion, `:line`/`:line:col` stripping, `fs.realpath`, and the workspace
  boundary check. Raw bytes are served only for images and PDFs, capped at 32 MB,
  with an extension-derived `Content-Type`, `X-Content-Type-Options: nosniff`, and
  `Cache-Control: no-store`.
- Preview requests are authorized against the active workspace only, so a
  conversation cannot read files that belong to another workspace. SVG is not
  served as raw image content and previews as XML text instead.
- Large text previews degrade to plain text without syntax highlighting or line
  numbers, keeping the panel responsive on multi-hundred-kilobyte files.
- On narrow viewports the panel becomes a fixed overlay rather than a grid column.

### Local server access

- The server now binds IPv4 loopback only, so the unauthenticated local API is
  not reachable from other machines on the network.
- Requests whose `Host` header is not a loopback address are rejected, which
  closes the DNS-rebinding path that binding alone leaves open.

### Bare POSIX path detection

- A bare POSIX path now requires a strong shape: a final segment with an
  extension, a known extensionless filename, a known root directory as the first
  segment, a drive-letter segment, or a trailing directory slash.
- Slash-separated word groups such as `工具栏/翻页/搜索`, `http/https/mailto/tel`,
  `.docx/.doc/.xlsx`, and `加载/错误/404/截断各状态` stay plain text.
- Explicit `[x](/path)` links and `file:///` hrefs are unaffected, as are Windows
  drive paths and `~/` entries.

### Retention and dependencies

- History retention now validates its retention window. A value that is not a
  non-negative integer falls back to the configured default instead of producing
  a `NaN` cutoff, which previously deleted shards that were still inside the
  intended window.
- Upgraded `fast-uri` to 3.1.7, `hono` to 4.13.7, and `qs` to 6.16.0.
- Upgraded the website toolchain to `@cloudflare/vite-plugin` 1.54.8, `wrangler`
  4.131.1, and `@cloudflare/workers-types` 5.20260914.1 so `npm ci` resolves and
  the website dependency audit is clean.

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
- Text previews are capped at the first 1 MB and show a truncation notice beyond
  that. Non-UTF-8 text is tolerated through replacement characters rather than
  detected and re-decoded.
- Text previews larger than roughly 200 KB render as plain text: syntax
  highlighting and the line-number gutter are dropped to keep the interface
  responsive.
- SVG previews as XML text and is never served as raw bytes, so script-capable
  markup can never execute in Orbit's own origin. PDFs larger than 32 MB are
  refused by the raw endpoint, so the inline viewer shows the refusal. There is no
  Office, audio, video, archive, or CSV preview, and HTML is never rendered inline.
- The local API is reachable from the same machine only and rejects non-loopback
  `Host` headers. Orbit is not intended to be exposed to other devices, and the
  API has no authentication.
- An extensionless POSIX directory string outside the known roots (for example
  `/项目/资料`) is no longer auto-recognized and needs an explicit link.
- Native slash commands depend on the runtime's ACP announcements. Probed command
  snapshots are in-memory and are discovered again after a server restart.
- CodeBuddy does not emit a distinct final-answer signal for task-driven turns,
  so final settlement still relies on its ACP stop reason.
- Private license enforcement remains only as an explicit opt-in via
  `ORBIT_REQUIRE_LICENSE=true`; the default public build remains unblocked.
- Platform binary and restart-recovery evidence is produced by the GitHub Actions
  release workflow and should be checked on the published release.

## Verification Evidence

| Check | Status | Evidence |
| --- | --- | --- |
| `npm run release:check:strict` | Passed locally | Release metadata and governance references passed for v1.4.0 |
| `npm run test` | Passed locally | Full repository test suite |
| `npm run build` | Passed locally | TypeScript, Vite UI, and standalone binary build |
| `npm audit --audit-level=moderate` | Passed locally | Dependency audit reported no moderate-or-higher vulnerabilities |
| `npm audit --audit-level=moderate` (`website/`) | Passed locally | Website dependency audit reported no vulnerabilities |
| `npm ci` (`website/`) | Passed locally | Lockfile resolves under the upgraded Cloudflare toolchain |
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
