import assert from "node:assert/strict";
import test from "node:test";

import { ChannelRouter } from "../src/core/channel-router.ts";
import type { AgentId, ChatMessage, MessageRouteState } from "../src/shared/types.ts";

const agents: readonly AgentId[] = ["agent1", "agent2"];

function createUserMessage(content: string, overrides?: Partial<ChatMessage>): ChatMessage {
  return {
    id: `msg_${Math.random().toString(36).slice(2, 8)}`,
    kind: "user",
    content,
    createdAt: new Date().toISOString(),
    status: "sent",
    ...overrides,
  };
}

function createAgentMessage(agentId: AgentId, content: string, overrides?: Partial<ChatMessage>): ChatMessage {
  return {
    id: `msg_${Math.random().toString(36).slice(2, 8)}`,
    kind: "agent",
    agentId,
    content,
    createdAt: new Date().toISOString(),
    status: "done",
    ...overrides,
  };
}

function createRouter(options?: Partial<{ availableAgents: readonly AgentId[]; maxRouteDepth: number }>) {
  const systemMessages: Array<{ content: string; parentMessageId?: string }> = [];
  const agentRuns: Array<{ agentId: AgentId; prompt: string; source: ChatMessage }> = [];
  const routeStates: Array<{ id: string; state: MessageRouteState }> = [];

  const router = new ChannelRouter({
    availableAgents: options?.availableAgents ?? agents,
    maxRouteDepth: options?.maxRouteDepth ?? 5,
    createSystemMessage(content: string, parentMessageId?: string) {
      systemMessages.push({ content, parentMessageId });
      return createUserMessage(content, { kind: "system" });
    },
    startAgentRun(agentId: AgentId, prompt: string, source: ChatMessage) {
      agentRuns.push({ agentId, prompt, source });
    },
    markMessageRouted(id: string, state: MessageRouteState) {
      routeStates.push({ id, state });
    },
  });

  return { router, systemMessages, agentRuns, routeStates };
}

test("user assignment triggers agent run with full channel message", () => {
  const { router, agentRuns, routeStates } = createRouter();
  const content = "@agent1: do something";
  router.process(createUserMessage(content));

  assert.equal(agentRuns.length, 1);
  assert.equal(agentRuns[0].agentId, "agent1");
  assert.equal(agentRuns[0].prompt, content);
  assert.equal(agentRuns[0].prompt.includes("Orbit private routing context"), false);
  assert.equal(routeStates[0]?.state, "routed");
});

test("multi-agent assignment starts one run per assigned agent with the full channel message", () => {
  const { router, agentRuns, routeStates } = createRouter();
  const content = "@agent1: design requirements; @agent2: implement code based on @agent1 output";
  router.process(createUserMessage(content));

  assert.equal(agentRuns.length, 2);
  assert.deepEqual(agentRuns.map((run) => run.agentId), ["agent1", "agent2"]);
  assert.ok(agentRuns.every((run) => run.prompt === content));
  assert.ok(agentRuns.every((run) => !run.prompt.includes("Orbit private routing context")));
  assert.equal(routeStates[0]?.state, "routed");
});

test("plain mention is ignored and does not start agent run", () => {
  const { router, systemMessages, agentRuns, routeStates } = createRouter();
  router.process(createUserMessage("I and @agent2 can collaborate"));

  assert.equal(agentRuns.length, 0);
  assert.equal(systemMessages.length, 1);
  assert.ok(systemMessages[0].content.includes("@agent1:"));
  assert.equal(routeStates[0]?.state, "ignored");
});

test("agent plain mention is silently ignored", () => {
  const { router, systemMessages, agentRuns, routeStates } = createRouter();
  router.process(createAgentMessage("agent1", "I can work with @agent2"));

  assert.equal(agentRuns.length, 0);
  assert.equal(systemMessages.length, 0);
  assert.equal(routeStates[0]?.state, "ignored");
});

test("agent unknown colon mention is silently ignored", () => {
  const { router, systemMessages, agentRuns, routeStates } = createRouter();
  router.process(createAgentMessage("agent1", "Use @agent: as a generic placeholder in docs"));

  assert.equal(agentRuns.length, 0);
  assert.equal(systemMessages.length, 0);
  assert.equal(routeStates[0]?.state, "ignored");
});

test("agent can assign another agent and include itself as plain callback mention", () => {
  const { router, agentRuns, systemMessages, routeStates } = createRouter();
  const content = "@agent2: count files. When done, mention @agent1";
  router.process(createAgentMessage("agent1", content));

  assert.equal(agentRuns.length, 1);
  assert.equal(agentRuns[0].agentId, "agent2");
  assert.equal(agentRuns[0].prompt, content);
  assert.equal(systemMessages.length, 0);
  assert.equal(routeStates[0]?.state, "routed");
});

test("agent self-assignment is silently ignored", () => {
  const { router, systemMessages, agentRuns, routeStates } = createRouter();
  router.process(createAgentMessage("agent1", "@agent1: continue"));

  assert.equal(agentRuns.length, 0);
  assert.equal(systemMessages.length, 0);
  assert.equal(routeStates[0]?.state, "ignored");
});

test("agent self-assignment does not block peer assignment", () => {
  const { router, systemMessages, agentRuns, routeStates } = createRouter();
  const content = "@agent1: I already handled this. @agent2: continue with tests";
  router.process(createAgentMessage("agent1", content));

  assert.equal(agentRuns.length, 1);
  assert.equal(agentRuns[0].agentId, "agent2");
  assert.equal(agentRuns[0].prompt, content);
  assert.equal(systemMessages.length, 0);
  assert.equal(routeStates[0]?.state, "routed");
});

test("@all assignment is blocked with system message", () => {
  const { router, systemMessages, agentRuns, routeStates } = createRouter();
  router.process(createUserMessage("@all: summarize project"));

  assert.equal(agentRuns.length, 0);
  assert.equal(systemMessages.length, 1);
  assert.ok(systemMessages[0].content.includes("does not support @all"));
  assert.equal(routeStates[0]?.state, "blocked");
});

test("already routed message is skipped", () => {
  const { router, agentRuns, routeStates } = createRouter();
  router.process(createUserMessage("@agent1: do something", { routeState: "routed" }));

  assert.equal(agentRuns.length, 0);
  assert.equal(routeStates.length, 0);
});

test("same message id is never processed twice", () => {
  const { router, agentRuns } = createRouter();
  const msg = createUserMessage("@agent1: do something");
  router.process(msg);
  router.process({ ...msg, routeState: undefined });

  assert.equal(agentRuns.length, 1);
});

test("depth limit blocks all assignments", () => {
  const { router, systemMessages, agentRuns, routeStates } = createRouter({ maxRouteDepth: 2 });
  router.process(createAgentMessage("agent1", "@agent2: check this", { routeDepth: 2 }));

  assert.equal(agentRuns.length, 0);
  assert.equal(systemMessages.length, 1);
  assert.ok(systemMessages[0].content.includes("maximum routing depth"));
  assert.equal(routeStates[0]?.state, "blocked");
});

test("depth within limit allows routing", () => {
  const { router, agentRuns } = createRouter({ maxRouteDepth: 3 });
  router.process(createAgentMessage("agent1", "@agent2: check this", { routeDepth: 2 }));

  assert.equal(agentRuns.length, 1);
  assert.equal(agentRuns[0].agentId, "agent2");
});

test("empty assignment does not start agent run", () => {
  const { router, systemMessages, agentRuns, routeStates } = createRouter();
  router.process(createUserMessage("@agent1:"));

  assert.equal(agentRuns.length, 0);
  assert.equal(systemMessages.length, 1);
  assert.ok(systemMessages[0].content.includes("task content"));
  assert.equal(routeStates[0]?.state, "blocked");
});
