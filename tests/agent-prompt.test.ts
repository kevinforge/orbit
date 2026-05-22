import assert from "node:assert/strict";
import test from "node:test";

import { buildAgentCollaborationContext, shouldAddAgentCollaborationContext } from "../src/core/agent-prompt.ts";

const agents = ["agent1", "agent2"] as const;

test("plain prompts do not need collaboration context", () => {
  assert.equal(shouldAddAgentCollaborationContext("hello", agents), false);
});

test("prompts that name another agent need collaboration context", () => {
  assert.equal(shouldAddAgentCollaborationContext("ask agent2 to inspect the project", agents), true);
  assert.equal(shouldAddAgentCollaborationContext("tell Agent2 to count files", agents), true);
});

test("prompts that use @all need collaboration context", () => {
  assert.equal(shouldAddAgentCollaborationContext("@all inspect this", agents), true);
});

test("collaboration context identifies the current agent and peers", () => {
  const context = buildAgentCollaborationContext("agent1", agents);

  assert.ok(context.includes("You are Agent 1 (agent1)"));
  assert.ok(context.includes("@agent2"));
});

test("collaboration context says Orbit agents are routable and managed by Orbit", () => {
  const context = buildAgentCollaborationContext("agent1", agents);

  assert.ok(context.includes("Orbit has exactly these routable agents: @agent1, @agent2."));
  assert.ok(context.includes("Do not claim another Orbit agent is offline"));
  assert.ok(context.includes("Do not use Claude Code Team, spawn, or session concepts"));
});

test("collaboration context tells agents to translate natural-language delegation into @agent output", () => {
  const context = buildAgentCollaborationContext("agent1", agents);

  assert.ok(context.includes("If the user asks you to tell, ask, delegate, hand off, or assign work"));
  assert.ok(context.includes("your final visible answer must start with exactly one explicit @agent mention"));
  assert.ok(context.includes("User: ask agent2 to count files"));
  assert.ok(context.includes("Final answer: @agent2 Count the files in this project and report the result."));
});

test("collaboration context forbids @all in the first version", () => {
  const context = buildAgentCollaborationContext("agent2", agents);

  assert.ok(context.includes("Do not use @all"));
});
