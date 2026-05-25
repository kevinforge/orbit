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

  assert.equal(extractClaudeCliFinalAnswer(output), "final answer");
});

test("builds a spawnable command", () => {
  const command = buildClaudeCliCommand();

  assert.ok(command.file.length > 0);
  assert.ok(command.args.includes("--print"));
});

test("falls back to clean text output", () => {
  assert.equal(extractClaudeCliFinalAnswer("final answer\n"), "final answer");
});

test("extractSessionId from init event", () => {
  const output = JSON.stringify({ type: "system", session_id: "abc-123" });
  assert.equal(extractSessionId(output), "abc-123");
});

test("extractSessionId returns null for no session", () => {
  assert.equal(extractSessionId(""), null);
  assert.equal(extractSessionId("not json"), null);
});

test("extractSessionId returns first match", () => {
  const output = [
    JSON.stringify({ type: "system", session_id: "first" }),
    JSON.stringify({ type: "result", session_id: "second" }),
  ].join("\n");
  assert.equal(extractSessionId(output), "first");
});
