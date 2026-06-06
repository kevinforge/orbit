import assert from "node:assert/strict";
import test from "node:test";

import { MessageRouter } from "../src/core/message-router.ts";
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

function createRouter(options?: Partial<{ availableAgents: readonly AgentId[]; maxRouteDepth: number; hasActiveSupervisor: boolean }>) {
  const systemMessages: Array<{ content: string; parentMessageId?: string }> = [];
  const agentRuns: Array<{ agentId: AgentId; prompt: string; source: ChatMessage }> = [];
  const routeStates: Array<{ id: string; state: MessageRouteState }> = [];

  const router = new MessageRouter({
    availableAgents: options?.availableAgents ?? agents,
    maxRouteDepth: options?.maxRouteDepth ?? 10,
    hasActiveSupervisor: options?.hasActiveSupervisor,
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

test("user assignment triggers agent run with full message", () => {
  const { router, agentRuns, routeStates } = createRouter();
  const content = "@agent1: do something";
  router.process(createUserMessage(content));

  assert.equal(agentRuns.length, 1);
  assert.equal(agentRuns[0].agentId, "agent1");
  assert.equal(agentRuns[0].prompt, content);
  assert.equal(agentRuns[0].prompt.includes("Orbit private routing context"), false);
  assert.equal(routeStates[0]?.state, "routed");
});

test("multi-agent assignment starts one run per assigned agent with the full message", () => {
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

test("@all: assignment routes to all agents", () => {
  const { router, agentRuns, routeStates } = createRouter();
  router.process(createUserMessage("@all: summarize project"));

  assert.equal(agentRuns.length, 2);
  assert.deepEqual(agentRuns.map((run) => run.agentId).sort(), ["agent1", "agent2"]);
  assert.ok(agentRuns.every((run) => run.prompt === "@all: summarize project"));
  assert.equal(routeStates[0]?.state, "routed");
});

test("@all: from agent excludes self from routing", () => {
  const { router, agentRuns, routeStates } = createRouter();
  router.process(createAgentMessage("agent1", "@all: everyone help"));

  assert.equal(agentRuns.length, 1);
  assert.equal(agentRuns[0].agentId, "agent2");
  assert.equal(routeStates[0]?.state, "routed");
});

test("unknown @xx: from user is silently ignored with hint", () => {
  const { router, systemMessages, agentRuns, routeStates } = createRouter();
  router.process(createUserMessage("@nonexistent: do something"));

  assert.equal(agentRuns.length, 0);
  assert.equal(routeStates[0]?.state, "ignored");
  assert.ok(systemMessages[0].content.includes("@agent1:"));
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
  assert.ok(systemMessages[0].content.includes("(3/2)"));
  assert.equal(routeStates[0]?.state, "blocked");
});

test("depth within limit allows routing", () => {
  const { router, agentRuns } = createRouter({ maxRouteDepth: 3 });
  router.process(createAgentMessage("agent1", "@agent2: check this", { routeDepth: 2 }));

  assert.equal(agentRuns.length, 1);
  assert.equal(agentRuns[0].agentId, "agent2");
});

test("default maxRouteDepth is 10", () => {
  const { router, systemMessages, agentRuns, routeStates } = createRouter();
  router.process(createAgentMessage("agent1", "@agent2: check this", { routeDepth: 10 }));

  assert.equal(agentRuns.length, 0);
  assert.equal(systemMessages.length, 1);
  assert.ok(systemMessages[0].content.includes("(11/10)"));
  assert.equal(routeStates[0]?.state, "blocked");
});

test("depth at limit allows routing", () => {
  const { router, agentRuns } = createRouter({ maxRouteDepth: 5 });
  router.process(createAgentMessage("agent1", "@agent2: check this", { routeDepth: 4 }));

  assert.equal(agentRuns.length, 1);
  assert.equal(agentRuns[0].agentId, "agent2");
});

test("depth below limit allows routing", () => {
  const { router, agentRuns } = createRouter({ maxRouteDepth: 10 });
  router.process(createAgentMessage("agent1", "@agent2: check this", { routeDepth: 3 }));

  assert.equal(agentRuns.length, 1);
  assert.equal(agentRuns[0].agentId, "agent2");
});

test("depth above limit blocks routing with depth info", () => {
  const { router, systemMessages, agentRuns, routeStates } = createRouter({ maxRouteDepth: 5 });
  router.process(createAgentMessage("agent1", "@agent2: check this", { routeDepth: 5 }));

  assert.equal(agentRuns.length, 0);
  assert.equal(systemMessages.length, 1);
  assert.ok(systemMessages[0].content.includes("(6/5)"));
  assert.equal(routeStates[0]?.state, "blocked");
});

test("default maxRouteDepth allows routing below limit", () => {
  const { router, agentRuns } = createRouter();
  router.process(createAgentMessage("agent1", "@agent2: check this", { routeDepth: 9 }));

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

// --- hasActiveSupervisor behavior ---

test("plain mention with supervisor active creates no system message (ChannelWatchService handles it)", () => {
  const { router, systemMessages, agentRuns, routeStates } = createRouter({ hasActiveSupervisor: true });
  router.process(createUserMessage("hello world"));

  assert.equal(agentRuns.length, 0);
  assert.equal(systemMessages.length, 0);
  assert.equal(routeStates[0]?.state, "ignored");
});

test("plain mention WITHOUT supervisor creates system hint message", () => {
  const { router, systemMessages, agentRuns, routeStates } = createRouter({ hasActiveSupervisor: false });
  router.process(createUserMessage("hello world"));

  assert.equal(agentRuns.length, 0);
  assert.equal(systemMessages.length, 1);
  assert.ok(systemMessages[0].content.includes("@agent1:"));
  assert.equal(routeStates[0]?.state, "ignored");
});

test("plain mention without hasActiveSupervisor option creates system hint", () => {
  // When the option is omitted (undefined/falsy), behavior should match hasActiveSupervisor: false
  const { router, systemMessages, agentRuns, routeStates } = createRouter();
  router.process(createUserMessage("no assignment here"));

  assert.equal(agentRuns.length, 0);
  assert.equal(systemMessages.length, 1);
  assert.equal(routeStates[0]?.state, "ignored");
});
