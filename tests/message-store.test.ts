import test from "node:test";
import assert from "node:assert/strict";

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
