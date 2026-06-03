import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MessageStore } from "../src/core/message-store.ts";
import type { ChatMessage } from "../src/shared/types.ts";

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

test("persisted store migrates legacy messages.json into date shards", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-msg-test-"));
  const filePath = path.join(dir, "messages.json");
  const legacy: ChatMessage[] = [
    { id: "msg_000001", kind: "user", content: "old", createdAt: "2026-01-01T10:00:00.000Z" },
    { id: "msg_000002", kind: "agent", agentId: "dev", content: "new", createdAt: "2026-01-02T10:00:00.000Z", status: "done" },
  ];
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ messages: legacy, nextId: 3 }, null, 2));

    const store = new MessageStore(filePath);

    assert.deepEqual(store.list().map((m) => m.id), ["msg_000001", "msg_000002"]);
    assert.ok(fs.existsSync(path.join(dir, "messages", "2026-01-01.ndjson")));
    assert.ok(fs.existsSync(path.join(dir, "messages", "2026-01-02.ndjson")));

    const appended = store.append({ kind: "user", content: "after migration" });
    assert.equal(appended.id, "msg_000003");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("persisted store loads only recent shards and pages older messages", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-msg-test-"));
  const filePath = path.join(dir, "messages.json");
  const legacy: ChatMessage[] = [
    { id: "msg_000001", kind: "user", content: "day 1", createdAt: "2026-01-01T10:00:00.000Z" },
    { id: "msg_000002", kind: "user", content: "day 2", createdAt: "2026-01-02T10:00:00.000Z" },
    { id: "msg_000003", kind: "user", content: "day 3", createdAt: "2026-01-03T10:00:00.000Z" },
  ];
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ messages: legacy, nextId: 4 }, null, 2));

    const store = new MessageStore(filePath, { recentShardCount: 1 });

    assert.deepEqual(store.list().map((m) => m.content), ["day 3"]);
    assert.deepEqual(store.historyState(), { hasOlderMessages: true, olderCursor: "msg_000003" });

    const page = store.listBefore("msg_000003", 2);
    assert.deepEqual(page.messages.map((m) => m.content), ["day 1", "day 2"]);
    assert.equal(page.hasOlderMessages, false);
    assert.equal(page.olderCursor, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("historyState uses shard metadata without reading older shard files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-msg-test-"));
  const filePath = path.join(dir, "messages.json");
  const legacy: ChatMessage[] = [
    { id: "msg_000001", kind: "user", content: "day 1", createdAt: "2026-01-01T10:00:00.000Z" },
    { id: "msg_000002", kind: "user", content: "day 2", createdAt: "2026-01-02T10:00:00.000Z" },
    { id: "msg_000003", kind: "user", content: "day 3", createdAt: "2026-01-03T10:00:00.000Z" },
  ];
  const originalReadFileSync = fs.readFileSync;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ messages: legacy, nextId: 4 }, null, 2));

    const store = new MessageStore(filePath, { recentShardCount: 1 });
    fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
      const targetPath = String(args[0]);
      if (targetPath.includes("2026-01-01.ndjson") || targetPath.includes("2026-01-02.ndjson")) {
        throw new Error("older shard should not be read");
      }
      return originalReadFileSync(...args);
    }) as typeof fs.readFileSync;

    assert.deepEqual(store.historyState(), { hasOlderMessages: true, olderCursor: "msg_000003" });
  } finally {
    fs.readFileSync = originalReadFileSync;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("persisted store updates messages outside the recent shard", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-msg-test-"));
  const filePath = path.join(dir, "messages.json");
  const legacy: ChatMessage[] = [
    { id: "msg_000001", kind: "user", content: "older", createdAt: "2026-01-01T10:00:00.000Z" },
    { id: "msg_000002", kind: "user", content: "recent", createdAt: "2026-01-02T10:00:00.000Z" },
  ];
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ messages: legacy, nextId: 3 }, null, 2));

    const store = new MessageStore(filePath, { recentShardCount: 1 });
    const updated = store.update("msg_000001", { content: "updated older" });

    assert.equal(updated.content, "updated older");
    const reloaded = new MessageStore(filePath, { recentShardCount: 2 });
    assert.equal(reloaded.get("msg_000001")?.content, "updated older");
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
    assert.ok(fs.existsSync(path.join(path.dirname(filePath), "messages", `${msg.createdAt.slice(0, 10)}.ndjson`)));
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

    const shard = fs.readdirSync(path.join(dir, "messages")).find((entry) => entry.endsWith(".ndjson"));
    assert.ok(shard);
    const raw = fs.readFileSync(path.join(dir, "messages", shard), "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);

    const msgLines = lines.filter((l) => l.includes('"kind"'));
    assert.equal(msgLines.length, 2, "each message should be on its own line");

    for (const line of msgLines) {
      const parsed = JSON.parse(line);
      assert.ok(parsed.kind, "line should be a message object");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
