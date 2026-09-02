import assert from "node:assert/strict";
import test from "node:test";

import { matchAssignmentPrefix, routeMention } from "../src/core/mention-router.ts";
import type { AgentProfile } from "../src/shared/types.ts";

const agents: readonly AgentProfile[] = [
  { id: "agent1", name: "甄架构", runtime: "codex", cwd: "/tmp", systemPrompt: "design" },
  { id: "agent2", name: "蔡一平", runtime: "claude-code", cwd: "/tmp", systemPrompt: "build" },
];

test("routes using the custom display name", () => {
  const result = routeMention("@甄架构: summarize this project", agents);
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

test("@all is no longer an assignment marker and routes to no one", () => {
  assert.equal(routeMention("@all: review everything", agents).kind, "none");
  assert.equal(routeMention("@all: review everything", agents, "agent1").kind, "none");
});

test("unknown names are ignored while known names still route", () => {
  const result = routeMention("@unknown: ignore this @蔡一平: do the work", agents);
  assert.equal(result.kind, "assignments");
  if (result.kind === "assignments") assert.deepEqual(result.agentIds, ["agent2"]);
});

test("empty assignments are blocked", () => {
  const result = routeMention("@甄架构:", agents);
  assert.equal(result.kind, "empty_assignment");
  if (result.kind === "empty_assignment") assert.equal(result.agentId, "agent1");
});

test("matchAssignmentPrefix shares the routing marker semantics", () => {
  // 命名由调用方做忽略大小写匹配；这里只验证标记本身：半角/全角冒号等价，
  // 冒号前的空白与冒号后的空格/制表符都归前缀。
  assert.deepEqual(matchAssignmentPrefix("@甄架构: 设计一下"), { name: "甄架构", end: 6 });
  assert.deepEqual(matchAssignmentPrefix("@甄架构：设计一下"), { name: "甄架构", end: 5 });
  assert.deepEqual(matchAssignmentPrefix("@甄架构  : \t 内容"), { name: "甄架构", end: 10 });
  assert.deepEqual(matchAssignmentPrefix("@评审:\t/init"), { name: "评审", end: 5 });
  // 只有消息开头的标记才算前缀；没有冒号就不是标记。
  assert.equal(matchAssignmentPrefix("hello @甄架构: x"), null);
  assert.equal(matchAssignmentPrefix("@甄架构"), null);
  assert.equal(matchAssignmentPrefix(""), null);
});
