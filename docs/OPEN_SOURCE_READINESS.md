# Orbit 1.0 Open Source Readiness

This document tracks the work required before Orbit 1.0 can be published as an
open source project. It is intentionally durable project documentation, not a
temporary planning note.

## Goal

Orbit 1.0 should be safe and useful for external users to clone, install, run,
test, package, and contribute to without private repository access or manual
administrator steps.

## Current Baseline

- Version: `0.9.5`.
- Verification: `npm run test` and `npm run build` pass locally.
- Security baseline: `npm audit --audit-level=moderate` passes after refreshing
  the lockfile.
- Startup baseline: the default standalone build starts without `license.json`;
  private licensed builds must opt in with `ORBIT_REQUIRE_LICENSE=true`.
- Smoke-test baseline: CI and release builds run `scripts/smoke-start.mjs`,
  which starts the built app and waits for `GET /api/state`, plus
  `scripts/smoke-port-conflict.mjs`, which verifies an occupied explicit port
  fails with a recoverable startup message.
- Core product state: local-first workspace app with React UI, local HTTP/SSE
  server, workspace and conversation persistence, configurable digital
  employees, CLI runtime adapters for Claude Code, Codex, and CodeBuddy, run
  queues, cancellation, handoffs, and collaboration insights.
- Release state: CI runs tests and build on pull requests; release workflow
  builds platform-specific npm installation packages and GitHub Release assets.
- Governance baseline: MIT `LICENSE`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, and
  `SUPPORT.md`, and public package metadata are present.
- Dependency-license baseline: `docs/DEPENDENCY_LICENSES.md` records the
  current reviewed license identifiers and tests guard against unexpected
  additions.
- Contributor baseline: `CONTRIBUTING.md`, the pull request template, and
  `docs/RELEASE_CHECKLIST.md` document public contribution and release
  verification expectations.
- Issue intake baseline: GitHub issue templates collect bug reports, feature
  requests, runtime/platform details, and local data impact while sending
  security reports to `SECURITY.md`; `SUPPORT.md` documents the public support
  channels and release-candidate support scope.
- Release-notes baseline: `docs/RELEASE_NOTES_v1.0.0-rc.1.md` provides the
  auditable draft for the first 1.0 release candidate.
- Release-decisions baseline: `docs/RELEASE_DECISIONS.md` captures the confirmed
  MIT and public npm direction, plus remaining decisions for npm naming,
  cross-platform registry packaging, private licensed builds, supported
  operating systems, and runtime CLI requirements.
- Stability-verification baseline: `docs/STABILITY_VERIFICATION.md` turns
  restart recovery, queue cancellation, local data safety, background work, and
  Collaboration Insights checks into repeatable release evidence.
- Local-data baseline: `docs/DATA_DIRECTORY.md` documents `~/.orbit` layout,
  backup, restore, reset, and workspace/conversation deletion scope.
- Terminology baseline: `docs/TERMINOLOGY_AND_ROUTING.md` documents public
  product terms, digital employee language, and `@developer:` routing markers.

## Release Gates

All gates below must be closed before tagging `v1.0.0`.

### 1. Open Source Legal And Governance

- Keep the top-level `LICENSE` file aligned with `package.json`.
- Keep `SECURITY.md` current with supported versions and vulnerability
  reporting policy.
- Keep `CODE_OF_CONDUCT.md` available for public collaboration.
- Keep `SUPPORT.md` current with issue, security, and release-candidate support
  expectations.
- Keep `docs/DEPENDENCY_LICENSES.md` aligned with `package-lock.json`; review
  any newly introduced dependency license identifiers before release.
- Remove private-release wording from public-facing docs and workflows.

### 2. No Private Startup Blockers

- Keep the default open source build free of a mandatory `license.json` startup
  gate.
- Keep `orbit --machine-id` out of first-run instructions; it is only for
  private licensed builds.
- Keep any commercial/private licensing path behind an explicit build or
  packaging switch, not in the default open source startup path.
- Ensure a fresh clone can run `npm ci`, `npm run dev`, `npm run test`, and
  `npm run build` without private files.

### 3. Stability And Recovery

- Keep `npm run test`, `npm run build`, and `npm audit --audit-level=moderate`
  green before release.
- Keep the built-app `/api/state` and occupied-port smoke tests running in CI
  and release builds.
- Validate port recovery on Windows, macOS, and Linux.
- Validate restart recovery: running and queued tasks must not remain stuck
  after a crash or process kill.
- Validate data safety for `~/.orbit`: messages, sessions, workspace config,
  agent config, attachments, and transcripts must survive ordinary restarts.
- Confirm queue cancellation always starts the next eligible queued task.
- Record release evidence using `docs/STABILITY_VERIFICATION.md`.

### 4. Contributor Experience

- Update `README.md` and `README.zh-CN.md` for public setup, development,
  testing, packaging, and runtime prerequisites.
- Keep `CONTRIBUTING.md` aligned with the public workflow.
- Expand PR template enough for external contributors: change summary,
  verification, screenshots when UI changes, and known risks.
- Keep public issue templates available for reproducible bugs and feature
  requests, with security reports routed out of public issues.
- Document how to run a single test file.
- Document supported Node, npm, Bun, and OS versions.

### 5. Release And Distribution

- Rename release workflow language from private release to public release.
- Publish 1.0 through GitHub Releases and public npm.
- Before publishing to npm, confirm package name ownership and metadata:
  repository, homepage, bugs, keywords, license, and files.
- Choose a cross-platform registry package strategy before adding `npm publish`
  to the release workflow.
- Keep package contents restricted to launcher, built UI, built binary, install
  script, README files, and package metadata.
- Generate checksums for all release assets.
- Document installation from source and from release artifacts.

### 6. Documentation Accuracy

- Align architecture docs with current runtime support: Claude Code, Codex, and
  CodeBuddy.
- Remove stale statements that imply only Claude Code agents are supported.
- Keep administrator/license setup out of public quickstarts.
- Keep local data layout, backup, restore, and reset guidance current in
  `docs/DATA_DIRECTORY.md`.
- Keep public product terms and routing marker rules current in
  `docs/TERMINOLOGY_AND_ROUTING.md`.

## Recommended Milestones

### Milestone A: Public Repo Hygiene

Target outcome: the repository can be made public without obvious legal,
security, or private-infrastructure surprises.

- Keep `LICENSE`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, and package metadata in
  place.
- Keep dependency license review current.
- Remove private release wording.
- Ensure no local artifacts, credentials, generated packages, or user data are
  tracked.
- Keep `npm audit --audit-level=moderate` clean.

### Milestone B: Open Source First Run

Target outcome: a new contributor can clone and run Orbit without asking the
maintainer for a license file.

- Preserve the default no-license startup path.
- Keep quickstarts and README files aligned with public setup.
- Keep local, CI, and release startup smoke checks green.
- Verify dev and standalone startup on Windows first, then macOS and Linux.

### Milestone C: Stability Hardening

Target outcome: ordinary failures leave clear, recoverable state.

- Add focused tests around startup recovery, interrupted queues, and persistent
  data safety where gaps remain.
- Keep the manual release checklist current for crash/restart, cancel,
  background conversation work, attachment handling, and collaboration insights.
- Keep `docs/STABILITY_VERIFICATION.md` aligned with the current recovery and
  data persistence behavior.
- Review terminal transcript retention and message shard recovery for
  user-data loss risks.

### Milestone D: 1.0 Release Candidate

Target outcome: `v1.0.0-rc.1` can be tested by external users.

- Freeze public API and data layout expectations for 1.0.
- Build release artifacts for all supported platforms.
- Resolve the `docs/RELEASE_NOTES_v1.0.0-rc.1.md` draft placeholders and
  publish release notes with known limitations.
- Gather external installation and first-run feedback.

## Known Decisions Needed

Use `docs/RELEASE_DECISIONS.md` as the current recommendation brief.

- MIT is the confirmed project license for `v1.0.0-rc.1`.
- Which owned npm package name and cross-platform registry packaging strategy
  should public 1.0 use?
- Should the commercial/private license gate remain in this repository behind a
  flag, or move to a private packaging layer?
- Which operating systems are officially supported for 1.0?
- Which CLI runtimes are required for the default template, and which are
  optional?

## Immediate Next Changes

1. Verify dev and standalone startup on Windows, macOS, and Linux.
2. Confirm the owned npm package name and registry packaging strategy.
3. Configure npm publishing credentials and add the release workflow publish
   step after the package strategy is implemented.
4. Resolve `docs/RELEASE_NOTES_v1.0.0-rc.1.md` placeholders and attach final
   release evidence.
