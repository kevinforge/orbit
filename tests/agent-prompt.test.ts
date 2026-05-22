import assert from "node:assert/strict";
import test from "node:test";

import {
  buildChannelAssignmentContext,
  buildAgentCollaborationContext,
  sanitizeAgentVisibleReply,
  shouldAddAgentCollaborationContext,
} from "../src/core/agent-prompt.ts";

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

test("collaboration context explains assignment syntax and plain mentions", () => {
  const context = buildAgentCollaborationContext("agent1", agents);

  assert.ok(context.includes("@agent1:"));
  assert.ok(context.includes("@agent2:"));
  assert.ok(context.includes("Plain @agent mentions without a colon are references only"));
  assert.ok(context.includes("Do not use Claude Code Team, spawn, or session concepts"));
  assert.equal(context.includes("@agent:"), false);
});

test("collaboration context tells agents to delegate with colon syntax", () => {
  const context = buildAgentCollaborationContext("agent1", agents);

  assert.ok(context.includes("If you need to assign work to another agent"));
  assert.ok(context.includes("Final answer: @agent2: Count the files in this project and report the result."));
});

test("collaboration context forbids assignment prefixes in capability explanations", () => {
  const context = buildAgentCollaborationContext("agent2", agents);

  assert.ok(context.includes("When explaining your identity, capabilities, or Orbit routing"));
  assert.ok(context.includes("do not output literal assignment prefixes"));
  assert.ok(context.includes("use natural language like assignment prefix instead"));
  assert.ok(context.includes("If the user asks who you are"));
});

test("channel assignment context is private and does not include the channel message", () => {
  const content = "@agent1: design requirements; @agent2: implement code based on @agent1 output";
  const prompt = buildChannelAssignmentContext("agent1", agents);

  assert.ok(prompt.includes("You are agent1."));
  assert.ok(prompt.includes("Execute only the assignment addressed to @agent1."));
  assert.ok(prompt.includes("Use other agents' assignments as shared context"));
  assert.equal(prompt.includes(content), false);
  assert.equal(prompt.includes("@agent:"), false);
});

test("channel assignment context treats existing peer assignments as already scheduled", () => {
  const prompt = buildChannelAssignmentContext("agent1", agents);

  assert.ok(prompt.includes("The full channel message is the source of truth"));
  assert.ok(prompt.includes("If the full channel message already assigns work to another agent"));
  assert.ok(prompt.includes("assume Orbit has already scheduled that work"));
  assert.ok(prompt.includes("Do not repeat, restate, or reassign another agent's existing assignment"));
  assert.ok(prompt.includes("Only create a new assignment when it is genuinely new follow-up work"));
});

test("collaboration context forbids @all in the first version", () => {
  const context = buildAgentCollaborationContext("agent2", agents);

  assert.ok(context.includes("Do not use @all"));
});

test("sanitizes leaked private routing context before display", () => {
  const leaked = "[Orbit private routing context] You are agent1. [Full channel message] @agent1: hello";
  const sanitized = sanitizeAgentVisibleReply(leaked);

  assert.equal(sanitized.includes("Orbit private routing context"), false);
  assert.equal(sanitized.includes("@agent1:"), false);
  assert.ok(sanitized.includes("internal routing context"));
});
