# Orbit v1.0.0-rc.1 Release Notes Draft

Status: draft. Do not publish these notes until every `TBD before release`
item is resolved and the release evidence is attached.

Use this file as the auditable release-notes source for the first 1.0 release
candidate. The release workflow uses `docs/RELEASE_NOTES_<tag>.md` when a
matching file exists, so tag `v1.0.0-rc.1` will publish this file as the GitHub
Release body after all draft placeholders are resolved.

## Release Summary

Orbit 1.0 is the first planned open source release candidate for the local-first
digital employee workspace. It is intended for external users who want to clone,
build, run, inspect, and contribute to Orbit without private repository access or
manual administrator steps.

This release candidate focuses on:

- Public setup from source and release artifacts.
- Default startup without a required `license.json`.
- Local persistence under `~/.orbit`.
- CLI-backed digital employees using Claude Code, Codex, or CodeBuddy.
- Explicit `@developer:` style assignment markers, handoffs, and run queues.
- Release smoke checks for the built local server.
- Public governance files and contribution guidance.

## Install

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

After installation, start Orbit:

```bash
orbit
```

Then open `http://localhost:4317`.

### Source Checkout

```bash
git clone https://github.com/kevinforge/orbit.git
cd orbit
npm ci
npm run build
npm run dev
```

### Public npm

Draft decision: publish `v1.0.0-rc.1` through GitHub Releases and public npm.
The public `orbit` package name is already occupied by an unrelated package, so
the registry package uses the owned scoped name `@kevinforge/orbit`. The npm
package includes binaries for Windows x64, Linux x64, macOS x64, and macOS
ARM64, and the `orbit` command selects the matching binary at install time. Do
not run `npm install -g orbit` against the public registry.

TBD before release: replace this section with the final install command and
`npm publish --dry-run` evidence.

## Supported Platforms

TBD before release: confirm the official 1.0 support matrix after
cross-platform startup verification.

Release workflow targets currently include:

- Windows x64
- Linux x64
- macOS x64
- macOS ARM64

Each final supported platform must have release evidence for package
installation, startup, `GET /api/state`, port override, and clear failed-startup
behavior.

## Runtime Prerequisites

Orbit coordinates local CLI-backed digital employees. Install at least one
runtime CLI before assigning work to employees:

| Runtime | Install |
| --- | --- |
| Claude Code | `npm install -g @anthropic-ai/claude-code` |
| Codex | `npm install -g @openai/codex` |
| CodeBuddy | `npm install -g @tencent-ai/codebuddy-code` |

Draft recommendation: require at least one supported runtime CLI to be installed
and authenticated. Claude Code, Codex, and CodeBuddy are optional choices; a
digital employee cannot run until its selected runtime CLI is available.

## What Changed Since 0.9.x

- Open source governance files are present: `LICENSE`, `SECURITY.md`,
  `CODE_OF_CONDUCT.md`, and `CONTRIBUTING.md`.
- Package metadata is aligned for a public repository, including license,
  repository, homepage, bugs, keywords, and a restricted package file list.
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

TBD before release: replace this section with the final known limitations for
external testers.

Track at least these unresolved release decisions:

- Public npm install command.
- Whether optional private licensed build support remains in this repository or
  moves to a private packaging layer.
- Official supported operating systems for 1.0.
- Required versus optional runtime CLIs for the default templates.
- Cross-platform evidence for crash/restart recovery, queued task recovery,
  cancellation, and local data safety.

## Verification Evidence

Attach the final evidence in the release PR or GitHub Release before publishing
the candidate:

- [ ] `npm run test`
- [ ] `npm run build`
- [ ] `npm audit --audit-level=moderate`
- [ ] `npm run smoke:start`
- [ ] `npm run smoke:port-conflict`
- [ ] `npm pack --dry-run --json`
- [ ] `npm publish --dry-run`
- [ ] npm package contains Windows x64, Linux x64, macOS x64, and macOS ARM64
      binaries
- [ ] GitHub Actions CI result
- [ ] Release workflow result for each platform package
- [ ] npm publish workflow result
- [ ] SHA256 checksums for release assets
- [ ] Windows startup verification
- [ ] Linux startup verification
- [ ] macOS startup verification
- [ ] Restart and queue recovery verification
- [ ] Local data backup/restore verification
- [ ] Platform evidence copied from `docs/STABILITY_VERIFICATION.md`

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
