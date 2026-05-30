import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ConversationStore } from "../src/core/conversation-store.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "orbit-conv-test-"));
}

test("create returns a conversation with generated id and timestamps", () => {
  const dir = tmpDir();
  const store = new ConversationStore(dir);
  const conv = store.create("ws1", "My Conversation");

  assert.ok(conv.id.startsWith("conv_"), `id should start with conv_, got ${conv.id}`);
  assert.equal(conv.workspaceId, "ws1");
  assert.equal(conv.name, "My Conversation");
  assert.ok(conv.createdAt);
  assert.ok(conv.lastOpenedAt);
});

test("list returns conversations for a workspace sorted by lastOpenedAt descending", () => {
  const dir = tmpDir();
  const store = new ConversationStore(dir);
  store.create("ws1", "First");
  const second = store.create("ws1", "Second");

  // Touch first to make it more recent
  const first = store.list("ws1").find((c) => c.name === "First")!;
  store.touchLastOpened("ws1", first.id);

  const list = store.list("ws1");
  assert.equal(list.length, 2);
  assert.equal(list[0].id, first.id, "most recently opened should be first");
  assert.equal(list[1].id, second.id);
});

test("list returns empty array for workspace with no conversations", () => {
  const dir = tmpDir();
  const store = new ConversationStore(dir);
  assert.deepEqual(store.list("ws1"), []);
});

test("list isolates conversations by workspace", () => {
  const dir = tmpDir();
  const store = new ConversationStore(dir);
  store.create("ws1", "WS1 Conv");
  store.create("ws2", "WS2 Conv");

  assert.equal(store.list("ws1").length, 1);
  assert.equal(store.list("ws2").length, 1);
  assert.equal(store.list("ws1")[0].name, "WS1 Conv");
});

test("get returns a conversation by id", () => {
  const dir = tmpDir();
  const store = new ConversationStore(dir);
  const created = store.create("ws1", "Find Me");

  const result = store.get("ws1", created.id);
  assert.ok(result);
  assert.equal(result!.name, "Find Me");
});

test("get returns null for unknown id", () => {
  const dir = tmpDir();
  const store = new ConversationStore(dir);
  assert.equal(store.get("ws1", "conv_nonexistent"), null);
});

test("update renames a conversation", () => {
  const dir = tmpDir();
  const store = new ConversationStore(dir);
  const conv = store.create("ws1", "Old Name");

  const updated = store.update("ws1", conv.id, { name: "New Name" });
  assert.equal(updated.name, "New Name");

  const reloaded = store.get("ws1", conv.id);
  assert.equal(reloaded!.name, "New Name");
});

test("update throws for unknown id", () => {
  const dir = tmpDir();
  const store = new ConversationStore(dir);
  assert.throws(() => store.update("ws1", "conv_nonexistent", { name: "X" }), /not found/);
});

test("delete removes a conversation", () => {
  const dir = tmpDir();
  const store = new ConversationStore(dir);
  const conv = store.create("ws1", "Delete Me");

  store.delete("ws1", conv.id);

  assert.equal(store.get("ws1", conv.id), null);
  assert.equal(store.list("ws1").length, 0);
});

test("delete throws for unknown id", () => {
  const dir = tmpDir();
  const store = new ConversationStore(dir);
  assert.throws(() => store.delete("ws1", "conv_nonexistent"), /not found/);
});

test("touchLastOpened updates lastOpenedAt", () => {
  const dir = tmpDir();
  const store = new ConversationStore(dir);
  const conv = store.create("ws1", "Touch");

  const before = store.get("ws1", conv.id)!;
  // Small delay to ensure different timestamp
  const start = Date.now();
  while (Date.now() === start) { /* spin */ }

  store.touchLastOpened("ws1", conv.id);
  const after = store.get("ws1", conv.id)!;

  assert.equal(before.id, after.id);
  assert.notEqual(after.lastOpenedAt, before.lastOpenedAt);
});

test("ensureDefault creates default conversation when none exist", () => {
  const dir = tmpDir();
  const store = new ConversationStore(dir);

  const conv = store.ensureDefault("ws1");
  assert.equal(conv.id, "default");
  assert.equal(conv.name, "Default");
  assert.equal(store.list("ws1").length, 1);
});

test("ensureDefault is a no-op when conversations already exist", () => {
  const dir = tmpDir();
  const store = new ConversationStore(dir);
  store.create("ws1", "Existing");

  const conv = store.ensureDefault("ws1");
  assert.equal(conv.name, "Existing");
  assert.equal(store.list("ws1").length, 1, "should not create a second conversation");
});

test("data persists across store instances", () => {
  const dir = tmpDir();
  const store1 = new ConversationStore(dir);
  const created = store1.create("ws1", "Persist Me");

  const store2 = new ConversationStore(dir);
  const list = store2.list("ws1");
  assert.equal(list.length, 1);
  assert.equal(list[0].id, created.id);
  assert.equal(list[0].name, "Persist Me");
});
