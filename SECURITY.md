# Security Policy

## Supported Versions

Security fixes are currently prepared for the latest release line only. Before
Orbit 1.0, that means the current `main` branch and the latest published
pre-1.0 release.

After 1.0, supported versions will be documented in release notes.

## Reporting A Vulnerability

Please do not open a public issue for a suspected vulnerability.

Report security issues through GitHub's private vulnerability reporting for
this repository. If private reporting is not available, contact the maintainer
privately and include:

- The affected version or commit.
- The operating system and Node.js version.
- Clear reproduction steps.
- The expected impact.
- Whether local user data under `~/.orbit` is involved.

We aim to acknowledge reports within 7 days. Valid issues will receive a fix,
mitigation, or public advisory when appropriate.

## Local Data

Orbit stores workspace metadata, conversations, messages, sessions, agent
settings, attachments, and transcripts under `~/.orbit`. Treat that directory
as user data. Security fixes should avoid data loss and should document any
manual recovery steps.
