import assert from "node:assert/strict";
import test from "node:test";

import { buildHistoryForAgent, MAX_HISTORY_CHARS, MAX_ENTRY_CHARS } from "../src/core/channel-history.ts";
import type { ChatMessage } from "../src/shared/types.ts";

function msg(overrides: Partial<ChatMessage> & { kind: ChatMessage["kind"]; content: string }): ChatMessage {
  return {
    id: `msg_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

test("first run with no prior done returns all non-system/running/routed messages", () => {
  const messages: ChatMessage[] = [
    msg({ kind: "user", content: "hello" }),
    msg({ kind: "system", content: "system msg", status: "done" }),
    msg({ kind: "agent", agentId: "architect", content: "arch reply", status: "done" }),
    msg({ kind: "user", content: "next request" }),
  ];

  const history = buildHistoryForAgent("developer", messages);
  assert.equal(history.length, 3);
  assert.equal(history[0].sender, "user");
  assert.equal(history[0].content, "hello");
  assert.equal(history[1].sender, "architect");
  assert.equal(history[1].content, "arch reply");
  assert.equal(history[2].sender, "user");
  assert.equal(history[2].content, "next request");
});

test("with prior done, only returns messages after that point", () => {
  const messages: ChatMessage[] = [
    msg({ kind: "user", content: "first request" }),
    msg({ kind: "agent", agentId: "developer", content: "old reply", status: "done" }),
    msg({ kind: "user", content: "second request" }),
    msg({ kind: "agent", agentId: "architect", content: "arch reply", status: "done" }),
    msg({ kind: "user", content: "third request" }),
  ];

  const history = buildHistoryForAgent("developer", messages);
  assert.equal(history.length, 3);
  assert.equal(history[0].content, "second request");
  assert.equal(history[1].content, "arch reply");
  assert.equal(history[2].content, "third request");
});

test("different agents have independent cutoff points", () => {
  const messages: ChatMessage[] = [
    msg({ kind: "user", content: "req 1" }),
    msg({ kind: "agent", agentId: "developer", content: "dev done", status: "done" }),
    msg({ kind: "agent", agentId: "architect", content: "arch done", status: "done" }),
    msg({ kind: "user", content: "req 2" }),
  ];

  const devHistory = buildHistoryForAgent("developer", messages);
  const archHistory = buildHistoryForAgent("architect", messages);

  assert.equal(devHistory.length, 2);
  assert.equal(devHistory[0].content, "arch done");
  assert.equal(devHistory[1].content, "req 2");

  assert.equal(archHistory.length, 1);
  assert.equal(archHistory[0].content, "req 2");
});

test("filters out system, running, and routed agent messages but keeps routed user messages", () => {
  const messages: ChatMessage[] = [
    msg({ kind: "user", content: "user msg" }),
    msg({ kind: "system", content: "sys msg", status: "done" }),
    msg({ kind: "agent", agentId: "pm", content: "pm running", status: "running" }),
    msg({ kind: "user", content: "routed user msg", routeState: "routed" }),
    msg({ kind: "agent", agentId: "pm", content: "routed agent msg", routeState: "routed", status: "done" }),
    msg({ kind: "agent", agentId: "architect", content: "arch done", status: "done" }),
  ];

  const history = buildHistoryForAgent("developer", messages);
  assert.equal(history.length, 3);
  assert.equal(history[0].content, "user msg");
  assert.equal(history[1].content, "routed user msg");
  assert.equal(history[2].content, "arch done");
});

test("truncates total history to MAX_HISTORY_CHARS", () => {
  const messages: ChatMessage[] = [];
  const chunkSize = 400;
  const chunkCount = Math.ceil(MAX_HISTORY_CHARS / chunkSize) + 2;

  for (let i = 0; i < chunkCount; i++) {
    messages.push(msg({ kind: "user", content: "x".repeat(chunkSize) }));
  }

  const history = buildHistoryForAgent("developer", messages);
  const totalChars = history.reduce((sum, e) => sum + e.content.length, 0);
  assert.ok(totalChars <= MAX_HISTORY_CHARS, `total ${totalChars} exceeds ${MAX_HISTORY_CHARS}`);
  assert.ok(history.length < chunkCount, "should have truncated some entries");
});

test("truncates single entry to MAX_ENTRY_CHARS", () => {
  const messages: ChatMessage[] = [
    msg({ kind: "user", content: "a".repeat(1000) }),
  ];

  const history = buildHistoryForAgent("developer", messages);
  assert.equal(history.length, 1);
  assert.equal(history[0].content.length, MAX_ENTRY_CHARS);
});
