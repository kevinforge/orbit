import assert from "node:assert/strict";
import test from "node:test";

import { routeMention } from "../src/core/mention-router.ts";

const agents = ["agent1", "agent2"] as const;

test("single: routes @agent1 and strips mention from prompt", () => {
  const result = routeMention("@agent1 summarize this project", agents);
  assert.equal(result.kind, "single");
  if (result.kind === "single") {
    assert.equal(result.agentId, "agent1");
    assert.equal(result.prompt, "summarize this project");
  }
});

test("single: routes @agent2", () => {
  const result = routeMention("@agent2 check the code", agents);
  assert.equal(result.kind, "single");
  if (result.kind === "single") {
    assert.equal(result.agentId, "agent2");
    assert.equal(result.prompt, "check the code");
  }
});

test("none: no mention returns helpful message", () => {
  const result = routeMention("summarize this project", agents);
  assert.equal(result.kind, "none");
  if (result.kind === "none") {
    assert.ok(result.message.includes("@agent1"));
    assert.ok(result.message.includes("@agent2"));
  }
});

test("unknown: @agent3 returns unknown message", () => {
  const result = routeMention("@agent3 summarize this project", agents);
  assert.equal(result.kind, "unknown");
  if (result.kind === "unknown") {
    assert.ok(result.message.includes("agent3"));
    assert.ok(result.message.includes("@agent1"));
  }
});

test("multiple: user @agent1 @agent2 returns multiple message", () => {
  const result = routeMention("@agent1 and @agent2 summarize separately", agents);
  assert.equal(result.kind, "multiple");
  if (result.kind === "multiple") {
    assert.ok(result.message.includes("one agent"));
  }
});

test("multiple: agent can mention one target and itself as callback", () => {
  const result = routeMention("@agent2 count files. When done mention @agent1", agents, "agent1");
  assert.equal(result.kind, "single");
  if (result.kind === "single") {
    assert.equal(result.agentId, "agent2");
    assert.equal(result.prompt, "count files. When done mention @agent1");
  }
});

test("multiple: user cannot use callback-style multiple mentions", () => {
  const result = routeMention("@agent2 count files. When done mention @agent1", agents);
  assert.equal(result.kind, "multiple");
});

test("all_unsupported: @All returns unsupported message", () => {
  const result = routeMention("@All summarize project", agents);
  assert.equal(result.kind, "all_unsupported");
  if (result.kind === "all_unsupported") {
    assert.ok(result.message.includes("does not support @all"));
  }
});

test("all_unsupported: @all lowercase is also detected", () => {
  const result = routeMention("@all summarize", agents);
  assert.equal(result.kind, "all_unsupported");
});

test("self: agent mentioning itself returns self message", () => {
  const result = routeMention("@agent1 continue", agents, "agent1");
  assert.equal(result.kind, "self");
  if (result.kind === "self") {
    assert.ok(result.message.includes("themselves"));
  }
});

test("self: only triggers when sender matches the mentioned agent", () => {
  const result = routeMention("@agent2 continue", agents, "agent1");
  assert.equal(result.kind, "single");
  if (result.kind === "single") {
    assert.equal(result.agentId, "agent2");
  }
});

test("self: no sender means no self check", () => {
  const result = routeMention("@agent1 do something", agents);
  assert.equal(result.kind, "single");
});

test("empty_prompt: @agent1 alone returns empty_prompt", () => {
  const result = routeMention("@agent1", agents);
  assert.equal(result.kind, "empty_prompt");
  if (result.kind === "empty_prompt") {
    assert.equal(result.agentId, "agent1");
    assert.ok(result.message.includes("task content"));
  }
});

test("empty_prompt: @agent2 with only whitespace returns empty_prompt", () => {
  const result = routeMention("@agent2   ", agents);
  assert.equal(result.kind, "empty_prompt");
});
