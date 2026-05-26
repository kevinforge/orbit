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
  assert.equal(store.load("default", "default", "pm"), null);
});

test("save then load round-trips", () => {
  const dir = tmpDir();
  const store = new SessionStore(dir);
  const record = {
    agentId: "pm",
    channelId: "default",
    sessionId: "sess-123",
    lastRunAt: new Date().toISOString(),
    runCount: 1,
  };

  store.save("default", "default", "pm", record);
  const loaded = store.load("default", "default", "pm");

  assert.deepEqual(loaded, record);
});

test("save creates directories", () => {
  const dir = path.join(tmpDir(), "nested", "deep");
  const store = new SessionStore(dir);

  store.save("default", "default", "developer", {
    agentId: "developer",
    channelId: "default",
    sessionId: "s1",
    lastRunAt: new Date().toISOString(),
    runCount: 1,
  });

  assert.ok(fs.existsSync(path.join(dir, "default", "default", "developer.json")));
});

test("clear removes the file", () => {
  const dir = tmpDir();
  const store = new SessionStore(dir);

  store.save("default", "default", "architect", {
    agentId: "architect",
    channelId: "default",
    sessionId: "s2",
    lastRunAt: new Date().toISOString(),
    runCount: 1,
  });

  store.clear("default", "default", "architect");
  assert.equal(store.load("default", "default", "architect"), null);
});

test("save overwrites previous", () => {
  const dir = tmpDir();
  const store = new SessionStore(dir);

  store.save("default", "default", "tester", {
    agentId: "tester",
    channelId: "default",
    sessionId: "old",
    lastRunAt: new Date().toISOString(),
    runCount: 1,
  });

  store.save("default", "default", "tester", {
    agentId: "tester",
    channelId: "default",
    sessionId: "new",
    lastRunAt: new Date().toISOString(),
    runCount: 2,
  });

  const loaded = store.load("default", "default", "tester");
  assert.equal(loaded!.sessionId, "new");
  assert.equal(loaded!.runCount, 2);
});

test("custom baseDir is used", () => {
  const dir = tmpDir();
  const store = new SessionStore(dir);

  store.save("ch1", "conv1", "pm", {
    agentId: "pm",
    channelId: "ch1",
    sessionId: "s3",
    lastRunAt: new Date().toISOString(),
    runCount: 1,
  });

  const expectedPath = path.join(dir, "ch1", "conv1", "pm.json");
  assert.ok(fs.existsSync(expectedPath));
});

test("different conversations for the same agent are independent", () => {
  const dir = tmpDir();
  const store = new SessionStore(dir);

  store.save("default", "conv-a", "developer", {
    agentId: "developer",
    channelId: "default",
    sessionId: "sess-conv-a",
    lastRunAt: new Date().toISOString(),
    runCount: 1,
  });

  store.save("default", "conv-b", "developer", {
    agentId: "developer",
    channelId: "default",
    sessionId: "sess-conv-b",
    lastRunAt: new Date().toISOString(),
    runCount: 1,
  });

  assert.equal(store.load("default", "conv-a", "developer")!.sessionId, "sess-conv-a");
  assert.equal(store.load("default", "conv-b", "developer")!.sessionId, "sess-conv-b");
});
