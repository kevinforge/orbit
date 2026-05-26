import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCodexCliArgs,
  buildCodexCliCommand,
  extractCodexCliFinalAnswer,
  extractCodexSessionId,
} from "../src/core/codex-cli-runtime.ts";

test("builds non-interactive Codex exec args without resume", () => {
  assert.deepEqual(buildCodexCliArgs({ cwd: "D:/workspace" }), [
    "exec",
    "--json",
    "--cd",
    "D:/workspace",
    "--sandbox",
    "danger-full-access",
    "--dangerously-bypass-approvals-and-sandbox",
    "-",
  ]);
});

test("builds Codex resume args with session id", () => {
  assert.deepEqual(buildCodexCliArgs({ cwd: "D:/workspace", resumeSessionId: "sess-abc" }), [
    "exec",
    "resume",
    "sess-abc",
    "--json",
    "--sandbox",
    "danger-full-access",
    "--dangerously-bypass-approvals-and-sandbox",
    "-",
  ]);
});

test("builds a spawnable Codex command", () => {
  const command = buildCodexCliCommand({ cwd: "D:/workspace" });

  assert.ok(command.file.length > 0);
  assert.ok(command.args.includes("exec"));
});

test("extracts final answer from Codex JSONL message events", () => {
  const output = [
    JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "final answer" }],
      },
    }),
  ].join("\n");

  assert.deepEqual(extractCodexCliFinalAnswer(output), {
    text: "final answer",
    sessionId: "thread-123",
  });
});

test("extracts Codex session id from thread or session fields", () => {
  assert.equal(extractCodexSessionId(JSON.stringify({ type: "thread.started", thread_id: "thread-123" })), "thread-123");
  assert.equal(extractCodexSessionId(JSON.stringify({ type: "session.started", session_id: "sess-123" })), "sess-123");
});
