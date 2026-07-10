# Orbit 1.0 Release Decisions

Status: confirmed release decisions. The project owner confirmed MIT, the
`kevinforge` GitHub/npm identity, public npm publishing, npm Trusted Publishing,
and the all-platform-binaries npm package strategy. Initial 1.0 publishing used
a granular npm token; releases after 2026-07-10 should publish through GitHub
Actions OIDC trusted publishing instead of a long-lived `NPM_TOKEN` secret.

This document keeps the remaining release decisions explicit so 1.0 is not
blocked by unclear publishing, licensing, platform, or runtime expectations.

## Decision Summary

| Area | Recommendation for `v1.0.0-rc.1` | Final 1.0 requirement |
| --- | --- | --- |
| License | MIT confirmed | Keep MIT or replace it consistently in a dedicated change |
| Distribution | GitHub Releases plus public npm | Publish both platform release artifacts and a registry package |
| npm package name | Use `@kevinforge/orbit`, not `orbit` | Keep the package under an owned npm scope |
| npm publishing auth | Use npm Trusted Publishing from GitHub Actions | Keep release publishing tokenless with OIDC provenance |
| npm package layout | One package with all platform binaries | Verify package size and install behavior before every release |
| Private license gate | Keep only as opt-in for RC | Move private enforcement out or prove public default remains unblocked |
| Supported OS | Treat workflow targets as RC test targets | Support only platforms with release and manual evidence |
| Runtime CLIs | Require at least one installed and authenticated CLI | Document required vs optional runtime policy |

## License

Decision: keep MIT for `v1.0.0-rc.1`.

Why:

- `package.json` already declares `MIT`.
- The top-level `LICENSE` file is present.
- `docs/DEPENDENCY_LICENSES.md` lists the reviewed dependency license baseline.
- MIT is simple for external contributors and aligns with the current package
  metadata.

Before final 1.0:

- If the license changes, update `LICENSE`, `package.json`, README references,
  release notes, and package manifest tests in the same change.

## Distribution Channel

Decision: publish `v1.0.0-rc.1` through GitHub Releases and public npm.

Why:

- The release workflow already builds platform-specific package artifacts and
  GitHub Release assets.
- GitHub Releases should keep carrying platform artifacts, checksums, and
  manual evidence.
- Public npm should provide the normal `npm install -g <package>` path once an
  owned package name and registry package strategy are confirmed.

Before each public npm release, verify the npm publishing path:

- Keep npm Trusted Publishing configured for package `@kevinforge/orbit`,
  repository `kevinforge/orbit`, and workflow `.github/workflows/release.yml`.
- Keep the release workflow publishing job on GitHub-hosted runners with
  `id-token: write` permission.
- Build the registry package with all platform binaries under `dist/bin/`.
- Verify `npm publish --dry-run --access public --ignore-scripts --provenance`.
- Publish to npm only after release readiness, GitHub Release asset generation,
  and package validation pass.

## npm Publishing Authentication

Decision: publish through npm Trusted Publishing instead of a long-lived
repository `NPM_TOKEN`.

Why:

- npm is deprecating bypass-2FA token publishing for automation.
- Trusted Publishing lets GitHub Actions request a short-lived npm publishing
  credential through OIDC.
- The release workflow can publish with provenance while keeping the repository
  free of long-lived npm registry secrets.

Required npm package settings:

- Package: `@kevinforge/orbit`.
- Publisher provider: GitHub Actions.
- Repository: `kevinforge/orbit`.
- Workflow filename: `release.yml`.
- Environment: leave empty unless the release workflow later adds a GitHub
  Actions environment for npm publishing.

Required repository settings:

- The `publish-npm` job must include `permissions: id-token: write`.
- The npm publish step must not set `NODE_AUTH_TOKEN`.
- The release workflow should keep using GitHub-hosted runners for npm publish.

## npm Package Name

Decision: do not publish the current package as public `orbit`.

Current evidence:

- On 2026-07-04, `npm view orbit name version description --json` returned an
  existing unrelated `orbit` package at version `2.6.0`.
- On 2026-07-06, `npm view @kevinforge/orbit name version description --json`
  returned `E404`, so that scoped package name was not published at the time of
  checking.
- README and quickstart docs already warn users not to run
  `npm install -g orbit` unless this project announces npm ownership.

Use `@kevinforge/orbit` before publishing. The scoped package keeps the CLI
command as `orbit` while avoiding the occupied package name.

Required repository changes before public npm:

- Keep `package.json.name` set to `@kevinforge/orbit`.
- Keep `bin.orbit` if the command should still be `orbit`.
- Configure `publishConfig.access` for the scoped public package if needed.
- Update README, quickstarts, release notes, release checklist, package tests,
  and release workflow references.
- Run `npm view <package-name>` and record the result before publishing.
- Run `npm publish --dry-run --access public --ignore-scripts --provenance`
  against the final package contents before tagging.

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
