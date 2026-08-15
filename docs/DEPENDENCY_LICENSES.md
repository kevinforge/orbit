# Dependency License Review

This document records the dependency-license baseline for Orbit 1.0 open source
readiness. It is an engineering review aid, not legal advice.

## Current License Set

The current `package-lock.json` contains packages under these license
identifiers:

- `0BSD`
- `Apache-2.0`
- `BSD-2-Clause`
- `BSD-3-Clause`
- `ISC`
- `MIT`
- `MPL-2.0`
- `SEE LICENSE IN LICENSE.md`
- `SEE LICENSE IN README.md`
- `Unlicense`

These licenses are commonly used in open source JavaScript projects. The two
`SEE LICENSE IN ...` values are package metadata markers; their distributed
license files remain part of the installed npm dependencies. The permissive
licenses above are generally straightforward for distribution. The `MPL-2.0`
dependencies should be treated with care because MPL has file-level copyleft
requirements for modified MPL-covered files. The ACP adapters also bring
`BSD-2-Clause` and `Unlicense` into the lockfile; Orbit does not modify those
dependencies.

## Release Gate

Before tagging `v1.0.0`:

- Re-run `npm audit --audit-level=moderate`.
- Re-run the package metadata tests.
- Review any newly introduced dependency license identifiers.
- Confirm that release packages preserve required notices such as `LICENSE`.

The test suite intentionally fails if `package-lock.json` introduces a license
identifier outside the currently reviewed set.
