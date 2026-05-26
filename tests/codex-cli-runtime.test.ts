import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildCodexCliArgs,
  buildCodexCliCommand,
  codexHomeForAgent,
  createCodexEnv,
  extractCodexCliFinalAnswer,
  extractCodexSessionId,
  prepareCodexHome,
} from "../src/core/codex-cli-runtime.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "orbit-codex-runtime-test-"));
}

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
  const command = buildCodexCliCommand({ cwd: "D:/workspace" });

  assert.ok(command.file.length > 0);
  assert.ok(command.args.includes("exec"));
});

test("creates isolated Codex homes per agent", () => {
  assert.equal(
    codexHomeForAgent("D:/workspace", "pm"),
    path.join("D:/workspace", ".orbit", "runtimes", "codex", "pm"),
  );
  assert.equal(
    codexHomeForAgent("D:/workspace", "architect"),
    path.join("D:/workspace", ".orbit", "runtimes", "codex", "architect"),
  );
});

test("Codex env uses agent-specific CODEX_HOME and bootstraps auth files", () => {
  const cwd = tmpDir();
  const sourceHome = tmpDir();
  fs.writeFileSync(path.join(sourceHome, "auth.json"), "{\"token\":\"test\"}");
  fs.writeFileSync(path.join(sourceHome, "config.toml"), "model = \"test\"");
  fs.mkdirSync(path.join(sourceHome, "sessions"));
  fs.writeFileSync(path.join(sourceHome, "sessions", "shared.json"), "{}");

  const env = createCodexEnv("pm", cwd, { CODEX_HOME: sourceHome });
  const targetHome = path.join(cwd, ".orbit", "runtimes", "codex", "pm");

  assert.equal(env.CODEX_HOME, targetHome);
  assert.equal(env.ORBIT_AGENT_ID, "pm");
  assert.equal(env.CODEX_AGENT_ID, "pm");
  assert.equal(fs.readFileSync(path.join(targetHome, "auth.json"), "utf8"), "{\"token\":\"test\"}");
  assert.equal(fs.readFileSync(path.join(targetHome, "config.toml"), "utf8"), "model = \"test\"");
  assert.equal(fs.existsSync(path.join(targetHome, "sessions", "shared.json")), false);
});

test("prepareCodexHome preserves newer target auth files", () => {
  const sourceHome = tmpDir();
  const targetHome = tmpDir();
  const sourceAuth = path.join(sourceHome, "auth.json");
  const targetAuth = path.join(targetHome, "auth.json");
  fs.writeFileSync(sourceAuth, "source");
  fs.writeFileSync(targetAuth, "target");

  const now = Date.now();
  fs.utimesSync(sourceAuth, new Date(now - 10_000), new Date(now - 10_000));
  fs.utimesSync(targetAuth, new Date(now), new Date(now));

  prepareCodexHome(sourceHome, targetHome);

  assert.equal(fs.readFileSync(targetAuth, "utf8"), "target");
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
