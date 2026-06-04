import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCodexCliArgs,
  buildCodexCliCommand,
  createCodexEnv,
  extractCodexCliFinalAnswer,
  extractCodexSessionId,
  resolveCodexCommand,
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
    "--json",
    "--dangerously-bypass-approvals-and-sandbox",
    "sess-abc",
    "-",
  ]);
});

test("builds a spawnable Codex command", () => {
  const command = buildCodexCliCommand({ cwd: "D:/workspace" }, { ORBIT_CODEX_PATH: "C:/codex/bin/codex.exe" });

  assert.equal(command.file, "C:/codex/bin/codex.exe");
  assert.ok(command.args.includes("exec"));
});

test("uses configured Codex CLI path when provided", () => {
  assert.equal(resolveCodexCommand({ ORBIT_CODEX_PATH: "C:/tools/codex.exe" }), "C:/tools/codex.exe");
  assert.equal(resolveCodexCommand({ CODEX_CLI_PATH: "D:/tools/codex.exe" }), "D:/tools/codex.exe");
});

test("Codex env preserves the user's Codex home", () => {
  const env = createCodexEnv("pm", { CODEX_HOME: "C:/Users/Sean/.codex" });

  assert.equal(env.CODEX_HOME, "C:/Users/Sean/.codex");
  assert.equal(env.ORBIT_AGENT_ID, "pm");
  assert.equal(env.CODEX_AGENT_ID, "pm");
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

test("extracts final answer from Codex agent_message events", () => {
  const output = [
    JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "agent_message",
        text: "final answer",
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

test("extracts Codex session id from concatenated JSON objects", () => {
  const output =
    JSON.stringify({ type: "tool.started", name: "read" }) +
    JSON.stringify({ type: "thread.started", thread_id: "thread-concat" });

  assert.equal(extractCodexSessionId(output), "thread-concat");
});

test("parses concatenated JSON objects without newline separator", () => {
  const output =
    JSON.stringify({ type: "tool.started", name: "read" }) +
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hi" } });

  const result = extractCodexCliFinalAnswer(output);

  assert.equal(result.text, "hi");
});

test("ignores Codex error result events as final answers", () => {
  const output = [
    JSON.stringify({ type: "thread.started", thread_id: "thread-error" }),
    JSON.stringify({ type: "result", is_error: true, result: "API Error: socket closed" }),
  ].join("\n");

  const result = extractCodexCliFinalAnswer(output);

  assert.equal(result.text, "");
  assert.equal(result.sessionId, "thread-error");
});

test("ignores plain non-JSON text between valid events", () => {
  const output = [
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "first" } }),
    "DEBUG: some random log output",
    "> npm run build output",
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "second" } }),
  ].join("\n");

  const result = extractCodexCliFinalAnswer(output);

  assert.equal(result.text, "first\nsecond");
});

test("handles braces inside JSON string values", () => {
  const output = JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: "use {braces} in code" },
  });

  const result = extractCodexCliFinalAnswer(output);

  assert.equal(result.text, "use {braces} in code");
});

test("handles escaped quotes inside JSON string values", () => {
  const output = JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: 'she said "hello"' },
  });

  const result = extractCodexCliFinalAnswer(output);

  assert.equal(result.text, 'she said "hello"');
});

test("returns empty text for plain non-JSON input", () => {
  const result = extractCodexCliFinalAnswer("plain text only, no JSON at all");

  assert.equal(result.text, "");
});

test("returns empty text for empty input", () => {
  const result = extractCodexCliFinalAnswer("");

  assert.equal(result.text, "");
});

test("extracts only structured final answer, ignoring tool events in same stream", () => {
  const output = [
    JSON.stringify({ type: "thread.started", thread_id: "thread-456" }),
    JSON.stringify({ type: "tool.started", name: "web_search", input: "query" }),
    JSON.stringify({ type: "item.completed", item: { type: "tool_execution", aggregated_output: "search results..." } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "结论：当前实现是 **best-effort interrupt**，不是强保证停止。" } }),
    JSON.stringify({ type: "turn.completed" }),
  ].join("\n");

  const result = extractCodexCliFinalAnswer(output);

  assert.equal(result.text, "结论：当前实现是 **best-effort interrupt**，不是强保证停止。");
  assert.equal(result.sessionId, "thread-456");
});

test("excludes commentary phase from final answer, keeps final_answer phase", () => {
  const output = [
    JSON.stringify({ type: "thread.started", thread_id: "thread-phase" }),
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "agent_message",
        text: "I will first confirm the current branch and workspace state...",
        phase: "commentary",
      },
    }),
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "agent_message",
        text: "**Review conclusion: changes are needed before merge.**",
        phase: "final_answer",
      },
    }),
  ].join("\n");

  const result = extractCodexCliFinalAnswer(output);

  assert.equal(result.text, "**Review conclusion: changes are needed before merge.**");
  assert.equal(result.sessionId, "thread-phase");
});

test("prefers task_complete.payload.last_agent_message over event text", () => {
  const output = [
    JSON.stringify({ type: "thread.started", thread_id: "thread-tc" }),
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "agent_message",
        text: "Some intermediate text that should be ignored",
        phase: "commentary",
      },
    }),
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "agent_message",
        text: "Final answer from event",
        phase: "final_answer",
      },
    }),
    JSON.stringify({
      type: "task_complete",
      payload: {
        last_agent_message: "Final answer from task_complete",
      },
    }),
  ].join("\n");

  const result = extractCodexCliFinalAnswer(output);

  assert.equal(result.text, "Final answer from task_complete");
  assert.equal(result.sessionId, "thread-tc");
});

test("returns empty text when only commentary events exist (no final_answer or task_complete)", () => {
  const output = [
    JSON.stringify({ type: "thread.started", thread_id: "thread-commentary-only" }),
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "agent_message",
        text: "Just thinking out loud...",
        phase: "commentary",
      },
    }),
  ].join("\n");

  const result = extractCodexCliFinalAnswer(output);

  assert.equal(result.text, "");
  assert.equal(result.sessionId, "thread-commentary-only");
});

test("task_complete without last_agent_message falls back to filtered events", () => {
  const output = [
    JSON.stringify({ type: "thread.started", thread_id: "thread-tc-no-msg" }),
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "agent_message",
        text: "Final from event",
        phase: "final_answer",
      },
    }),
    JSON.stringify({
      type: "task_complete",
      payload: {},
    }),
  ].join("\n");

  const result = extractCodexCliFinalAnswer(output);

  assert.equal(result.text, "Final from event");
  assert.equal(result.sessionId, "thread-tc-no-msg");
});

test("ignores tool output, stderr, and reconnect events when extracting final answer", () => {
  const output = [
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", aggregated_output: "npm ERR! failed" } }),
    "Reconnecting... 2/5",
    "Reconnecting... 5/5 (request timed out)",
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "The build failed due to a type error." } }),
  ].join("\n");

  const result = extractCodexCliFinalAnswer(output);

  assert.equal(result.text, "The build failed due to a type error.");
});
