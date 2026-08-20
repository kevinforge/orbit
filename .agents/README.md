# Orbit agent workflow files

`AGENTS.md` at the repository root is the shared source of truth for Codex, Claude Code, and CodeBuddy. `CLAUDE.md` and `CODEBUDDY.md` are thin adapter files that import it; do not copy the shared rules into them.

Add a nested `AGENTS.md` only when a subtree has rules that do not apply to the rest of the repository. A nested file supplements the nearest parent instructions and links back to the owning documents instead of repeating repository-wide rules.

Project-local Skills have one canonical source under `.agents/skills/<skill-name>/SKILL.md`. Codex can discover this project path. Claude Code and CodeBuddy use native `.claude/skills/` and `.codebuddy/skills/` paths, so their adapters must point agents to the canonical Skill rather than duplicate its body. A Skill is an actionable workflow with an explicit trigger, scope, verification evidence, and links to its detailed references. Product contracts and architecture decisions belong in source or `docs/`, not only in a Skill.

Current Skills:

- `record-browser-gif` — records and verifies truthful Orbit browser demos for the README, documentation, release notes, and GUI pull requests.
- `find-simplifications` — finds evidence-backed opportunities to remove or consolidate architectural and system complexity.
- `simplify-code` — performs behavior-preserving refactors that make existing code clearer and easier to maintain.
