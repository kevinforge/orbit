import assert from "node:assert/strict";
import test from "node:test";

import { buildClaudeCliArgs, buildClaudeCliCommand, extractClaudeCliFinalAnswer } from "../src/core/claude-cli-runtime.ts";

test("builds non-interactive Claude CLI args", () => {
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
