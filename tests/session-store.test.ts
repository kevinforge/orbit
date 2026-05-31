import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SessionStore } from "../src/core/session-store.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "orbit-session-test-"));
}

test("load returns null for missing file", () => {
  const store = new SessionStore(tmpDir());
  assert.equal(store.load("claude-code", "default", "pm"), null);
});

test("save then load round-trips", () => {
  const dir = tmpDir();
  const store = new SessionStore(dir);
  const record = {
    agentId: "pm",
    runtime: "claude-code" as const,
    sessionId: "sess-123",
    lastRunAt: new Date().toISOString(),
    runCount: 1,
  };

  store.save("claude-code", "default", "pm", record);
  const loaded = store.load("claude-code", "default", "pm");

  assert.deepEqual(loaded, record);
});

test("save creates directories", () => {
  const dir = path.join(tmpDir(), "nested", "deep");
  const store = new SessionStore(dir);

  store.save("claude-code", "default", "developer", {
    agentId: "developer",
    runtime: "claude-code",
    sessionId: "s1",
    lastRunAt: new Date().toISOString(),
    runCount: 1,
  });

  assert.ok(fs.existsSync(path.join(dir, "claude-code", "default", "developer.json")));
});

test("clear removes the file", () => {
  const dir = tmpDir();
  const store = new SessionStore(dir);

  store.save("claude-code", "default", "architect", {
    agentId: "architect",
    runtime: "claude-code",
    sessionId: "s2",
    lastRunAt: new Date().toISOString(),
    runCount: 1,
  });

  store.clear("claude-code", "default", "architect");
  assert.equal(store.load("claude-code", "default", "architect"), null);
});

test("save overwrites previous", () => {
  const dir = tmpDir();
  const store = new SessionStore(dir);

  store.save("claude-code", "default", "tester", {
    agentId: "tester",
    runtime: "claude-code",
    sessionId: "old",
    lastRunAt: new Date().toISOString(),
    runCount: 1,
  });

  store.save("claude-code", "default", "tester", {
    agentId: "tester",
    runtime: "claude-code",
    sessionId: "new",
    lastRunAt: new Date().toISOString(),
    runCount: 2,
  });

  const loaded = store.load("claude-code", "default", "tester");
  assert.equal(loaded!.sessionId, "new");
  assert.equal(loaded!.runCount, 2);
});

test("different conversations for the same agent are independent", () => {
  const dir = tmpDir();
  const store = new SessionStore(dir);

  store.save("claude-code", "conv-a", "developer", {
    agentId: "developer",
    runtime: "claude-code",
    sessionId: "sess-conv-a",
    lastRunAt: new Date().toISOString(),
    runCount: 1,
  });

  store.save("claude-code", "conv-b", "developer", {
    agentId: "developer",
    runtime: "claude-code",
    sessionId: "sess-conv-b",
    lastRunAt: new Date().toISOString(),
    runCount: 1,
  });

  assert.equal(store.load("claude-code", "conv-a", "developer")!.sessionId, "sess-conv-a");
  assert.equal(store.load("claude-code", "conv-b", "developer")!.sessionId, "sess-conv-b");
});

test("different runtimes for the same agent are independent", () => {
  const dir = tmpDir();
  const store = new SessionStore(dir);

  store.save("claude-code", "default", "developer", {
    agentId: "developer",
    runtime: "claude-code",
    sessionId: "claude-session",
    lastRunAt: new Date().toISOString(),
    runCount: 1,
  });

  store.save("codebuddy", "default", "developer", {
    agentId: "developer",
    runtime: "codebuddy",
    sessionId: "codebuddy-session",
    lastRunAt: new Date().toISOString(),
    runCount: 1,
  });

  assert.equal(store.load("claude-code", "default", "developer")!.sessionId, "claude-session");
  assert.equal(store.load("codebuddy", "default", "developer")!.sessionId, "codebuddy-session");
});
