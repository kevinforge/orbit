# Orbit v1.0.0 Release Notes

Status: stable release. This is the first public open source 1.0 release of
Orbit.

Orbit is a local-first workspace for coordinating CLI-backed digital employees
across isolated workspaces and conversations. The 1.0 release makes Orbit
publicly installable, auditable, and contribution-ready under the MIT license.

## Release Summary

This release focuses on:

- Public setup from source, GitHub Release artifacts, and public npm.
- Distribution through GitHub Releases and public npm.
- Default startup without a required `license.json`.
- Local persistence under `~/.orbit`.
- CLI-backed digital employees using Claude Code, Codex, or CodeBuddy.
- Explicit `@developer:` style assignment markers, handoffs, and run queues.
- Recovery after a digital employee runtime fails with an upstream service
  error.
- Clearer user-facing messaging when Claude Code reports `529 overloaded`.
- Release smoke checks for the built local server.
- Public governance files and contribution guidance.

## Install

### Public npm

Install the stable package from the owned npm scope:

```bash
npm install -g @kevinforge/orbit@1.0.0
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
npm install -g .\orbit-1.0.0-windows-x64.tgz
```

On Linux or macOS, use the matching `.tgz` artifact name:

```bash
npm install -g ./orbit-1.0.0-<platform>.tgz
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
- A digital employee in `error` state can be retried by sending a normal
  unassigned message to the same conversation. A fully stopped employee still
  requires explicit assignment.
- Claude Code `529 overloaded` failures are summarized as an upstream model
  service busy condition instead of repeating the raw overloaded error text.
- 1.0 release verification gates are tracked in `docs/RELEASE_CHECKLIST.md` and
  `docs/OPEN_SOURCE_READINESS.md`.

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
| `npm run release:check:strict` | Passed locally | Release metadata and governance references passed |
| `npm run test` | Passed locally | Full repository test suite passed on Windows |
| `npm run build` | Passed locally | TypeScript, Vite, and Windows standalone build passed |
| `node --test --import tsx tests/release-workflow.test.ts` | Passed locally | Release workflow checks passed for the current package version |
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
