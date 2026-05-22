import assert from "node:assert/strict";
import test from "node:test";

import { routeMention } from "../src/core/mention-router.ts";

const agents = ["agent1", "agent2"] as const;

test("assignment: routes @agent1 colon assignment and preserves full message", () => {
  const content = "@agent1: summarize this project";
  const result = routeMention(content, agents);
  assert.equal(result.kind, "assignments");
  if (result.kind === "assignments") {
    assert.deepEqual(result.agentIds, ["agent1"]);
    assert.equal(result.prompt, content);
  }
});

test("assignment: supports Chinese colon", () => {
  const content = "@agent2：检查当前项目";
  const result = routeMention(content, agents);
  assert.equal(result.kind, "assignments");
  if (result.kind === "assignments") {
    assert.deepEqual(result.agentIds, ["agent2"]);
    assert.equal(result.prompt, content);
  }
});

test("assignment: routes multiple agents from one channel message", () => {
  const content = "@agent1: design the requirement; @agent2: implement code based on @agent1 output";
  const result = routeMention(content, agents);
  assert.equal(result.kind, "assignments");
  if (result.kind === "assignments") {
    assert.deepEqual(result.agentIds, ["agent1", "agent2"]);
    assert.equal(result.prompt, content);
  }
});

test("mention: plain @agent mention does not route", () => {
  const result = routeMention("I and @agent2 can collaborate", agents);
  assert.equal(result.kind, "none");
});

test("mention: old space syntax does not route", () => {
  const result = routeMention("@agent1 summarize this project", agents);
  assert.equal(result.kind, "none");
});

test("unknown: unknown colon mention is ignored as ordinary text", () => {
  const result = routeMention("@agent: summarize this project", agents);
  assert.equal(result.kind, "none");
});

test("unknown: known assignments still route when ordinary text contains unknown colon mentions", () => {
  const content = "@agent1: summarize the docs and mention the generic @agent: syntax";
  const result = routeMention(content, agents);
  assert.equal(result.kind, "assignments");
  if (result.kind === "assignments") {
    assert.deepEqual(result.agentIds, ["agent1"]);
    assert.equal(result.prompt, content);
  }
});

test("all_unsupported: @all colon assignment returns unsupported message", () => {
  const result = routeMention("@all: summarize project", agents);
  assert.equal(result.kind, "all_unsupported");
  if (result.kind === "all_unsupported") {
    assert.ok(result.message.includes("does not support @all"));
  }
});

test("self: agent assigning itself is ignored as ordinary reply text", () => {
  const result = routeMention("@agent1: continue", agents, "agent1");
  assert.equal(result.kind, "none");
});

test("self: agent self-assignment does not block peer assignment", () => {
  const content = "@agent1: I already handled this. @agent2: continue with tests";
  const result = routeMention(content, agents, "agent1");
  assert.equal(result.kind, "assignments");
  if (result.kind === "assignments") {
    assert.deepEqual(result.agentIds, ["agent2"]);
    assert.equal(result.prompt, content);
  }
});

test("self: agent can assign another agent and mention itself without colon as context", () => {
  const content = "@agent2: count files. When done, mention @agent1";
  const result = routeMention(content, agents, "agent1");
  assert.equal(result.kind, "assignments");
  if (result.kind === "assignments") {
    assert.deepEqual(result.agentIds, ["agent2"]);
    assert.equal(result.prompt, content);
  }
});

test("empty_assignment: @agent1 colon alone is blocked", () => {
  const result = routeMention("@agent1:", agents);
  assert.equal(result.kind, "empty_assignment");
  if (result.kind === "empty_assignment") {
    assert.equal(result.agentId, "agent1");
    assert.ok(result.message.includes("task content"));
  }
});

test("empty_assignment: one empty assignment blocks the whole message", () => {
  const result = routeMention("@agent1: @agent2: implement code", agents);
  assert.equal(result.kind, "empty_assignment");
  if (result.kind === "empty_assignment") {
    assert.equal(result.agentId, "agent1");
  }
});
