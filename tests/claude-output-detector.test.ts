import assert from "node:assert/strict";
import test from "node:test";

import { isCleanFinalAnswer } from "../src/core/claude-output-detector.ts";

test("rejects terminal noise as clean final answer", () => {
  assert.equal(isCleanFinalAnswer("API Error: 400"), false);
  assert.equal(isCleanFinalAnswer("* Brewing..."), false);
  assert.equal(isCleanFinalAnswer("Implemented the queue and tests pass."), true);
});

test("accepts agent handoff as clean final answer", () => {
  assert.equal(isCleanFinalAnswer("@architect: PR #37 is ready for review."), true);
});
