# Agent Workflow

This file defines the required workflow for any agent working in this repository.

## Core Rule

Do not work directly on `main`.

Every change must go through:

```text
issue or request -> feature branch -> local verification -> commit -> push -> pull request -> CI -> human merge
```

For the current private repository, branch protection may not be enforced by GitHub. Agents must still follow this process.

## Think Before Coding

Before writing or changing code, make sure you understand the task:

- **State your assumptions.** If you are guessing about intent, data shapes, or behavior, say what you are assuming. If a guess could change the outcome, ask first.
- **Surface tradeoffs.** If more than one approach is reasonable, name them and recommend one. If the request is harder or riskier than it looks, say so before starting.
- **Push back when warranted.** If the request would break existing behavior, add complexity for no user gain, or contradict how Orbit works, flag it instead of silently complying.
- **Stop and ask when something is unclear.** Naming what is confusing is more useful than plowing ahead and getting it wrong.

## Engineering Principles

Apply to every change, large or small.

- **Smallest correct change.** Write the minimum code that solves the stated problem. No speculative features, no "flexibility" or configurability nobody asked for, no abstractions for single-use code, no error handling for impossible states. If 50 lines can replace 200, rewrite.
- **Surgical edits.** Touch only what the task requires. Do not reformat, "improve," or refactor adjacent code that is not broken. Match the surrounding style even if you would write it differently. If you spot unrelated dead code, mention it — do not delete it. Clean up only the orphans your own change creates.
- **Every changed line traces to the request.** If a line does not, it should not be in the diff.
- **Reuse before you create.** Read the existing code first and reuse its utilities and patterns (see the module map in `CLAUDE.md`). Do not add a new helper, dependency, or convention when an existing one already fits.

## Product Principles

Orbit is a product people use, not just code that runs. Keep the user in mind.

- **Lead with user value.** Be able to answer "what does the user gain?" for any change. If a change is purely internal, say so and confirm it is wanted before doing it.
- **Never break the user's flow.** Orbit runs long agent tasks. Do not silently swallow errors, and never leave an agent stuck — queued forever, spinning, or with no feedback. Interruption, cancellation, and failure must always leave clear, recoverable state.
- **Local-first is a promise.** Orbit runs on the user's machine and persists to `~/.orbit`. Treat data loss (messages, sessions, agent configs, workspace settings) as a serious bug. File writes must not corrupt on crash; respect the data-directory layout.
- **Speak the user's language.** User-facing strings use the product's terms (数字员工, not internal jargon) and stay consistent across both UI languages (EN/ZH). Never leak internal codewords (`run`, `supervisor`, `routeState`, etc.) into messages the user sees.
- **Flag UX cost.** If a change adds friction — an extra step, a new modal, a slower path — name that cost before implementing.

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

Turn the task into a verifiable goal before coding:

- **Bug:** write a test that reproduces it, then make it pass.
- **Feature:** write tests for the expected behavior, then implement until they pass.
- **Refactor:** confirm tests pass before and after.

Strong success criteria let you work independently; "make it work" is not one. Then, before committing, run:

```powershell
npm run test
npm run build
```

If either fails, fix it before opening or updating a PR. Report exactly what passed and what did not — never mark a task done while a check fails or was skipped.

## Commit And Pull Request

After verification passes:

```powershell
git add -A
git commit -m "Short imperative message"
git push -u origin <branch-name>
```

### Commit Message Rules

- The first commit message line must be the real subject, for example:
  `fix: allow agent handoff final answers (#38)`.
- Never use routing markers or placeholders such as `@`, `@agent`, `@agent:`,
  `wip`, or `temp` as the commit subject.
- When using multiple `-m` flags, the first `-m` is the subject. Put the
  detailed body in later `-m` flags only.
- Before pushing, verify the latest subject:

```powershell
git log -1 --format=%s
```

If the subject is wrong, fix it before pushing:

```powershell
git commit --amend -m "Correct imperative subject"
```

For a PR branch with several bad local commits, rewrite or squash them into
clean commits before pushing. Do not leave commit headlines like `@`.

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
