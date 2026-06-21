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

test("historySince reads only window-overlapping shards and skips older ones", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-msg-test-"));
  const filePath = path.join(dir, "messages.json");
  const legacy: ChatMessage[] = [
    { id: "msg_000001", kind: "user", content: "jan", createdAt: "2026-01-01T10:00:00.000Z" },
    { id: "msg_000002", kind: "user", content: "feb", createdAt: "2026-02-01T10:00:00.000Z" },
    { id: "msg_000003", kind: "user", content: "jun-19", createdAt: "2026-06-19T10:00:00.000Z" },
    { id: "msg_000004", kind: "user", content: "jun-20", createdAt: "2026-06-20T10:00:00.000Z" },
  ];
  const originalReadFileSync = fs.readFileSync;
  const readShards: string[] = [];
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ messages: legacy, nextId: 5 }, null, 2));

    // Migrate the legacy blob into per-day shards.
    new MessageStore(filePath);

    // historyRead opens the manifest only — no full-shard load/nextId validation.
    const store = new MessageStore(filePath, { historyRead: true });

    fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
      const targetPath = String(args[0]);
      if (targetPath.endsWith(".ndjson")) {
        readShards.push(path.basename(targetPath));
      }
      return originalReadFileSync(...args);
    }) as typeof fs.readFileSync;

    // Window starts 2026-06-15; historySince subtracts a 1-day buffer (cutoff
    // 2026-06-14) so the jan/feb shards must never be opened.
    const messages = store.historySince(Date.parse("2026-06-15T00:00:00.000Z"));

    assert.deepEqual(messages.map((m) => m.content), ["jun-19", "jun-20"]);
    assert.deepEqual(
      readShards.sort(),
      ["2026-06-19.ndjson", "2026-06-20.ndjson"],
      `expected only window shards read, got ${readShards.join(", ")}`,
    );
  } finally {
    fs.readFileSync = originalReadFileSync;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("historySince returns an empty result without reading shards for an inactive conversation", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-msg-test-"));
  const filePath = path.join(dir, "messages.json");
  const legacy: ChatMessage[] = [
    { id: "msg_000001", kind: "user", content: "jan", createdAt: "2026-01-01T10:00:00.000Z" },
    { id: "msg_000002", kind: "user", content: "feb", createdAt: "2026-02-01T10:00:00.000Z" },
  ];
  const originalReadFileSync = fs.readFileSync;
  const readShards: string[] = [];
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ messages: legacy, nextId: 3 }, null, 2));

    new MessageStore(filePath);
    const store = new MessageStore(filePath, { historyRead: true });

    fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
      const targetPath = String(args[0]);
      if (targetPath.endsWith(".ndjson")) {
        readShards.push(path.basename(targetPath));
      }
      return originalReadFileSync(...args);
    }) as typeof fs.readFileSync;

    const messages = store.historySince(Date.parse("2026-06-15T00:00:00.000Z"));

    assert.deepEqual(messages.map((m) => m.content), []);
    assert.deepEqual(readShards, [], "inactive conversation must read no message shards");
  } finally {
    fs.readFileSync = originalReadFileSync;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("listBefore reads only needed shards, not all history", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-msg-test-"));
  const filePath = path.join(dir, "messages.json");
  const legacy: ChatMessage[] = [
    { id: "msg_000001", kind: "user", content: "day 1-a", createdAt: "2026-01-01T10:00:00.000Z" },
    { id: "msg_000002", kind: "user", content: "day 1-b", createdAt: "2026-01-01T11:00:00.000Z" },
    { id: "msg_000003", kind: "user", content: "day 2", createdAt: "2026-01-02T10:00:00.000Z" },
    { id: "msg_000004", kind: "user", content: "day 3", createdAt: "2026-01-03T10:00:00.000Z" },
  ];
  const originalReadFileSync = fs.readFileSync;
  let shardReadCount = 0;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ messages: legacy, nextId: 5 }, null, 2));

    const store = new MessageStore(filePath, { recentShardCount: 1 });

    fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
      const targetPath = String(args[0]);
      if (targetPath.endsWith(".ndjson")) {
        shardReadCount++;
      }
      return originalReadFileSync(...args);
    }) as typeof fs.readFileSync;

    shardReadCount = 0;
    const page = store.listBefore("msg_000004", 1);

    assert.deepEqual(page.messages.map((m) => m.content), ["day 2"]);
    assert.equal(page.hasOlderMessages, true);
    assert.equal(page.olderCursor, "msg_000003");
    assert.ok(shardReadCount <= 2, `expected at most 2 shard reads for limit=1, got ${shardReadCount}`);
  } finally {
    fs.readFileSync = originalReadFileSync;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("listBefore pages across multiple shards with limit larger than one shard", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-msg-test-"));
  const filePath = path.join(dir, "messages.json");
  const legacy: ChatMessage[] = [
    { id: "msg_000001", kind: "user", content: "day 1", createdAt: "2026-01-01T10:00:00.000Z" },
    { id: "msg_000002", kind: "user", content: "day 2-a", createdAt: "2026-01-02T10:00:00.000Z" },
    { id: "msg_000003", kind: "user", content: "day 2-b", createdAt: "2026-01-02T11:00:00.000Z" },
    { id: "msg_000004", kind: "user", content: "day 3", createdAt: "2026-01-03T10:00:00.000Z" },
  ];
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ messages: legacy, nextId: 5 }, null, 2));

    const store = new MessageStore(filePath, { recentShardCount: 1 });

    const page = store.listBefore("msg_000004", 10);
    assert.deepEqual(page.messages.map((m) => m.content), ["day 1", "day 2-a", "day 2-b"]);
    assert.equal(page.hasOlderMessages, false);
    assert.equal(page.olderCursor, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("listBefore with null cursor returns last N messages before end", () => {
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

    const page = store.listBefore(null, 2);
    assert.deepEqual(page.messages.map((m) => m.content), ["day 2", "day 3"]);
    assert.equal(page.hasOlderMessages, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("manifest nextId is auto-corrected when lower than max existing id in shards", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-msg-test-"));
  const filePath = path.join(dir, "messages.json");
  const legacy: ChatMessage[] = [
    { id: "msg_000001", kind: "user", content: "first", createdAt: "2026-01-01T10:00:00.000Z" },
    { id: "msg_000005", kind: "user", content: "fifth", createdAt: "2026-01-01T11:00:00.000Z" },
  ];
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ messages: legacy, nextId: 2 }, null, 2));

    const store = new MessageStore(filePath);
    const newMsg = store.append({ kind: "user", content: "after correction" });
    assert.equal(newMsg.id, "msg_000006", "nextId should be corrected to 6 based on max existing msg_000005");

    const loaded = new MessageStore(filePath);
    const nextNew = loaded.append({ kind: "user", content: "another" });
    assert.equal(nextNew.id, "msg_000007");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("append updates manifest metadata without re-reading shard file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-msg-test-"));
  const filePath = path.join(dir, "messages.json");
  const originalReadFileSync = fs.readFileSync;
  const ndjsonReads: string[] = [];
  try {
    const now = new Date("2026-03-15T12:00:00.000Z");
    const store = new MessageStore(filePath, { now: () => now });

    // Monkey-patch to track .ndjson reads during append
    fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
      const targetPath = String(args[0]);
      if (targetPath.endsWith(".ndjson")) {
        ndjsonReads.push(targetPath);
      }
      return originalReadFileSync(...args);
    }) as typeof fs.readFileSync;

    store.append({ kind: "user", content: "first" });
    ndjsonReads.length = 0; // reset after initial load/migration
    store.append({ kind: "user", content: "second" });

    assert.equal(ndjsonReads.length, 0, "append should not re-read .ndjson shard files");

    // Read back manifest and verify metadata fields
    const manifestPath = path.join(dir, "messages", "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.shards.length, 1, "should have one shard for same-day messages");
    const shard = manifest.shards[0];
    assert.equal(shard.count, 2, "count should be 2");
    assert.ok(shard.bytes > 0, "bytes should be positive");
    assert.equal(shard.firstCreatedAt, "2026-03-15T12:00:00.000Z");
    assert.equal(shard.lastCreatedAt, "2026-03-15T12:00:00.000Z");
  } finally {
    fs.readFileSync = originalReadFileSync;
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

test("persisted store retries transient Windows shard rename failures", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-msg-test-"));
  const filePath = path.join(dir, "messages.json");
  const originalRenameSync = fs.renameSync;
  let shardRenameAttempts = 0;
  try {
    const store = new MessageStore(filePath);
    const msg = store.append({ kind: "agent", agentId: "dev", content: "running", status: "running" });

    fs.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
      if (String(newPath).endsWith(".ndjson")) {
        shardRenameAttempts += 1;
        if (shardRenameAttempts <= 2) {
          const error = new Error("operation not permitted, rename") as NodeJS.ErrnoException;
          error.code = "EPERM";
          throw error;
        }
      }
      return originalRenameSync(oldPath, newPath);
    }) as typeof fs.renameSync;

    store.update(msg.id, { content: "done", status: "done" });

    const loaded = new MessageStore(filePath);
    assert.equal(loaded.get(msg.id)?.content, "done");
    assert.equal(shardRenameAttempts, 3);
  } finally {
    fs.renameSync = originalRenameSync;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("persisted store does not crash when shard rename stays locked", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-msg-test-"));
  const filePath = path.join(dir, "messages.json");
  const originalRenameSync = fs.renameSync;
  const originalWarn = console.warn;
  const warnings: string[] = [];
  try {
    const store = new MessageStore(filePath);
    const msg = store.append({ kind: "agent", agentId: "dev", content: "running", status: "running" });

    fs.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
      if (String(newPath).endsWith(".ndjson")) {
        const error = new Error("operation not permitted, rename") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }
      return originalRenameSync(oldPath, newPath);
    }) as typeof fs.renameSync;
    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };

    assert.doesNotThrow(() => store.update(msg.id, { content: "done", status: "done" }));
    assert.equal(store.get(msg.id)?.content, "done");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /failed to persist message shard/);
  } finally {
    fs.renameSync = originalRenameSync;
    console.warn = originalWarn;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("markAbandonedActiveRuns cancels persisted running and queued messages", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-msg-test-"));
  const filePath = path.join(dir, "messages.json");
  try {
    const store = new MessageStore(filePath, { now: () => new Date("2026-06-13T03:00:00.000Z") });
    const running = store.append({
      kind: "agent",
      agentId: "developer",
      content: "developer is working...",
      status: "running",
      runStatus: "running",
      startedAt: "2026-06-13T02:59:00.000Z",
      activity: [{ type: "status", text: "Run started.", timestamp: "2026-06-13T02:59:00.000Z" }],
    });
    const queued = store.append({
      kind: "agent",
      agentId: "tester",
      content: "tester queued...",
      status: "running",
      runStatus: "queued",
      activity: [{ type: "status", text: "Queued behind the current run.", timestamp: "2026-06-13T02:59:10.000Z" }],
    });
    const done = store.append({ kind: "agent", agentId: "architect", content: "done", status: "done", runStatus: "completed" });

    const abandoned = store.markAbandonedActiveRuns();

    assert.deepEqual(abandoned.map((message) => message.id), [running.id, queued.id]);
    assert.equal(store.get(running.id)?.status, "cancelled");
    assert.equal(store.get(running.id)?.runStatus, "cancelled");
    assert.equal(store.get(running.id)?.completedAt, "2026-06-13T03:00:00.000Z");
    assert.match(store.get(running.id)?.content ?? "", /运行已中断/);
    assert.equal(store.get(queued.id)?.status, "cancelled");
    assert.equal(store.get(queued.id)?.runStatus, "cancelled");
    assert.match(store.get(queued.id)?.content ?? "", /排队任务已取消/);
    assert.equal(store.get(done.id)?.status, "done");

    const reloaded = new MessageStore(filePath);
    assert.equal(reloaded.get(running.id)?.runStatus, "cancelled");
    assert.equal(reloaded.get(queued.id)?.runStatus, "cancelled");
    assert.ok(reloaded.get(running.id)?.activity?.some((event) => "text" in event && event.text.includes("标记为中断")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("markAbandonedActiveRuns updates active runs in older shards", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-msg-test-"));
  const filePath = path.join(dir, "messages.json");
  try {
    const day1 = new MessageStore(filePath, { now: () => new Date("2026-06-12T10:00:00.000Z") });
    const oldRunning = day1.append({
      kind: "agent",
      agentId: "supervisor",
      content: "supervisor is working...",
      status: "running",
      runStatus: "running",
    });

    const day2 = new MessageStore(filePath, { now: () => new Date("2026-06-13T10:00:00.000Z") });
    day2.append({ kind: "user", content: "new day" });
    day2.markAbandonedActiveRuns();

    const reloaded = new MessageStore(filePath, { recentShardCount: 1 });
    const page = reloaded.listBefore(null, 10);
    assert.equal(page.messages.some((message) => message.runStatus === "running"), false);
    assert.equal(reloaded.get(oldRunning.id)?.runStatus, "cancelled");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readShard skips corrupt lines instead of dropping the whole shard", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-msg-test-"));
  const filePath = path.join(dir, "messages.json");
  try {
    const now = new Date("2026-06-20T10:00:00.000Z");
    const store = new MessageStore(filePath, { now: () => now });
    const first = store.append({ kind: "user", content: "good-1" });
    store.append({ kind: "user", content: "middle-will-corrupt" });
    const third = store.append({ kind: "user", content: "good-3" });

    // Corrupt the middle line on disk (simulating a truncated write after a crash)
    const shardPath = path.join(dir, "messages", "2026-06-20.ndjson");
    const lines = fs.readFileSync(shardPath, "utf8").split(/\r?\n/).filter((line) => line.trim().length > 0);
    assert.equal(lines.length, 3);
    const corrupted = [lines[0], "{ this line is not valid json {{{", lines[2]].join(os.EOL) + os.EOL;
    fs.writeFileSync(shardPath, corrupted);

    const reloaded = new MessageStore(filePath, { now: () => now });
    const ids = reloaded.list().map((message) => message.id);
    assert.ok(ids.includes(first.id), "first good line should survive");
    assert.ok(ids.includes(third.id), "third good line should survive");
    assert.equal(reloaded.list().length, 2, "corrupt middle line is skipped, good lines preserved");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("update does not wipe a shard when one of its lines is corrupt", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-msg-test-"));
  const filePath = path.join(dir, "messages.json");
  try {
    const now = new Date("2026-06-20T10:00:00.000Z");
    const store = new MessageStore(filePath, { now: () => now });
    const first = store.append({ kind: "user", content: "good-1" });
    store.append({ kind: "user", content: "middle-will-corrupt" });
    const third = store.append({ kind: "user", content: "good-3" });

    // Corrupt the middle line, then trigger a shard rewrite via update().
    const shardPath = path.join(dir, "messages", "2026-06-20.ndjson");
    const lines = fs.readFileSync(shardPath, "utf8").split(/\r?\n/).filter((line) => line.trim().length > 0);
    const corrupted = [lines[0], "{ corrupt json {{{", lines[2]].join(os.EOL) + os.EOL;
    fs.writeFileSync(shardPath, corrupted);

    assert.doesNotThrow(() => store.update(first.id, { content: "good-1-updated" }));

    const reloaded = new MessageStore(filePath, { now: () => now });
    const reloadedIds = reloaded.list().map((message) => message.id);
    assert.ok(reloadedIds.includes(first.id), "first message survives the rewrite");
    assert.ok(reloadedIds.includes(third.id), "third message survives the rewrite");
    assert.equal(reloaded.get(first.id)?.content, "good-1-updated");
    assert.ok(fs.statSync(shardPath).size > 0, "shard file must not be wiped empty after update");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rewrite refuses to wipe a non-empty shard when all reads fail", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-msg-test-"));
  const filePath = path.join(dir, "messages.json");
  const originalWarn = console.warn;
  const warnings: string[] = [];
  try {
    const now = new Date("2026-06-20T10:00:00.000Z");
    const store = new MessageStore(filePath, { now: () => now });
    const first = store.append({ kind: "user", content: "good-1" });

    // Replace the on-disk shard with fully-corrupt (but non-empty) content.
    // The in-memory copy still exists, so update() will attempt a rewrite.
    const shardPath = path.join(dir, "messages", "2026-06-20.ndjson");
    const corruptContent = "{ totally unparseable garbage that is non-empty }}}";
    fs.writeFileSync(shardPath, corruptContent);

    console.warn = (message?: unknown) => { warnings.push(String(message)); };

    // readShard() returns [] (all corrupt), so writeShard would write empty.
    // The guard must refuse and preserve the non-empty file.
    assert.doesNotThrow(() => store.update(first.id, { content: "updated" }));

    assert.equal(fs.readFileSync(shardPath, "utf8"), corruptContent, "non-empty corrupt shard must be preserved, not wiped");
    assert.ok(warnings.some((warning) => /shard/i.test(warning)), `expected a guard warning, got: ${warnings.join("; ")}`);
  } finally {
    console.warn = originalWarn;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
