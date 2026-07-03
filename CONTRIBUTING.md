# Contributing

Thanks for helping make Orbit reliable. Orbit is a local-first app, so changes
should preserve user data, keep long-running digital employee work recoverable,
and stay easy for external contributors to verify.

Please also read the [Code of Conduct](./CODE_OF_CONDUCT.md) and the security
reporting policy in [SECURITY.md](./SECURITY.md).

## Requirements

- Node.js 20 or newer.
- npm from the active Node.js installation.
- Bun for standalone binary builds. The GitHub release workflow currently uses
  the latest Bun available from `oven-sh/setup-bun`.
- Windows, Linux, and macOS are release targets. Validate platform-specific
  behavior on the affected platform whenever a change touches startup,
  packaging, paths, process handling, or local file persistence.

## Development Flow

Agents must also follow [AGENTS.md](./AGENTS.md). That file is the operational checklist for automated issue, branch, PR, and CI workflows.

1. Start from `main`.
2. Create a feature branch:

```powershell
git checkout main
git pull
git checkout -b feature/short-description
```

3. Keep changes scoped to one feature or fix.
4. Add or update tests for behavior changes.
5. Run local verification:

```powershell
npm run test
npm run build
```

For changes that touch startup, packaging, dependency metadata, release
workflows, or public setup docs, also run:

```powershell
npm audit --audit-level=moderate
npm run smoke:start
npm pack --dry-run --json
```

Run a focused test while iterating:

```powershell
node --test --import tsx tests/mention-router.test.ts
```

6. Commit with a concise imperative message.
7. Push the branch and open a Pull Request.
8. Wait for the GitHub Actions CI check to pass before merging.

## Pull Request Checklist

- The change has a clear product or engineering reason.
- Tests cover the changed behavior where practical.
- `npm run test` passes.
- `npm run build` passes.
- `npm audit --audit-level=moderate` passes when dependencies or release
  readiness are touched.
- `npm run smoke:start` passes when startup, packaging, or release behavior is
  touched.
- README or architecture docs are updated when behavior or setup changes.
- UI changes include screenshots or a short note explaining why screenshots are
  not needed.
- Known risks, limitations, and follow-up work are called out in the PR body.
- Temporary research notes, screenshots, and competitor analysis are not committed.
- The GitHub Actions CI check passes.

## Documentation Policy

Keep repository documentation small:

- `README.md` for product overview, setup, and daily commands.
- `README.zh-CN.md` for the Simplified Chinese README.
- `docs/ARCHITECTURE.md` for current architecture.
- `docs/DATA_DIRECTORY.md` for local data layout, backup, restore, and reset
  guidance.
- `docs/DEPENDENCY_LICENSES.md` for dependency license review.
- `docs/RELEASE_CHECKLIST.md` for 1.0 release candidate and final release
  verification.
- `docs/QUICKSTART.md` and `docs/QUICKSTART.zh-CN.md` for first-run guidance.
- `docs/OPEN_SOURCE_READINESS.md` for 1.0 open source release gates.
- `CONTRIBUTING.md` for workflow and standards.
- `AGENTS.md` for the required agent workflow.

Temporary planning or research documents should stay outside the committed repository, or in a local ignored folder.

## Code Standards

- Prefer TypeScript types at module boundaries.
- Keep runtime adapters isolated from routing and UI code.
- Keep UI state derived from server state where possible.
- Avoid adding abstractions until they remove real duplication or isolate a clear boundary.
- Do not commit generated logs, screenshots, local credentials, or machine-specific config.
- Treat `~/.orbit` data loss, permanently stuck runs, and silent startup
  failures as release-blocking bugs.
