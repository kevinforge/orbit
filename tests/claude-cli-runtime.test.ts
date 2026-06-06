import assert from "node:assert/strict";
import test from "node:test";

import {
  buildClaudeCliArgs,
  buildClaudeCliCommand,
  extractClaudeCliFinalAnswer,
  extractSessionId,
} from "../src/core/claude-cli-runtime.ts";

test("builds non-interactive Claude CLI args without resume", () => {
  assert.deepEqual(buildClaudeCliArgs(), [
    "--print",
    "--verbose",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--permission-mode",
    "bypassPermissions",
  ]);
});

test("builds CLI args with --resume when resumeSessionId is set", () => {
  const args = buildClaudeCliArgs({ resumeSessionId: "sess-abc" });
  assert.deepEqual(args, [
    "--print",
    "--verbose",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--permission-mode",
    "bypassPermissions",
    "--resume",
    "sess-abc",
  ]);
});

test("builds CLI args without resume when resumeSessionId is undefined", () => {
  const args = buildClaudeCliArgs({ resumeSessionId: undefined });
  assert.equal(args.includes("--resume"), false);
});

test("extracts final answer from stream-json result events", () => {
  const output = [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "thinking" }] } }),
    JSON.stringify({ type: "result", result: "final answer" }),
  ].join("\n");

  assert.equal(extractClaudeCliFinalAnswer(output).text, "final answer");
});

test("builds a spawnable command", () => {
  const command = buildClaudeCliCommand();

  assert.ok(command.file.length > 0);
  assert.ok(command.args.includes("--print"));
});

test("returns empty text when no result event is present and input is plain text", () => {
  assert.equal(extractClaudeCliFinalAnswer("final answer\n").text, "");
});

test("handles concatenated JSON objects without newline separator", () => {
  const output =
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "partial" }] } }) +
    JSON.stringify({ type: "result", result: "final answer" });

  const result = extractClaudeCliFinalAnswer(output);
  assert.equal(result.text, "final answer");
});

test("ignores Claude error result events as final answers", () => {
  const output = [
    JSON.stringify({
      type: "assistant",
      error: "unknown",
      message: { content: [{ type: "text", text: "API Error: socket closed" }] },
    }),
    JSON.stringify({
      type: "result",
      is_error: true,
      result: "API Error: socket closed",
      session_id: "sess-error",
    }),
  ].join("\n");

  const result = extractClaudeCliFinalAnswer(output);
  assert.equal(result.text, "");
  assert.equal(result.sessionId, "sess-error");
});

test("extractSessionId from init event", () => {
  const output = JSON.stringify({ type: "system", subtype: "init", session_id: "abc-123" });
  assert.equal(extractSessionId(output), "abc-123");
});

test("extractSessionId handles concatenated JSON objects without newline separator", () => {
  const output =
    JSON.stringify({ type: "system", subtype: "hook_started", session_id: "hook-id" }) +
    JSON.stringify({ type: "system", subtype: "init", session_id: "real-session" });

  assert.equal(extractSessionId(output), "real-session");
});

test("extractSessionId returns null for no session", () => {
  assert.equal(extractSessionId(""), null);
  assert.equal(extractSessionId("not json"), null);
  assert.equal(extractSessionId(JSON.stringify({ type: "system", subtype: "hook_started", session_id: "hook-id" })), null);
});

test("extractSessionId returns first init event match", () => {
  const output = [
    JSON.stringify({ type: "system", subtype: "hook_started", session_id: "hook-session" }),
    JSON.stringify({ type: "system", subtype: "init", session_id: "real-session" }),
  ].join("\n");
  assert.equal(extractSessionId(output), "real-session");
});

test("Claude CLI does not support --image flag (images passed via prompt injection)", () => {
  const args = buildClaudeCliArgs();
  assert.equal(args.includes("--image"), false, "Claude CLI should not have --image flag");
});
