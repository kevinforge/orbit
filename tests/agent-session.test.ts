import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentSession } from "../src/core/agent-session.ts";
import { EventBus } from "../src/core/event-bus.ts";
import { SessionStore } from "../src/core/session-store.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "orbit-agent-session-test-"));
}

function makeSession(store: SessionStore): AgentSession {
  return new AgentSession({
    id: "developer",
    label: "Developer",
    cwd: process.cwd(),
    eventBus: new EventBus(),
    sessionStore: store,
    channelId: "default",
    conversationId: "default",
  });
}

test("send without prior session — no resume flag, session persisted", async () => {
  const dir = tmpDir();
  const store = new SessionStore(dir);
  const session = makeSession(store);
  session.start();

  assert.equal(store.load("default", "default", "developer"), null);
  assert.equal(session.getStatus(), "idle");
});

test("send with prior session — resume flag passed", () => {
  const dir = tmpDir();
  const store = new SessionStore(dir);
  store.save("default", "default", "developer", {
    agentId: "developer",
    channelId: "default",
    sessionId: "existing-sess",
    lastRunAt: new Date().toISOString(),
    runCount: 3,
  });

  const session = makeSession(store);
  session.start();

  const loaded = store.load("default", "default", "developer");
  assert.equal(loaded!.sessionId, "existing-sess");
  assert.equal(loaded!.runCount, 3);
});

test("resume failure clears and retries — store cleared after session-not-found", () => {
  const dir = tmpDir();
  const store = new SessionStore(dir);
  store.save("default", "default", "developer", {
    agentId: "developer",
    channelId: "default",
    sessionId: "bad-session",
    lastRunAt: new Date().toISOString(),
    runCount: 1,
  });

  store.clear("default", "default", "developer");
  assert.equal(store.load("default", "default", "developer"), null);
});

test("non-resume failure does not clear store", () => {
  const dir = tmpDir();
  const store = new SessionStore(dir);
  store.save("default", "default", "developer", {
    agentId: "developer",
    channelId: "default",
    sessionId: "good-session",
    lastRunAt: new Date().toISOString(),
    runCount: 1,
  });

  const loaded = store.load("default", "default", "developer");
  assert.equal(loaded!.sessionId, "good-session");
});

test("persistSession increments runCount", () => {
  const dir = tmpDir();
  const store = new SessionStore(dir);
  store.save("default", "default", "developer", {
    agentId: "developer",
    channelId: "default",
    sessionId: "sess-1",
    lastRunAt: new Date().toISOString(),
    runCount: 1,
  });

  const prev = store.load("default", "default", "developer");
  store.save("default", "default", "developer", {
    agentId: "developer",
    channelId: "default",
    sessionId: "sess-2",
    lastRunAt: new Date().toISOString(),
    runCount: (prev?.runCount ?? 0) + 1,
  });

  const updated = store.load("default", "default", "developer");
  assert.equal(updated!.runCount, 2);
  assert.equal(updated!.sessionId, "sess-2");
});

test("different conversations use independent sessions", () => {
  const dir = tmpDir();
  const store = new SessionStore(dir);

  const sessionA = new AgentSession({
    id: "developer",
    label: "Developer",
    cwd: process.cwd(),
    eventBus: new EventBus(),
    sessionStore: store,
    channelId: "default",
    conversationId: "conv-a",
  });

  const sessionB = new AgentSession({
    id: "developer",
    label: "Developer",
    cwd: process.cwd(),
    eventBus: new EventBus(),
    sessionStore: store,
    channelId: "default",
    conversationId: "conv-b",
  });

  sessionA.start();
  sessionB.start();

  store.save("default", "conv-a", "developer", {
    agentId: "developer",
    channelId: "default",
    sessionId: "sess-a",
    lastRunAt: new Date().toISOString(),
    runCount: 1,
  });

  store.save("default", "conv-b", "developer", {
    agentId: "developer",
    channelId: "default",
    sessionId: "sess-b",
    lastRunAt: new Date().toISOString(),
    runCount: 1,
  });

  assert.equal(store.load("default", "conv-a", "developer")!.sessionId, "sess-a");
  assert.equal(store.load("default", "conv-b", "developer")!.sessionId, "sess-b");
});
