import test from "node:test";
import assert from "node:assert/strict";

import { TerminalTranscriptStore } from "../src/core/terminal-transcript-store.ts";

test("appends cleaned terminal chunks by agent", () => {
  const store = new TerminalTranscriptStore();

  store.append("agent1", "\u001b[32mhello\u001b[0m");
  store.append("agent1", "\nworld");
  store.append("agent2", "other");

  assert.equal(store.get("agent1"), "hello\nworld");
  assert.equal(store.get("agent2"), "other");
});

test("list returns terminal snapshots for agents that produced output", () => {
  const store = new TerminalTranscriptStore();
  store.append("developer", "one");

  assert.deepEqual(store.list(), {
    developer: "one",
  });
});

test("unknown agent transcript starts empty", () => {
  const store = new TerminalTranscriptStore();

  assert.equal(store.get("tester"), "");
});
