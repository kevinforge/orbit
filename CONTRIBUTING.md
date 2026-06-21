# Contributing

Orbit is currently private, but the repository should stay close to an open-source-ready workflow.

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

6. Commit with a concise imperative message.
7. Push the branch and open a Pull Request.
8. Wait for the GitHub Actions CI check to pass before merging.

## Pull Request Checklist

- The change has a clear product or engineering reason.
- Tests cover the changed behavior where practical.
- `npm run test` passes.
- `npm run build` passes.
- README or architecture docs are updated when behavior or setup changes.
- Temporary research notes, screenshots, and competitor analysis are not committed.
- The GitHub Actions CI check passes.

## Documentation Policy

Keep repository documentation small:

- `README.md` for product overview, setup, and daily commands.
- `README.zh-CN.md` for the Simplified Chinese README.
- `docs/ARCHITECTURE.md` for current architecture.
- `docs/QUICKSTART.md` and `docs/QUICKSTART.zh-CN.md` for first-run guidance.
- `CONTRIBUTING.md` for workflow and standards.
- `AGENTS.md` for the required agent workflow.

Temporary planning or research documents should stay outside the committed repository, or in a local ignored folder.

## Code Standards

- Prefer TypeScript types at module boundaries.
- Keep runtime adapters isolated from routing and UI code.
- Keep UI state derived from server state where possible.
- Avoid adding abstractions until they remove real duplication or isolate a clear boundary.
- Do not commit generated logs, screenshots, local credentials, or machine-specific config.
