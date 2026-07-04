# Orbit 1.0 Release Decisions

Status: draft recommendations. Confirm or revise these before publishing
`v1.0.0-rc.1`, then record the final decisions in the release notes.

This document keeps the remaining release decisions explicit so 1.0 is not
blocked by unclear publishing, licensing, platform, or runtime expectations.

## Decision Summary

| Area | Recommendation for `v1.0.0-rc.1` | Final 1.0 requirement |
| --- | --- | --- |
| License | Keep MIT | Confirm MIT or replace it consistently |
| Distribution | GitHub Releases only | Choose GitHub Releases only, a renamed npm package, or both |
| npm package name | Do not publish `orbit` | Pick an owned package name before public npm |
| Private license gate | Keep only as opt-in for RC | Move private enforcement out or prove public default remains unblocked |
| Supported OS | Treat workflow targets as RC test targets | Support only platforms with release and manual evidence |
| Runtime CLIs | Require at least one installed and authenticated CLI | Document required vs optional runtime policy |

## License

Recommendation: keep MIT for `v1.0.0-rc.1`.

Why:

- `package.json` already declares `MIT`.
- The top-level `LICENSE` file is present.
- `docs/DEPENDENCY_LICENSES.md` lists the reviewed dependency license baseline.
- MIT is simple for external contributors and aligns with the current package
  metadata.

Before final 1.0:

- Confirm the project should remain MIT.
- If the license changes, update `LICENSE`, `package.json`, README references,
  release notes, and package manifest tests in the same change.

## Distribution Channel

Recommendation: publish `v1.0.0-rc.1` through GitHub Releases only.

Why:

- The release workflow already builds platform-specific package artifacts and
  GitHub Release assets.
- GitHub Releases can carry platform artifacts, checksums, and manual evidence
  without claiming npm package ownership.
- Public npm can be added later after the package-name decision is resolved.

Before final 1.0, choose one:

- GitHub Releases only.
- GitHub Releases plus public npm under an owned package name.
- Public npm only, if platform artifact distribution is intentionally dropped.

## npm Package Name

Recommendation: do not publish the current package as public `orbit`.

Current evidence:

- On 2026-07-04, `npm view orbit name version description --json` returned an
  existing unrelated `orbit` package at version `2.6.0`.
- README and quickstart docs already warn users not to run
  `npm install -g orbit` unless this project announces npm ownership.

If public npm is required, choose an owned package name before publishing. A
scoped package such as `@qianzhensun/orbit` or an organization-owned scope keeps
the CLI command as `orbit` while avoiding the occupied package name.

Required repository changes before public npm:

- Change `package.json.name` to the owned package name.
- Keep `bin.orbit` if the command should still be `orbit`.
- Update README, quickstarts, release notes, release checklist, package tests,
  and release workflow references.
- Run `npm view <package-name>` and record the result before publishing.

## Private Licensed Build Support

Recommendation for `v1.0.0-rc.1`: keep the legacy license path only as an
explicit opt-in with `ORBIT_REQUIRE_LICENSE=true`.

Why:

- The default standalone startup path no longer requires `license.json`.
- `tests/standalone-entry.test.ts` guards the no-license default path.
- Keeping the opt-in path during RC avoids mixing a private packaging migration
  with the first public release candidate.

Final 1.0 decision:

- Move commercial/private enforcement to a private packaging layer if it is not
  part of the open source product.
- If it remains in this repository, keep it behind an explicit opt-in and keep
  tests proving fresh public startup does not require private files.

## Supported Operating Systems

Recommendation for `v1.0.0-rc.1`: treat these as release-candidate test
targets, not final support claims until evidence is attached:

- Windows x64
- Linux x64
- macOS x64
- macOS ARM64

Final 1.0 requirement:

- Every supported platform must have a passing release workflow artifact.
- Every supported platform must have manual evidence from
  `docs/STABILITY_VERIFICATION.md`.
- Platforms without evidence should be listed as unverified, not supported.

## Runtime CLI Policy

Recommendation: require at least one supported runtime CLI to be installed and
authenticated. Do not require all three runtimes for first run.

Why:

- Orbit supports Claude Code, Codex, and CodeBuddy runtime adapters.
- Quickstart docs already say users only need at least one runtime to start.
- The multi-agent collaboration preset assigns enabled defaults to an available
  runtime when possible.

Recommended public wording:

- Required: Node.js 20 or newer and at least one working runtime CLI.
- Optional runtime CLIs: Claude Code, Codex, and CodeBuddy.
- Users can install missing runtime CLIs later from Orbit's UI prompts.
- A digital employee cannot run until its selected runtime CLI is installed and
  authenticated.

Final 1.0 requirement:

- Keep README, quickstarts, release notes, and UI runtime prompts aligned on the
  same policy.
- If a specific runtime becomes mandatory, explain which default template needs
  it and add verification for missing-runtime behavior.
