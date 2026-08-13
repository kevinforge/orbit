import assert from "node:assert/strict";
import test from "node:test";

import { routeMention } from "../src/core/mention-router.ts";
import type { AgentProfile } from "../src/shared/types.ts";

const agents: readonly AgentProfile[] = [
  { id: "agent1", name: "方案设计", runtime: "codex", cwd: "/tmp", systemPrompt: "design" },
  { id: "agent2", name: "开发实现", runtime: "claude-code", cwd: "/tmp", systemPrompt: "build" },
];

test("routes using the custom display name", () => {
  const result = routeMention("@方案设计: summarize this project", agents);
  assert.equal(result.kind, "assignments");
  if (result.kind === "assignments") assert.deepEqual(result.agentIds, ["agent1"]);
});

test("custom name matching is case insensitive", () => {
  const result = routeMention("@DEVELOP: build it", [{ ...agents[1], name: "Develop" }]);
  assert.equal(result.kind, "assignments");
});

test("plain mentions and internal ids do not route", () => {
  assert.equal(routeMention("@agent2 please help", agents).kind, "none");
  assert.equal(routeMention("@agent2: please help", agents).kind, "none");
});

test("all expands to all available employees and excludes the sender", () => {
  const result = routeMention("@all: review everything", agents, "agent1");
  assert.equal(result.kind, "assignments");
  if (result.kind === "assignments") assert.deepEqual(result.agentIds, ["agent2"]);
});

test("unknown names are ignored while known names still route", () => {
  const result = routeMention("@unknown: ignore this @开发实现: do the work", agents);
  assert.equal(result.kind, "assignments");
  if (result.kind === "assignments") assert.deepEqual(result.agentIds, ["agent2"]);
});

test("empty assignments are blocked", () => {
  const result = routeMention("@方案设计:", agents);
  assert.equal(result.kind, "empty_assignment");
  if (result.kind === "empty_assignment") assert.equal(result.agentId, "agent1");
});

test("all with no task content is blocked", () => {
  assert.equal(routeMention("@all:", agents).kind, "empty_assignment");
});
