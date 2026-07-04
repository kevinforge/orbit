# Orbit 1.0 Release Checklist

Use this checklist for `v1.0.0-rc.*` candidates and for the final `v1.0.0`
release. Keep evidence in the release PR or release notes so the release can be
audited later.

## Release Decisions

Use `docs/RELEASE_DECISIONS.md` as the decision brief before publishing a
release candidate.

- [ ] Confirm the project license is still MIT.
- [ ] Confirm the public distribution channel: GitHub Releases only, public npm,
  or both.
- [ ] If publishing to npm, confirm package name ownership before announcing
  `npm install -g orbit`.
- [ ] Decide whether optional private licensed build support remains in this
  repository or moves to a private packaging layer.
- [ ] Confirm supported operating systems for 1.0.
- [ ] Confirm which CLI runtimes are required for default templates and which
  are optional.

## Local Preflight

- [ ] Start from the intended release branch or tag commit on `main`.
- [ ] Confirm `package.json` version matches the planned release tag.
- [ ] Run `npm run release:check` while preparing the candidate, then run
  `npm run release:check:strict` after version, release notes, and evidence are
  final.
- [ ] Confirm `LICENSE`, `SECURITY.md`, `CODE_OF_CONDUCT.md`,
  `CONTRIBUTING.md`, and `docs/DEPENDENCY_LICENSES.md` are present.
- [ ] Run `npm run test`.
- [ ] Run `npm run build`.
- [ ] Run `npm audit --audit-level=moderate`.
- [ ] Run `npm run smoke:start`.
- [ ] Run `npm run smoke:port-conflict`.
- [ ] Run `npm pack --dry-run --json` and confirm the package contains only the
  launcher, built binary, built UI, install script, README files, license, and
  package metadata.

## Cross-Platform Startup

Verify on Windows, Linux, and macOS before the final 1.0 tag:

- [ ] Fresh clone: `npm ci`, `npm run build`, and `npm run dev` work without
  private files or `license.json`.
- [ ] Release package install: `npm install -g ./orbit-<version>-<platform>.tgz`
  works for the platform artifact.
- [ ] `orbit` starts the local server and `GET /api/state` returns 200.
- [ ] `ORBIT_PORT` can move the server to a non-default port.
- [ ] A failed startup, such as an occupied port, reports a clear error and does
  not corrupt local data.

## Stability And Recovery

Use `docs/STABILITY_VERIFICATION.md` to run these checks and capture evidence.

- [ ] Crash or kill the server during running and queued digital employee work,
  restart Orbit, and verify no task remains permanently stuck as running or
  queued.
- [ ] Cancel a queued task and verify the next eligible queued task starts.
- [ ] Cancel a running task and verify the UI shows a recoverable final state.
- [ ] Verify messages, sessions, workspace config, agent config, attachments,
  and terminal transcripts survive an ordinary restart.
- [ ] Verify Collaboration Insights still loads after restart and after a
  cancelled or failed task.
- [ ] Verify background conversations can continue running while another
  conversation is active.

## Release Workflow

- [ ] Run the GitHub Actions `Release` workflow manually before pushing the final
  tag.
- [ ] Confirm Windows x64, Linux x64, macOS x64, and macOS ARM64 package jobs
  pass.
- [ ] Confirm every platform package runs `scripts/smoke-start.mjs` against its
  native binary.
- [ ] Confirm packaged artifacts do not include source files, tests, source maps,
  local notes, credentials, or generated logs.
- [ ] Confirm `SHA256SUMS.txt` is generated for release assets.
- [ ] Push the final semantic version tag only after the release commit is on
  `main`.

## Release Notes

Use `docs/RELEASE_NOTES_v1.0.0-rc.1.md` as the release-notes draft for the
first 1.0 release candidate. The release workflow uses
`docs/RELEASE_NOTES_<tag>.md` when a matching file exists, and falls back to
generated GitHub release notes otherwise.

- [ ] Include installation from GitHub Release artifacts.
- [ ] State whether public npm installation is supported.
- [ ] List supported operating systems and required runtime CLIs.
- [ ] Call out known limitations and follow-up work.
- [ ] Link to `SECURITY.md`, `CODE_OF_CONDUCT.md`, and `CONTRIBUTING.md`.
