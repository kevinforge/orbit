import assert from "node:assert/strict";
import test from "node:test";

import { buildHistoryForAgent, MAX_HISTORY_CHARS, RECENT_UNTRUNCATED_COUNT } from "../src/core/agent-history-builder.ts";
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

test("recent RECENT_UNTRUNCATED_COUNT entries are kept in full even if long", () => {
  // Use messages that fit within budget: 6 * ~800 = ~4800 < MAX_HISTORY_CHARS
  const longContent = "a".repeat(800); // above old 500-char cap, fits budget
  const messages: ChatMessage[] = [];
  for (let i = 0; i < RECENT_UNTRUNCATED_COUNT; i++) {
    messages.push(msg({ kind: "user", content: `${i}: ${longContent}` }));
  }

  const history = buildHistoryForAgent("developer", messages);
  assert.equal(history.length, RECENT_UNTRUNCATED_COUNT, "all recent entries should be included");
  for (let i = 0; i < history.length; i++) {
    assert.ok(history[i].content.includes(longContent), `entry ${i} should be untruncated`);
  }
});

test("older entries beyond RECENT_UNTRUNCATED_COUNT get truncated with marker", () => {
  // Use smaller messages so the recent group fits within budget
  const totalMessages = RECENT_UNTRUNCATED_COUNT + 5;
  const longContent = "b".repeat(800);
  const messages: ChatMessage[] = [];
  for (let i = 0; i < totalMessages; i++) {
    messages.push(msg({ kind: "user", content: `msg_${i}: ${longContent}` }));
  }

  const history = buildHistoryForAgent("developer", messages);
  // The oldest entries (index 0, 1, ...) should be truncated and have a marker
  const olderEntries = history.slice(0, history.length - RECENT_UNTRUNCATED_COUNT);
  for (const entry of olderEntries) {
    assert.ok(
      entry.content.includes("[truncated: original message was"),
      `older entry should have truncation marker, got: ${entry.content.slice(-80)}`
    );
  }
  // The newest entries should NOT have truncation marker
  const recentEntries = history.slice(history.length - RECENT_UNTRUNCATED_COUNT);
  for (const entry of recentEntries) {
    assert.ok(!entry.content.includes("[truncated:"), `recent entry should not be truncated: ${entry.content.slice(0, 40)}`);
  }
});

test("recent user assignment is not truncated", () => {
  const longAssignment = "@developer: " + "x".repeat(2000);
  const messages: ChatMessage[] = [
    msg({ kind: "user", content: longAssignment }),
  ];

  const history = buildHistoryForAgent("developer", messages);
  assert.equal(history.length, 1);
  assert.equal(history[0].content, longAssignment, "recent user assignment must be kept in full");
});

test("long UX/review message from another agent passes through untruncated when recent", () => {
  const longReview = "Here is my detailed review:\n" + "- Issue 1: ".repeat(200);
  const messages: ChatMessage[] = [
    msg({ kind: "agent", agentId: "ux", content: longReview, status: "done" }),
    msg({ kind: "user", content: "@developer: fix all issues above" }),
  ];

  const history = buildHistoryForAgent("developer", messages);
  assert.equal(history.length, 2);
  assert.equal(history[0].content, longReview, "recent agent review should be untruncated");
});

test("budget is respected: total chars do not exceed MAX_HISTORY_CHARS", () => {
  const messages: ChatMessage[] = [];
  // 20 messages of 1000 chars each = 20000 total, should be trimmed to MAX_HISTORY_CHARS
  for (let i = 0; i < 20; i++) {
    messages.push(msg({ kind: "user", content: `${i}: ` + "c".repeat(1000) }));
  }

  const history = buildHistoryForAgent("developer", messages);
  const totalChars = history.reduce((sum, e) => sum + e.content.length, 0);
  assert.ok(totalChars <= MAX_HISTORY_CHARS, `total ${totalChars} exceeds budget ${MAX_HISTORY_CHARS}`);
});

test("truncation marker includes original message length", () => {
  const suffix = "z".repeat(800);
  const messages: ChatMessage[] = [];
  // Create enough long messages to force truncation of older ones
  for (let i = 0; i < RECENT_UNTRUNCATED_COUNT + 2; i++) {
    const content = `msg_${i}: ${suffix}`;
    messages.push(msg({ kind: "user", content }));
  }

  const history = buildHistoryForAgent("developer", messages);
  // Find a truncated entry
  const truncated = history.find((e) => e.content.includes("[truncated:"));
  assert.ok(truncated, "should have at least one truncated entry");
  // The marker should mention "original message was N chars]" for some N > 0
  assert.match(truncated!.content, /\[truncated: original message was \d+ chars\]/);
});

test("recent user assignment and UX feedback survive even when older messages fill budget", () => {
  // Regression: older entries should NOT consume budget before recent critical messages.
  // With RECENT_UNTRUNCATED_COUNT=6, we need many older entries whose truncated form
  // can consume the entire budget if processed first.
  // 22 older entries × ~547 chars truncated = ~12034 > MAX_HISTORY_CHARS(12000)
  const messages: ChatMessage[] = [];

  const olderCount = RECENT_UNTRUNCATED_COUNT + 16; // 22 older entries
  for (let i = 0; i < olderCount; i++) {
    messages.push(msg({ kind: "user", content: `old_${i}: ` + "o".repeat(800) }));
  }

  // Then add a critical recent UX review and user assignment
  const uxReview = "UX feedback: " + "P1: Fix header spacing. ".repeat(50);
  const userAssignment = "@developer: fix all UX feedback items above";

  messages.push(msg({ kind: "agent", agentId: "ux", content: uxReview, status: "done" }));
  messages.push(msg({ kind: "user", content: userAssignment }));

  const history = buildHistoryForAgent("developer", messages);
  const allContent = history.map((e) => e.content).join("\n");

  assert.ok(
    allContent.includes(userAssignment),
    `recent user assignment must be present in history. Got ${history.length} entries, last: ${history[history.length - 1]?.content.slice(0, 60)}`
  );
  assert.ok(
    allContent.includes(uxReview),
    `recent UX review must be present in history. Got ${history.length} entries`
  );
});
