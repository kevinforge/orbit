# Support

Orbit is a local-first project. Support requests should include enough context
to protect user data under `~/.orbit` and to reproduce long-running digital
employee workflows safely.

## Where To Ask

- **Reproducible bugs:** open a GitHub issue using the bug report template.
- **Feature ideas:** open a GitHub issue using the feature request template.
- **Security vulnerabilities:** do not open a public issue. Follow
  `SECURITY.md`.
- **Pull requests:** follow `CONTRIBUTING.md` and the pull request template.
- **1.0 release-candidate verification:** use `docs/RELEASE_CHECKLIST.md` and
  `docs/STABILITY_VERIFICATION.md`.

Blank issues are disabled so reports keep the information needed for triage.

## What To Include

For bugs, include:

- Orbit version or commit.
- Install method: source checkout, GitHub Release artifact, or local package.
- Operating system and architecture.
- Node.js, npm, and Bun versions when relevant.
- Runtime CLI status for Claude Code, Codex, and CodeBuddy.
- Steps to reproduce.
- Expected and actual behavior.
- Whether messages, sessions, agent config, attachments, transcripts, or other
  files under `~/.orbit` were affected.
- Logs, screenshots, or copied UI text with secrets and private data removed.

For feature requests, include:

- The user problem or workflow being improved.
- The proposed behavior.
- Any impact on startup, packaging, runtime CLIs, routing, queues,
  cancellation, local data, or recovery.
- Suggested tests or manual verification.

## Support Scope For 1.0 RCs

During `v1.0.0-rc.*`, maintainers should prioritize:

- Startup failures.
- Packaging and release artifact installation failures.
- Data loss or corruption under `~/.orbit`.
- Permanently stuck running or queued digital employee work.
- Clear regressions in routing, cancellation, or recovery.
- Security reports.

Questions and feature requests are welcome, but they may be handled after
release-blocking stability and data-safety issues.

## Response Expectations

The project aims to acknowledge clear bug and security reports within 7 days
when maintainers are available. Open source support is best-effort unless a
separate support agreement exists.

## Privacy

Do not post secrets, private repository content, credentials, API keys, personal
data, or full terminal transcripts in public issues. Share the smallest
relevant excerpt needed to reproduce or diagnose the problem.
