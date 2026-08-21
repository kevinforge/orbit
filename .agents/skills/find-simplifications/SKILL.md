---
name: find-simplifications
description: 'Find evidence-backed opportunities to remove, merge, demote, or replace unnecessary code and system complexity. Use when a repository feels over-built, when reviewing architecture or lifecycle code, when auditing duplicated APIs or events, when considering a dependency replacement, or when deciding whether a design record is obsolete.'
---

# Find Simplifications

Use this skill to turn a broad request to "find things to simplify" into a small set of evidence-backed proposals. Focus on removing or collapsing real complexity, not on making code look different. Follow the repository's rules and prefer a few well-proven candidates over many thin guesses.

## Establish Project Context

Before judging a simplification, locate and read:

- repository instructions and contribution rules;
- architecture and testing documentation;
- the project's decision-record or design-note rules;
- defensive-programming and lifecycle guidance;
- validation commands and required quality gates.

Record the project-specific facts that constrain simplification:

- protected APIs, extension points, data formats, and compatibility promises;
- durable logs, events, schemas, or wire protocols;
- directories that contain production code, examples, tests, generated files, and design records;
- the format and lifecycle of decision records;
- commands required before a commit or push.

If the project has no decision-record system, produce a concise proposal in the repository's normal documentation location instead. Do not invent a repository-specific note workflow without checking its conventions first.

## What Counts as a Strong Candidate

A strong candidate removes, merges, demotes, or replaces something real, and evidence shows that its current cost exceeds its value. Look for:

- a public method, event, configuration option, registry notification, helper, package, durable record, or test artifact with no production consumer;
- tests or documentation as the only consumers of behavior that is not load-bearing;
- multiple representations that mirror the same fact;
- an extension point whose required methods have no consumers;
- a package that only serves tests, demos, or support code while adding dependency or publishing overhead;
- speculative product generality with no current owner or supported use case;
- defensive, rollback, lifecycle, or special-case machinery that only protects an unused API;
- hand-written infrastructure that a maintained dependency or supported platform builtin can replace while deleting implementation and dedicated tests;
- a simpler behavior that differs slightly but remains reasonable, documented, and easier to explain.

Do not create a durable proposal for one typo, one lint result, an intentionally protected implementation, or a claim that something "looks complex" without call-site evidence. Use a targeted TODO for a small local cleanup.

## Survey Broadly

When breadth matters, inspect several domains in parallel or simulate the same breadth yourself:

- execution loops, session state, events, replay, resume, cancellation, and teardown;
- public automation and user-interface APIs, prompt settlement, rendering, and interaction state;
- model, tool, configuration, registry, and system-prompt interfaces;
- process, shell, worker, job, output, and ownership handling;
- package boundaries, examples, scripts, tests, snapshots, generated outputs, and support utilities.

Start with the largest production-code deltas. Stopping after obvious unused symbols can miss duplicated lifecycle or defensive machinery that carries most of the cost.

## Audit Consumers and Trust Boundaries

For each candidate, classify every consumer before proposing removal:

- **Production:** runtime source, supported examples, loader/configuration paths, and release scripts.
- **Non-production:** tests, documentation, design records, snapshots, generated expectations, and comments.
- **Ambiguous:** examples or scripts that may be supported smoke paths; inspect them before classifying.

Use `rg` first. Search exact symbols, event names, package names, configuration keys, method calls in both `.name(` and `name(` forms, and wire or serialized strings. Read the call sites. Static unused-code tools help, but cannot replace understanding of public interfaces, dynamic names, tests, documentation, or loaders.

For every defensive copy, freeze, validator, or callback capture, identify where the value came from and who owns it next. Same-process typed calls normally borrow readonly values. Parsers, configuration loaders, queues, model/tool JSON, durable files, workers, processes, and wire decoders own or validate their data.

Tests involving hostile getters, fake typed objects, callback replacement, or mutation after a typed same-process handoff may indicate a speculative contract. They are not automatic justification for retaining the surrounding complexity.

For complex asynchronous code, draw the ownership graph. Map each sentinel, readiness promise, cancellation path, disposer, and state flag to a distinct owner or transition. If several mechanisms mirror the same liveness or settlement fact, consider one lifecycle or transaction controller. Keep separate machinery when it protects publication and rollback, callback containment, first-terminal-outcome arbitration, worker/process ownership, or disposal-to-quiescence.

## Consider Dependencies Carefully

Replacing hand-written infrastructure with a dependency is a valid simplification, not an exception to the repository's dependency policy. Ask whether a maintained package or a platform builtin already provides protocol parsing, framing, retry/backoff, glob matching, diffing, or similar infrastructure.

For a dependency-swap candidate:

1. Read the hand-written implementation and name the exact surface the dependency covers.
2. List residual semantics the dependency does not cover; they count against the proposal.
3. Check maintenance, adoption, security posture, and transitive footprint.
4. Prefer a platform builtin when the supported runtime already provides it.
5. Check existing design records for reasons the current implementation was retained.
6. Count net deletion: implementation, dedicated tests, and documentation, minus replacement glue.

A wrapper that merely moves the same complexity is not a simplification.

## Prove or Reject Each Candidate

For each candidate, record:

- the exact symbol, file, package, event, configuration key, or lifecycle mechanism;
- all production and non-production consumers;
- the current cost;
- the proposed end state;
- the behavior, compatibility, or capability that would be given up;
- the evidence that the change is safe;
- the tests, documentation, generated files, and records that must change.

Reject or downgrade the candidate when:

- a production caller exists and the change is really a feature decision;
- an existing design record or proven defensive pattern justifies the API and new evidence does not beat that reason;
- removal causes unrelated churn without reducing public API or required behavior;
- the candidate is correct but too small for a durable design decision.

Do not assume a method is unused merely because it has no obvious call site. Check dynamic dispatch, configuration, generated catalogs, plugin loading, serialized data, and external consumers where applicable.

## Write the Proposal

If the repository has decision records, create one proposal per durable simplification using its required path, lifecycle, classification, and naming rules. Otherwise, use the project's normal proposal format.

Prefer this structure:

- `# Simplification: <action-oriented title>`
- `Status: proposed`
- `## Problem`: current design, relevant files, and consumer evidence; separate production callers from tests and documentation.
- `## Proposal`: exactly what to remove, merge, demote, replace, or move; include code, tests, docs, generated files, and compatibility cleanup.
- `## Why not keep it?` or `## What we give up`: the strongest counterargument and the capability being surrendered.
- `## Acceptance criteria`: observable end state and validation gates.
- `## Risks`: API and behavior changes, future product needs, compatibility, and why the tradeoff is reasonable.

Make the proposal concrete enough for an implementing change to follow. When it overlaps an existing record, update or consolidate the existing owner instead of creating a duplicate.

## Small Local Cleanups

Use an inline `TODO`, `FIXME`, or `XXX` only when the cleanup is local, clearly useful, and does not require a durable design decision. Use a stable tag, state why it is safe to revisit, and name the simplifying action. Do not use TODOs for speculative complaints or architectural choices.

## Coalesce Obsolete Design Records

When a simplification makes an older design record obsolete, follow the repository's archive and deletion rules. First identify the current owner from shipped code, configuration, generated catalogs, package documentation, newer records, and inbound links.

Classify the old record as fully or partially superseded. Surviving behavior, current contracts, durable formats, compatibility obligations, or an independently current rejected alternative make it partial. Transferable rationale alone does not.

For full supersession, move every unique rationale, alternative, consequence, shipped verification, and named coverage gap into the current owner. Repair inbound links before deleting the old record and any required translations or consistency records together. Search exact filenames, symbols, configuration keys, event names, and wire strings after editing. Keep partial supersessions cross-linked and current.

An added-then-removed feature can be fully superseded only when it is absent from production code, configuration, schemas, durable and wire formats, migrations, compatibility behavior, current documentation, and supported tests. Preserve why it existed, why that reason no longer applies, alternatives, the capability given up, reintroduction conditions, and evidence that removal is complete.

Do not consolidate a record when only one transport, default, implementation, or presentation was removed; persisted data or compatibility handling remains; or the removal record lacks enough rationale to prevent accidental reintroduction.

## Implement and Validate

Keep discovery proposals separate from unrelated feature work. For implementation:

1. Make one simplification or one coherent removal at a time.
2. Run focused tests and validation after each meaningful change.
3. Update affected contracts, documentation, generated outputs, and design records together.
4. Inspect the final diff for unrelated churn.
5. Run the smallest repository-required checks that cover the changed surface.

For documentation-only proposals, run the repository's documentation and formatting checks. For code changes, run relevant tests, type checks, builds, linters, and generated-file checks. Report only commands actually run.

Before calling the change complete, verify:

- every removed consumer was classified;
- no supported production path was accidentally removed;
- public behavior and compatibility changes are explicit;
- the resulting design is easier to explain;
- no dead code, stale documentation, or broken links remain;
- the diff contains no unrelated changes;
- the project-specific quality gates pass.
