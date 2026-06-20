# Conversation Running Employees Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Identify the active 数字员工 behind each existing conversation running indicator.

**Architecture:** Derive one user-facing label from the existing `RunningSummary` and `AgentState` data in the UI. Keep the current sidebar dot and expose the derived label through its hover title and accessible name; do not add state, persistence, or server behavior.

**Tech Stack:** React 19, TypeScript, Node.js test runner.

---

### Task 1: Derive running employee labels

**Files:**
- Modify: `tests/app-message-pagination.test.ts`
- Modify: `src/ui/App.tsx`

- [ ] **Step 1: Write the failing tests**

Import `getConversationRunningLabel` from `App.tsx`. Cover stable display-label order with duplicate IDs, unknown-ID fallback, and an inactive conversation returning `null`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test --import tsx tests/app-message-pagination.test.ts`

Expected: FAIL because `getConversationRunningLabel` is not exported.

- [ ] **Step 3: Implement the minimal helper and UI wiring**

Add a pure exported helper beside `isConversationRunning`. Find the matching workspace/conversation summary, deduplicate `runningAgentIds` in their existing order, map known IDs to `AgentState.label`, fall back to the ID, and return `数字员工正在工作：<labels>` or `null`. In the conversation row, render the existing dot only when the helper returns a label and set both `title` and `aria-label` to that label.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `node --test --import tsx tests/app-message-pagination.test.ts`

Expected: PASS with all focused assertions.

### Task 2: Verify and publish

**Files:**
- Verify: `src/ui/App.tsx`
- Verify: `tests/app-message-pagination.test.ts`

- [ ] **Step 1: Run repository verification**

Run `npm run test`, `npm run build`, and `git diff --check`. All must exit 0.

- [ ] **Step 2: Commit the scoped change**

Run `git add docs/superpowers/plans/2026-06-20-conversation-running-employees.md src/ui/App.tsx tests/app-message-pagination.test.ts` and commit with `feat: identify running employees in conversation sidebar (#110)`.

- [ ] **Step 3: Push and open a draft PR**

Push `feature/conversation-running-employees`, open a draft PR against `main`, include what changed, verification, limitations, and `Closes #110`, then inspect CI without merging.
