# AGENTS.md — Orbit project instructions

This is the canonical project instruction file. Codex loads it directly; `CLAUDE.md` and `CODEBUDDY.md` import it. Keep shared rules here and keep those adapter files thin.

## Read before changing

- Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before changing runtime composition, ACP adapters, routing, persistence, or agent lifecycle behavior.
- Read [docs/DATA_DIRECTORY.md](docs/DATA_DIRECTORY.md) before changing files under `~/.orbit`, workspace isolation, retention, sessions, messages, attachments, or transcripts.
- Read [docs/TERMINOLOGY_AND_ROUTING.md](docs/TERMINOLOGY_AND_ROUTING.md) before changing user-visible product terms, `@agent:` routing, or collaboration modes.
- Read [CONTRIBUTING.md](CONTRIBUTING.md) for contributor workflow and release-sensitive verification.
- Read the nearest nested `AGENTS.md` when one exists. A nested file adds rules for its subtree; it does not repeat root rules.

## Instruction ownership and references

- `AGENTS.md` owns shared standing orders for every coding agent.
- `CLAUDE.md` and `CODEBUDDY.md` are compatibility entry points that import this file. Do not maintain a second copy of shared rules there.
- `.agents/README.md` explains the project-local agent workflow and future Skill or decision-record layout.
- `docs/ARCHITECTURE.md` owns the current runtime map and detailed subsystem behavior; link to it instead of copying its module inventory into agent instructions.
- `README.md` and `README.zh-CN.md` own product setup and user-facing quickstart material.
- `docs/RELEASE_DECISIONS.md` owns release-specific decisions; do not put temporary release research in `AGENTS.md`.
- Use relative Markdown links for repository references. Give each durable fact one home and link to that home from other files.

## Repository layout

```text
src/core/      shared runtime, routing, persistence, sessions, and digital employees
src/server/    local HTTP server and SSE transport
src/ui/        React user interface and presentation state
src/shared/    shared runtime and API types
tests/         behavior and integration tests
scripts/       build, smoke, packaging, and release checks
docs/          architecture, setup, data, terminology, and release references
.agents/       agent instruction layout and project-local workflows
.claude/       ignored local Claude Code state; never commit it
dist/          generated build output; never edit by hand
```

Orbit is a local-first chat control surface that coordinates multiple digital employees through Claude Code ACP, Codex ACP, and CodeBuddy ACP. The product's digital employees are runtime data configured by Orbit; they are not the same thing as Claude Code, Codex, or CodeBuddy instruction files.

## Commands

```powershell
npm install
npm run dev
npm run test
npm run build
npm run build:all
npm run smoke:start
npm run smoke:port-conflict
npm run release:check
```

Use `npm run test` and `npm run build` before claiming a change is complete. For focused iteration, run a specific test with `node --test --import tsx tests/<file>.test.ts`. Changes to startup, packaging, dependency metadata, release workflows, or public setup also require the additional checks listed in [CONTRIBUTING.md](CONTRIBUTING.md).

`npm run build` type-checks the source, builds the Vite UI, and creates the standalone binary. It writes generated output under `dist/`; do not edit that output by hand. See [docs/standalone-build.md](docs/standalone-build.md) for packaging details.

## Scope and change discipline

- Do not work directly on `main`. Respect the user's existing task branch; if it already matches the request, continue there and do not create or switch branches. Otherwise use a task branch, keep the diff scoped, and preserve unrelated user changes.
- Use `feature/` for product changes, `fix/` for bugs, `refactor/` for internal restructuring, and `docs/` for documentation-only work; a host-created `codex/` branch is also valid when the agent environment requires it.
- State assumptions before implementing non-trivial work. Surface tradeoffs and stop when an ambiguity could change the result.
- Make the smallest correct change. Reuse existing utilities and patterns before adding helpers, dependencies, or abstractions.
- Every changed line must serve the request. Do not reformat or clean up unrelated code.
- Update tests when behavior changes. Update the owning README or architecture document when setup, behavior, or architecture changes.
- Do not commit logs, screenshots, credentials, generated output, or machine-specific configuration.

## Product and runtime invariants

- Orbit must not silently break the user's flow. Cancellation, interruption, permission requests, runtime failure, and process shutdown must leave clear recoverable state.
- Treat data under `~/.orbit` as user data. File writes must be atomic where the store already provides atomic replacement; migrations and retention must not discard active data.
- Keep runtime adapters isolated behind the shared ACP runtime contract. Runtime-specific protocol or CLI behavior belongs in the corresponding adapter, not in routing or UI code.
- All three runtimes use ACP v1 through newline-delimited JSON-RPC. Preserve the shared event mapping and keep backend-specific differences inside the adapter.
- The message store is the durable conversation source for Orbit's UI. Runtime session restoration must not replace or rewrite the channel history.
- Per-agent execution is serialized by `RunManager`. Do not introduce concurrent runs for one employee without updating the queue, lifecycle, persistence, and UI behavior together.
- User-visible strings use Orbit's product terms consistently in English and Simplified Chinese. Do not expose internal names such as `run`, `supervisor`, or `routeState` in the UI.
- Only `@display-name:` with a colon assigns work. Plain `@agent` text is a reference, not a route. Preserve the route-depth and self-assignment safeguards.
- When changing the UI, use the existing CSS custom properties and keep styles in `src/ui/styles.css`; do not hardcode new colors or move UI styling into unrelated modules.

## GitHub workflow and permissions

The normal change path is:

```text
request or issue -> task branch -> local verification -> commit -> push -> draft PR -> CI -> human merge
```

- Agents may create issues, branches, commits, pushes, draft PRs, and CI fixes.
- Agents must not merge into `main`, push directly to `main`, force-push, delete `main`, bypass CI, or enable auto-merge without explicit user approval.
- The user owns the final merge decision; the recommended merge method is squash and merge.
- Commit subjects must be real imperative summaries. Do not use `@`, `@agent`, `@agent:`, `wip`, or `temp` as the subject. Check the final subject with `git log -1 --format=%s` before pushing.
- A PR body must state what changed, how it was verified, and known limitations or follow-up work.

## Documentation and agent workflow

- Put standing rules in this file, current architecture in `docs/ARCHITECTURE.md`, data layout in `docs/DATA_DIRECTORY.md`, public terms in `docs/TERMINOLOGY_AND_ROUTING.md`, and release decisions in `docs/RELEASE_DECISIONS.md`.
- Keep durable prose in the repository's current-state voice. Do not narrate the coding session, review conversation, or temporary plan in a lasting instruction or architecture document.
- When a rule is needed only for one subtree, add a scoped `AGENTS.md` at that subtree instead of enlarging this file.
- Orbit does not currently define project-local Skills. If one is added, keep one canonical workflow source, document each host's discovery path in `.agents/README.md`, and use thin host adapters rather than duplicating the full workflow. A Skill must state when it applies, what evidence it requires, and where its detailed references live. Skills describe workflows; they do not replace source-code or product documentation.
- If a change creates a durable architecture decision that is not adequately owned by an existing document, add a focused decision document under `docs/` and link it from the owning architecture or workflow page. Do not create a duplicate fact in this file.

## Claude Code, Codex, and CodeBuddy

- Claude Code starts from `CLAUDE.md`, which imports this file with `@AGENTS.md`.
- Codex starts from `AGENTS.md` and applies the nearest nested file for the target subtree.
- CodeBuddy starts from `CODEBUDDY.md`, which imports this file with `@AGENTS.md`; its project-specific rules and Skills belong under `.codebuddy/` only when Orbit needs them.
- These entry points share one source of truth. Add a tool-specific instruction only when that tool has a behavior the other two do not share, and keep it in the corresponding adapter file.
- When changing a runtime adapter, verify the adapter's focused tests and the shared ACP tests. When changing agent prompts, routing, or user-visible output, verify the relevant message, routing, and UI behavior tests.

## Verification and handoff

Before committing:

1. Inspect `git status --short --branch` and confirm the branch and diff are scoped.
2. Run the smallest relevant focused tests while iterating.
3. Run `npm run test` and `npm run build` for the final change.
4. Run the additional release or smoke checks required by the changed surface.
5. Run `git diff --check` and inspect the final diff.
6. Commit with a real imperative subject, push the task branch, and open a draft PR when the repository workflow requires one.

Report exactly which checks ran, which were skipped, and any known limitation. Do not claim a check passed when it was not run.
