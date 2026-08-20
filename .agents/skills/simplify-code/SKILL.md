---
name: simplify-code
description: 'Simplify existing code for clarity without changing behavior. Use after a feature works, during code review, when code is difficult to read or maintain, when logic is deeply nested or duplicated, or when related code should be consolidated.'
---

# Simplify Code

Simplify code by reducing complexity while preserving exact behavior. The goal is not fewer lines; it is code that is easier to read, understand, modify, and debug. Every change should pass this test: would a new team member understand it faster than the original?

## When to Use

Use this skill:

- after a feature works and tests pass but the implementation feels heavier than necessary;
- during review when readability or complexity is a concern;
- when logic is deeply nested, functions are long, or names are unclear;
- when refactoring code written under time pressure;
- when consolidating related logic scattered across files;
- after a merge introduced duplication or inconsistency.

Do not use it when code is already clear, when you do not yet understand it, when the simpler version would be measurably slower in a performance-critical path, or when the module is about to be discarded entirely.

## Principles

### Preserve behavior exactly

Change how the code is expressed, not what it does. Preserve all inputs, outputs, side effects, ordering, errors, timing assumptions, and edge cases. Ask before every change:

- Does every input produce the same output?
- Is error behavior unchanged?
- Are side effects and their ordering preserved?
- Do existing tests pass without modification?

If unsure, do not simplify until the behavior is understood and covered.

### Follow project conventions

Read the repository instructions and study neighboring code before editing. Match its conventions for imports, module systems, declarations, naming, errors, and type annotations. A change that breaks local consistency is churn, not simplification.

### Prefer clarity over cleverness

Prefer explicit code when a compact expression requires a mental pause. Replace dense ternary chains with guard clauses, named functions, or lookup data. Replace inline reductions with named intermediate values when they make the transformation easier to inspect.

### Maintain balance

Avoid over-simplification:

- do not inline a helper that gives an important concept a name;
- do not combine unrelated logic;
- do not remove abstractions that provide extensibility or testability;
- do not optimize for line count.

### Scope to what changed

Default to simplifying recently modified code. Do not perform drive-by refactors outside the current task unless the user explicitly broadens the scope.

## Process

### 1. Understand before touching

Apply Chesterton's Fence: understand why a piece of code exists before removing or changing it. Answer:

- What is its responsibility?
- Who calls it and what does it call?
- What are the edge cases and error paths?
- Which tests define the behavior?
- Was it written for performance, a platform constraint, compatibility, or a historical reason?
- What does `git blame` reveal about its original context?

If these questions cannot be answered, read more context first.

### 2. Identify concrete opportunities

Look for signals such as:

- three or more levels of nesting: use guard clauses or focused helpers;
- functions longer than roughly 50 lines: split responsibilities;
- nested ternaries: use conditionals, `switch`, or lookup objects;
- boolean flag parameters such as `doThing(true, false, true)`: use options or separate functions;
- repeated conditions: extract a named predicate;
- generic or abbreviated names such as `data`, `temp`, `usr`, or `cfg`: rename to describe their meaning;
- misleading names, especially a function named `get` that mutates state;
- comments that only restate what the code does: remove them;
- comments that explain why a non-obvious decision exists: keep them;
- duplicated logic of several lines: extract a shared function;
- unreachable branches, unused variables, or commented-out blocks: remove after confirming they are dead;
- wrappers that add no value: call the underlying function directly;
- factories or strategies with only one meaningful implementation: use the direct approach;
- redundant type assertions: remove them when inference already proves the type.

### 3. Apply changes incrementally

Make one simplification at a time. Run tests after each meaningful change. Keep refactoring separate from feature and bug-fix changes.

For each simplification:

1. Make the change.
2. Run the relevant test suite.
3. If it passes, continue or create a save-point commit.
4. If it fails, revert that simplification and reconsider.

Do not batch several untested simplifications. If something breaks, the cause should be identifiable. If a refactor would touch more than 500 lines, use codemods, AST transforms, or another repeatable automation instead of editing manually at that scale.

### 4. Verify the result

Compare before and after:

- Is the new code genuinely easier to understand?
- Does it follow project conventions?
- Is the diff clean and reviewable?
- Would a teammate approve it as a net improvement?

If the simplified version is harder to understand or review, revert it. Not every simplification attempt succeeds.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "It works, so do not touch it." | Hard-to-read code is harder to fix when it breaks. |
| "Fewer lines are always simpler." | Comprehension speed matters more than line count. |
| "I will quickly clean up unrelated code too." | Unscoped changes create noisy diffs and regression risk. |
| "The types document everything." | Types describe structure; names and code must express intent. |
| "This abstraction may be useful later." | Speculative abstractions add complexity without current value. |
| "The original author must have had a reason." | Check history, but accumulated complexity may simply be iteration residue. |
| "I will refactor while adding the feature." | Mixed changes are harder to review, revert, and understand. |

## Red Flags

Stop and reconsider when:

- tests must be modified only to make the simplification pass;
- the simplified code is longer or harder to follow;
- names are being changed to match personal preference rather than project convention;
- error handling is removed because it looks cleaner;
- the code is not fully understood;
- many simplifications are batched into one hard-to-review change;
- unrelated code is being refactored without authorization.

## Verification

After the simplification pass, confirm:

- existing tests pass without modification;
- the build succeeds without new warnings;
- the linter and formatter pass;
- each change is incremental and reviewable;
- the diff has no unrelated changes;
- project conventions are followed;
- no error handling was removed or weakened;
- no unused imports or unreachable branches remain;
- a teammate or review agent would approve the result as a net improvement.

This Skill is adapted from Addy Osmani's [`code-simplification`](https://github.com/addyosmani/agent-skills/tree/main/skills/code-simplification) Skill and renamed to avoid colliding with the architecture-focused `find-simplifications` Skill.
