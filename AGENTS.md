# Agent Workflow

This file defines the required workflow for any agent working in this repository.

## Core Rule

Do not work directly on `main`.

Every change must go through:

```text
issue or request -> feature branch -> local verification -> commit -> push -> pull request -> CI -> human merge
```

For the current private repository, branch protection may not be enforced by GitHub. Agents must still follow this process.

## Start Of Task

1. Read the user's request and identify the smallest useful scope.
2. Inspect the current repository state:

```powershell
git status --short --branch
git branch --show-current
```

3. If already on a feature branch for the same request, continue there.
4. If starting new work, create a branch from latest `main`:

```powershell
git checkout main
git pull
git checkout -b feature/short-description
```

Use these prefixes:

- `feature/` for product changes
- `fix/` for bugs
- `refactor/` for internal restructuring
- `docs/` for documentation-only changes

## During Development

- Keep changes scoped to the request.
- Do not rewrite unrelated code.
- Do not remove user changes.
- Add or update tests for changed behavior where practical.
- Update `README.md`, `README.zh-CN.md`, or `docs/ARCHITECTURE.md` when behavior, setup, or architecture changes.
- Keep temporary research, screenshots, competitor analysis, and local notes out of the repository.

## Verification

Before committing, run:

```powershell
npm run test
npm run build
```

If either command fails, fix the issue before opening or updating a PR.

## Commit And Pull Request

After verification passes:

```powershell
git add -A
git commit -m "Short imperative message"
git push -u origin <branch-name>
```

Create a draft PR:

```powershell
gh pr create --draft --base main --head <branch-name> --title "Short title" --body "..."
```

The PR body must include:

- what changed
- how it was verified
- any known limitations or follow-up work

## CI And Review

Agents may:

- inspect CI status
- inspect CI logs
- push fixes to the same branch
- mark the PR ready when implementation and verification are complete

Agents must not:

- merge a PR into `main`
- force push to `main`
- delete `main`
- bypass CI
- auto-merge without explicit user approval

## Human Merge

The user owns the final merge decision.

Recommended merge method:

```text
Squash and merge
```

After merge, the user or agent may clean up:

```powershell
git checkout main
git pull
git branch -d <branch-name>
```

## GitHub Automation Boundary

The current no-cost setup allows agents to automate issue, branch, commit, push, PR, and CI-fix workflows.

Automatic merge to `main` is intentionally disabled until the repository has enforced branch protection or the user explicitly changes this policy.
