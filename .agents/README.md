# Orbit agent workflow files

`AGENTS.md` at the repository root is the shared source of truth for Codex, Claude Code, and CodeBuddy. `CLAUDE.md` and `CODEBUDDY.md` are thin adapter files that import it; do not copy the shared rules into them.

Add a nested `AGENTS.md` only when a subtree has rules that do not apply to the rest of the repository. A nested file supplements the nearest parent instructions and links back to the owning documents instead of repeating repository-wide rules.

Orbit does not currently define project-local Skills. When one is introduced, keep one canonical workflow source, document the discovery paths for Claude Code, Codex, and CodeBuddy here, and add only thin host adapters where needed. A Skill is an actionable workflow with an explicit trigger, scope, verification evidence, and links to its detailed references. Product contracts and architecture decisions belong in source or `docs/`, not only in a Skill.
