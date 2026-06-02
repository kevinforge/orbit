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

test("rejects tool event leakage in final answer", () => {
  assert.equal(isCleanFinalAnswer("tool.started: read_file completed successfully"), false);
  assert.equal(isCleanFinalAnswer("Execution result: tool.completed with output"), false);
  assert.equal(isCleanFinalAnswer("Error: tool.failed during npm install"), false);
});

test("rejects raw JSON fragment leakage in final answer", () => {
  assert.equal(isCleanFinalAnswer('{"type":"item.completed"}'), false);
  assert.equal(isCleanFinalAnswer('some text {"type": "tool_use"}'), false);
});

test("rejects item event leakage in final answer", () => {
  assert.equal(isCleanFinalAnswer("item.started: processing request"), false);
  assert.equal(isCleanFinalAnswer("item.completed: error details follow"), false);
});

test("accepts markdown content as clean final answer", () => {
  assert.equal(isCleanFinalAnswer("结论：当前实现是 **best-effort interrupt**，不是强保证停止。"), true);
  assert.equal(isCleanFinalAnswer("## Summary\n\nThe fix is complete."), true);
});
