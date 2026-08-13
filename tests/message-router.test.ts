import assert from "node:assert/strict";
import test from "node:test";

import { MessageRouter } from "../src/core/message-router.ts";
import type { AgentId, AgentProfile, ChatMessage, MessageRouteState } from "../src/shared/types.ts";

const agents: readonly AgentProfile[] = [
  { id: "agent1", name: "方案设计", runtime: "codex", cwd: "/tmp", systemPrompt: "design" },
  { id: "agent2", name: "开发实现", runtime: "claude-code", cwd: "/tmp", systemPrompt: "build" },
];

function message(kind: ChatMessage["kind"], content: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { id: `msg-${Math.random().toString(36).slice(2)}`, kind, content, createdAt: new Date().toISOString(), status: "sent", ...overrides };
}

function createRouter(options: Partial<{ maxRouteDepth: number; hasActiveSupervisor: boolean }> = {}) {
  const systemMessages: string[] = [];
  const agentRuns: Array<{ agentId: AgentId; prompt: string }> = [];
  const routeStates: MessageRouteState[] = [];
  const router = new MessageRouter({
    availableAgents: agents,
    maxRouteDepth: options.maxRouteDepth ?? 10,
    hasActiveSupervisor: options.hasActiveSupervisor,
    createSystemMessage(content) { systemMessages.push(content); return message("system", content); },
    startAgentRun(agentId, prompt) { agentRuns.push({ agentId, prompt }); },
    markMessageRouted(_id, state) { routeStates.push(state); },
  });
  return { router, systemMessages, agentRuns, routeStates };
}

test("routes user assignments by display name and preserves the full prompt", () => {
  const { router, agentRuns, routeStates } = createRouter();
  const content = "@方案设计: design the solution";
  router.process(message("user", content));
  assert.deepEqual(agentRuns, [{ agentId: "agent1", prompt: content }]);
  assert.deepEqual(routeStates, ["routed"]);
});

test("routes multiple custom names in one message", () => {
  const { router, agentRuns } = createRouter();
  router.process(message("user", "@方案设计: plan; @开发实现: build"));
  assert.deepEqual(agentRuns.map((run) => run.agentId), ["agent1", "agent2"]);
});

test("internal ids are no longer assignment markers", () => {
  const { router, agentRuns, systemMessages, routeStates } = createRouter();
  router.process(message("user", "@agent1: use the internal id"));
  assert.equal(agentRuns.length, 0);
  assert.equal(systemMessages.length, 1);
  assert.deepEqual(routeStates, ["ignored"]);
});

test("plain mentions do not route", () => {
  const { router, agentRuns, systemMessages } = createRouter();
  router.process(message("user", "@开发实现 can review this later"));
  assert.equal(agentRuns.length, 0);
  assert.equal(systemMessages.length, 1);
});

test("agent can hand off by display name while a plain self mention stays context", () => {
  const { router, agentRuns } = createRouter();
  router.process(message("agent", "@开发实现: continue the implementation; @方案设计 can review", { agentId: "agent1" }));
  assert.deepEqual(agentRuns.map((run) => run.agentId), ["agent2"]);
});

test("all routes to every available employee and excludes the sender", () => {
  const { router, agentRuns } = createRouter();
  router.process(message("agent", "@all: help", { agentId: "agent1" }));
  assert.deepEqual(agentRuns.map((run) => run.agentId), ["agent2"]);
});

test("empty assignment is blocked", () => {
  const { router, agentRuns, systemMessages, routeStates } = createRouter();
  router.process(message("user", "@方案设计:"));
  assert.equal(agentRuns.length, 0);
  assert.ok(systemMessages[0]?.includes("task content"));
  assert.deepEqual(routeStates, ["blocked"]);
});

test("depth limit blocks assignments", () => {
  const { router, agentRuns, systemMessages, routeStates } = createRouter({ maxRouteDepth: 2 });
  router.process(message("agent", "@开发实现: check this", { agentId: "agent1", routeDepth: 2 }));
  assert.equal(agentRuns.length, 0);
  assert.ok(systemMessages[0]?.includes("(3/2)"));
  assert.deepEqual(routeStates, ["blocked"]);
});

test("already routed messages and duplicate ids are skipped", () => {
  const { router, agentRuns, routeStates } = createRouter();
  const routed = message("user", "@方案设计: do it", { routeState: "routed" });
  router.process(routed);
  assert.equal(agentRuns.length, 0);
  const fresh = message("user", "@方案设计: do it");
  router.process(fresh);
  router.process({ ...fresh, routeState: undefined });
  assert.equal(agentRuns.length, 1);
  assert.deepEqual(routeStates, ["routed"]);
});

test("supervision suppresses the unassigned system hint", () => {
  const { router, systemMessages, routeStates } = createRouter({ hasActiveSupervisor: true });
  router.process(message("user", "hello"));
  assert.equal(systemMessages.length, 0);
  assert.deepEqual(routeStates, ["ignored"]);
});
