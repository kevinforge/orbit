import assert from "node:assert/strict";
import test from "node:test";

import { isCleanFinalAnswer } from "../src/core/claude-output-detector.ts";

test("rejects empty output", () => {
  assert.equal(isCleanFinalAnswer(""), false);
  assert.equal(isCleanFinalAnswer("  "), false);
});

test("rejects raw JSON event leakage (starts with {\"type\":)", () => {
  assert.equal(isCleanFinalAnswer('{"type":"item.completed"}'), false);
  assert.equal(isCleanFinalAnswer('{ "type" : "result" , "result": "text"}'), false);
});

test("accepts JSON-like text not at the start (not a structural leak)", () => {
  // Mid-text JSON-like fragments are not structural leaks — they won't
  // appear if parseJsonObjects + textFromEvent work correctly.
  // This is a "defense in depth" decision: we only guard the most
  // reliable signal (starts-with JSON), not arbitrary substrings.
  assert.equal(isCleanFinalAnswer("some text {\"type\": \"tool_use\"}"), true);
});

test("rejects CLI shell prompt leakage (starts with >)", () => {
  assert.equal(isCleanFinalAnswer("> npm run build"), false);
  assert.equal(isCleanFinalAnswer("> some command output"), false);
});

test("accepts normal markdown content as clean final answer", () => {
  assert.equal(isCleanFinalAnswer("结论：当前实现是 **best-effort interrupt**，不是强保证停止。"), true);
  assert.equal(isCleanFinalAnswer("## Summary\n\nThe fix is complete."), true);
  assert.equal(isCleanFinalAnswer("@architect: PR #37 is ready for review."), true);
  assert.equal(isCleanFinalAnswer("Implemented the queue and tests pass."), true);
});

test("accepts text that would have been rejected by the old keyword blacklist", () => {
  // These were rejected by the old keyword-based filter.
  // With structural checks, extraction correctness handles them
  // and isCleanFinalAnswer is only the last-resort guard.
  assert.equal(isCleanFinalAnswer("API Error: 400"), true);
  assert.equal(isCleanFinalAnswer("* Brewing..."), true);
  assert.equal(isCleanFinalAnswer("tool.started: read_file completed"), true);
  assert.equal(isCleanFinalAnswer("item.completed: error details follow"), true);
});
