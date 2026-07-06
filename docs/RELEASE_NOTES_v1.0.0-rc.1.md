# Orbit v1.0.0-rc.1 Release Notes

Status: release candidate. Publish these notes only for `v1.0.0-rc.1`; keep
final `v1.0.0` notes separate after release-candidate feedback is reviewed.

Orbit 1.0 is the first planned open source release line for the local-first
digital employee workspace. This release candidate is intended for external
users who want to clone, build, run, inspect, and contribute to Orbit without
private repository access or manual administrator steps.

## Release Summary

This candidate focuses on:

- Public setup from source, GitHub Release artifacts, and public npm.
- Distribution through GitHub Releases and public npm.
- Default startup without a required `license.json`.
- Local persistence under `~/.orbit`.
- CLI-backed digital employees using Claude Code, Codex, or CodeBuddy.
- Explicit `@developer:` style assignment markers, handoffs, and run queues.
- Release smoke checks for the built local server.
- Public governance files and contribution guidance.

## Install

### Public npm

Install the release-candidate package from the owned npm scope:

```bash
npm install -g @kevinforge/orbit@1.0.0-rc.1
```

After installation, start Orbit:

```bash
orbit
```

Then open `http://localhost:4317`.

Do not run `npm install -g orbit` for this project. The public `orbit` package
name is already occupied by an unrelated package. The scoped package keeps the
CLI command as `orbit`.

The package name is already occupied, so Orbit publishes under
`@kevinforge/orbit`.

### GitHub Release Artifacts

Download the package that matches your operating system from the GitHub Release,
then install it with npm:

```powershell
npm install -g .\orbit-1.0.0-rc.1-windows-x64.tgz
```

On Linux or macOS, use the matching `.tgz` artifact name:

```bash
npm install -g ./orbit-1.0.0-rc.1-<platform>.tgz
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

The release-candidate packaging workflow targets:

- Windows x64
- Linux x64
- macOS x64
- macOS ARM64

For final 1.0 support claims, each platform must have release workflow evidence
and manual startup evidence from `docs/STABILITY_VERIFICATION.md`.

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

## What Changed Since 0.9.x

- Open source governance files are present: `LICENSE`, `SECURITY.md`,
  `CODE_OF_CONDUCT.md`, and `CONTRIBUTING.md`.
- Package metadata is aligned for a public repository, including license,
  repository, homepage, bugs, keywords, and a restricted package file list.
- The npm package name is `@kevinforge/orbit`, with the installed command kept
  as `orbit`.
- Default standalone startup no longer requires `license.json`; private licensed
  builds must opt in with `ORBIT_REQUIRE_LICENSE=true`.
- CI and release packaging run the built-app startup smoke check against
  `GET /api/state`.
- Local data layout, backup, restore, and reset guidance is documented in
  `docs/DATA_DIRECTORY.md`.
- Public product terms and `@developer:` assignment marker behavior are
  documented in `docs/TERMINOLOGY_AND_ROUTING.md`.
- 1.0 release verification gates are tracked in `docs/RELEASE_CHECKLIST.md` and
  `docs/OPEN_SOURCE_READINESS.md`.

## Security And Governance

- License: MIT.
- Security reports: see `SECURITY.md`.
- Community standards: see `CODE_OF_CONDUCT.md`.
- Contribution workflow: see `CONTRIBUTING.md`.
- Dependency license baseline: see `docs/DEPENDENCY_LICENSES.md`.

## Known Limitations

- This is a release candidate, not the final 1.0 stable release.
- Final platform support depends on completed evidence for Windows x64, Linux
  x64, macOS x64, and macOS ARM64.
- Private license enforcement remains only as an explicit opt-in via
  `ORBIT_REQUIRE_LICENSE=true`; the default public build must remain unblocked.
- Users need at least one installed and authenticated runtime CLI before a
  digital employee can run.
- Multi-page workspace and same-session concurrency hardening continues in
  issue #116.

## Verification Evidence

Use this section as the release audit trail. Local evidence is completed before
the release PR is marked ready; workflow evidence is completed by GitHub Actions
before publishing the tag.

| Check | Status | Evidence |
| --- | --- | --- |
| `npm run test` | Passed locally | 586 tests passed on Windows |
| `npm run build` | Passed locally | TypeScript, Vite, and Windows standalone build passed |
| `npm audit --audit-level=moderate` | Passed locally | 0 vulnerabilities |
| `npm run smoke:start` | Passed locally | `GET /api/state` returned 200 |
| `npm run smoke:port-conflict` | Passed locally | Occupied port produced a clear startup failure |
| `npm pack --dry-run --json` | Passed locally | Windows package payload validated from local build |
| `npm publish --dry-run --access public --ignore-scripts` | Passed locally | npm accepted public scoped-package dry-run |
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
- `docs/QUICKSTART.md`
- `docs/RELEASE_DECISIONS.md`
- `docs/DATA_DIRECTORY.md`
- `docs/STABILITY_VERIFICATION.md`
- `docs/TERMINOLOGY_AND_ROUTING.md`
- `docs/RELEASE_CHECKLIST.md`
- `docs/OPEN_SOURCE_READINESS.md`
- `SECURITY.md`
- `CODE_OF_CONDUCT.md`
- `CONTRIBUTING.md`
