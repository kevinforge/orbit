import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCodeBuddyCliArgs,
  buildCodeBuddyCliCommand,
  extractCodeBuddyCliFinalAnswer,
  extractCodeBuddySessionId,
} from "../src/core/codebuddy-cli-runtime.ts";

test("builds non-interactive CodeBuddy CLI args without resume", () => {
  assert.deepEqual(buildCodeBuddyCliArgs(), [
    "--print",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--permission-mode",
    "bypassPermissions",
  ]);
});

test("builds CodeBuddy CLI args with --resume when resumeSessionId is set", () => {
  assert.deepEqual(buildCodeBuddyCliArgs({ resumeSessionId: "sess-abc" }), [
    "--print",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--permission-mode",
    "bypassPermissions",
    "--resume",
    "sess-abc",
  ]);
});

test("builds a spawnable CodeBuddy command", () => {
  const command = buildCodeBuddyCliCommand();

  assert.ok(command.file.length > 0);
  assert.ok(command.args.includes("--print"));
});

test("extracts final answer from CodeBuddy stream-json result events", () => {
  const output = [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "draft" }] } }),
    JSON.stringify({ type: "result", result: "final answer", session_id: "sess-final" }),
  ].join("\n");

  assert.deepEqual(extractCodeBuddyCliFinalAnswer(output), {
    text: "final answer",
    sessionId: "sess-final",
  });
});

test("extracts CodeBuddy error events", () => {
  const output = JSON.stringify({ type: "error", error: "No conversation found with session ID: bad-session" });

  assert.deepEqual(extractCodeBuddyCliFinalAnswer(output), {
    text: "",
    error: "No conversation found with session ID: bad-session",
  });
});

test("extracts CodeBuddy session id from init events", () => {
  const output = JSON.stringify({ type: "system", subtype: "init", session_id: "sess-init" });
  assert.equal(extractCodeBuddySessionId(output), "sess-init");
});
