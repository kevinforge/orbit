import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MessageStore } from "../src/core/message-store.ts";

test("append creates sequential message ids", () => {
  const store = new MessageStore();

  const first = store.append({ kind: "user", content: "@agent1 hello" });
  const second = store.append({ kind: "system", content: "ok" });

  assert.equal(first.id, "msg_000001");
  assert.equal(second.id, "msg_000002");
});

test("update replaces selected fields without changing id or createdAt", () => {
  const store = new MessageStore();
  const message = store.append({ kind: "agent", agentId: "agent1", content: "running", status: "running" });

  const updated = store.update(message.id, { content: "done", status: "done" });

  assert.equal(updated?.id, message.id);
  assert.equal(updated?.createdAt, message.createdAt);
  assert.equal(updated?.content, "done");
  assert.equal(updated?.status, "done");
});

test("list returns messages in insertion order as a copy", () => {
  const store = new MessageStore();
  store.append({ kind: "user", content: "one" });
  store.append({ kind: "system", content: "two" });

  const listed = store.list();
  listed.pop();

  assert.deepEqual(store.list().map((message) => message.content), ["one", "two"]);
});

test("get returns message by id or null", () => {
  const store = new MessageStore();
  const msg = store.append({ kind: "user", content: "hello" });

  assert.equal(store.get(msg.id)?.content, "hello");
  assert.equal(store.get("nonexistent"), null);
});

test("markRouteState updates route state and returns the message", () => {
  const store = new MessageStore();
  const msg = store.append({ kind: "user", content: "@agent1 hello" });

  const updated = store.markRouteState(msg.id, "routed");
  assert.equal(updated?.routeState, "routed");
  assert.equal(store.get(msg.id)?.routeState, "routed");
});

test("markRouteState returns null for unknown id", () => {
  const store = new MessageStore();
  assert.equal(store.markRouteState("nonexistent", "routed"), null);
});

test("append preserves routing metadata", () => {
  const store = new MessageStore();
  const msg = store.append({
    kind: "agent",
    agentId: "agent1",
    content: "done",
    parentMessageId: "msg_000000",
    routeDepth: 2,
  });

  assert.equal(msg.parentMessageId, "msg_000000");
  assert.equal(msg.routeDepth, 2);
});

test("persisted store round-trips messages to file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-msg-test-"));
  const filePath = path.join(dir, "messages.json");
  try {
    const store = new MessageStore(filePath);
    store.append({ kind: "user", content: "hello" });
    store.append({ kind: "agent", agentId: "dev", content: "response", status: "done" });

    const loaded = new MessageStore(filePath);
    const msgs = loaded.list();
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].content, "hello");
    assert.equal(msgs[1].content, "response");
    assert.equal(msgs[1].agentId, "dev");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("persisted store preserves nextId after reload", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-msg-test-"));
  const filePath = path.join(dir, "messages.json");
  try {
    const store = new MessageStore(filePath);
    store.append({ kind: "user", content: "first" });

    const loaded = new MessageStore(filePath);
    const newMsg = loaded.append({ kind: "user", content: "second" });
    assert.equal(newMsg.id, "msg_000002");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("persisted store saves on update and markRouteState", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-msg-test-"));
  const filePath = path.join(dir, "messages.json");
  try {
    const store = new MessageStore(filePath);
    const msg = store.append({ kind: "user", content: "test" });

    store.update(msg.id, { content: "updated" });

    const loaded1 = new MessageStore(filePath);
    assert.equal(loaded1.get(msg.id)?.content, "updated");

    loaded1.markRouteState(msg.id, "routed");

    const loaded2 = new MessageStore(filePath);
    assert.equal(loaded2.get(msg.id)?.routeState, "routed");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("persisted store handles missing file gracefully", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-msg-test-"));
  const filePath = path.join(dir, "nonexistent", "messages.json");
  try {
    const store = new MessageStore(filePath);
    const msg = store.append({ kind: "user", content: "creates dirs" });
    assert.equal(msg.id, "msg_000001");
    assert.ok(fs.existsSync(filePath));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("persisted store handles corrupted file gracefully", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-msg-test-"));
  const filePath = path.join(dir, "messages.json");
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, "not valid json{{");
    const store = new MessageStore(filePath);
    assert.equal(store.list().length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("different file paths keep messages isolated", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-msg-test-"));
  const fileA = path.join(dir, "a", "messages.json");
  const fileB = path.join(dir, "b", "messages.json");
  try {
    const storeA = new MessageStore(fileA);
    const storeB = new MessageStore(fileB);

    storeA.append({ kind: "user", content: "workspace A" });
    storeB.append({ kind: "user", content: "workspace B" });

    const loadedA = new MessageStore(fileA);
    const loadedB = new MessageStore(fileB);
    assert.equal(loadedA.list().length, 1);
    assert.equal(loadedA.list()[0].content, "workspace A");
    assert.equal(loadedB.list().length, 1);
    assert.equal(loadedB.list()[0].content, "workspace B");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("persisted store writes each message on its own line", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-msg-test-"));
  const filePath = path.join(dir, "messages.json");
  try {
    const store = new MessageStore(filePath);
    store.append({ kind: "user", content: "first" });
    store.append({ kind: "agent", agentId: "dev", content: "second", status: "done" });

    const raw = fs.readFileSync(filePath, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);

    // Should have: {"messages": [, <msg1>, <msg2>, ], "nextId": ...}
    // At minimum the two message objects must each appear on their own line
    const msgLines = lines.filter((l) => l.includes('"kind"'));
    assert.equal(msgLines.length, 2, "each message should be on its own line");

    // Each message line should be valid JSON
    for (const line of msgLines) {
      const parsed = JSON.parse(line.trimEnd().replace(/,$/, ""));
      assert.ok(parsed.kind, "line should be a message object");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
