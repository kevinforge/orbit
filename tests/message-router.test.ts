import assert from "node:assert/strict";
import test from "node:test";

import { MessageRouter } from "../src/core/message-router.ts";
import type { AgentId, AgentProfile, ChatMessage, InteractionMode, MessageAttachment, MessageRouteState } from "../src/shared/types.ts";

const agents: readonly AgentProfile[] = [
  { id: "agent1", name: "甄架构", runtime: "codex", cwd: "/tmp", systemPrompt: "design" },
  { id: "agent2", name: "蔡一平", runtime: "claude-code", cwd: "/tmp", systemPrompt: "build" },
];

function message(kind: ChatMessage["kind"], content: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { id: `msg-${Math.random().toString(36).slice(2)}`, kind, content, createdAt: new Date().toISOString(), status: "sent", ...overrides };
}

type RouterHarness = ReturnType<typeof createRouter>;

function createRouter(options: Partial<{ maxRouteDepth: number; mode: InteractionMode; lastDirectAgentId?: AgentId }> = {}) {
  const systemMessages: string[] = [];
  const agentRuns: Array<{ agentId: AgentId; prompt: string }> = [];
  const routeStates: MessageRouteState[] = [];
  const state: { mode: InteractionMode; lastDirectAgentId?: AgentId } = {
    mode: options.mode ?? "collaborative",
    lastDirectAgentId: options.lastDirectAgentId,
  };
  const router = new MessageRouter({
    availableAgents: agents,
    maxRouteDepth: options.maxRouteDepth ?? 10,
    getInteractionMode: () => state.mode,
    getLastDirectAgentId: () => state.lastDirectAgentId,
    setLastDirectAgentId: (agentId) => { state.lastDirectAgentId = agentId; },
    createSystemMessage(content) { systemMessages.push(content); return message("system", content); },
    startAgentRun(agentId, prompt) { agentRuns.push({ agentId, prompt }); },
    markMessageRouted(_id, routeState) { routeStates.push(routeState); },
  });
  return { router, systemMessages, agentRuns, routeStates, state };
}

test("routes user assignments by display name and preserves the full prompt", () => {
  const { router, agentRuns, routeStates } = createRouter();
  const content = "@甄架构: design the solution";
  router.process(message("user", content));
  assert.deepEqual(agentRuns, [{ agentId: "agent1", prompt: content }]);
  assert.deepEqual(routeStates, ["routed"]);
});

test("routes multiple custom names in one message", () => {
  const { router, agentRuns } = createRouter();
  router.process(message("user", "@甄架构: plan; @蔡一平: build"));
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
  router.process(message("user", "@蔡一平 can review this later"));
  assert.equal(agentRuns.length, 0);
  assert.equal(systemMessages.length, 1);
});

test("collaborative agent can hand off by display name while a plain self mention stays context", () => {
  const { router, agentRuns } = createRouter();
  router.process(message("agent", "@蔡一平: continue the implementation; @甄架构 can review", { agentId: "agent1" }));
  assert.deepEqual(agentRuns.map((run) => run.agentId), ["agent2"]);
});

test("@all no longer expands to every employee in any mode", () => {
  const collaborative = createRouter({ mode: "collaborative" });
  collaborative.router.process(message("user", "@all: help"));
  assert.equal(collaborative.agentRuns.length, 0, "@all must not route in collaborative");

  const supervised = createRouter({ mode: "supervised" });
  supervised.router.process(message("user", "@all: help"));
  assert.equal(supervised.agentRuns.length, 0, "@all must not route in supervised");

  // 普通对话下 @all 是未知名称：与无 @ 消息一致，继续路由给上一位直接对话员工（仅一人）。
  const direct = createRouter({ mode: "direct", lastDirectAgentId: "agent1" });
  direct.router.process(message("user", "@all: help"));
  assert.deepEqual(direct.agentRuns.map((run) => run.agentId), ["agent1"]);
});

test("empty assignment is blocked without attachments", () => {
  const { router, agentRuns, systemMessages, routeStates } = createRouter();
  router.process(message("user", "@甄架构:"));
  assert.equal(agentRuns.length, 0);
  assert.ok(systemMessages[0]?.includes("task content"));
  assert.deepEqual(routeStates, ["blocked"]);
});

test("image-only assignment routes through the selected employee", () => {
  const { router, agentRuns, routeStates } = createRouter({ mode: "direct" });
  router.process(message("user", "@甄架构:", {
    attachments: [{ kind: "image", id: "img-1" } as MessageAttachment],
  }));
  assert.deepEqual(agentRuns, [{ agentId: "agent1", prompt: "@甄架构:" }]);
  assert.deepEqual(routeStates, ["routed"]);
});

test("depth limit blocks assignments", () => {
  const { router, agentRuns, systemMessages, routeStates } = createRouter({ maxRouteDepth: 2 });
  router.process(message("agent", "@蔡一平: check this", { agentId: "agent1", routeDepth: 2 }));
  assert.equal(agentRuns.length, 0);
  assert.ok(systemMessages[0]?.includes("(3/2)"));
  assert.deepEqual(routeStates, ["blocked"]);
});

test("already routed messages and duplicate ids are skipped", () => {
  const { router, agentRuns, routeStates } = createRouter();
  const routed = message("user", "@甄架构: do it", { routeState: "routed" });
  router.process(routed);
  assert.equal(agentRuns.length, 0);
  const fresh = message("user", "@甄架构: do it");
  router.process(fresh);
  router.process({ ...fresh, routeState: undefined });
  assert.equal(agentRuns.length, 1);
  assert.deepEqual(routeStates, ["routed"]);
});

// ---------------------------------------------------------------------------
// 模式行为：普通对话（direct）
// ---------------------------------------------------------------------------

test("direct: first message without @ is blocked with a hint", () => {
  const { router, agentRuns, systemMessages, routeStates } = createRouter({ mode: "direct" });
  router.process(message("user", "hello"));
  assert.equal(agentRuns.length, 0);
  assert.ok(systemMessages[0]?.includes("@一位数字员工"));
  assert.deepEqual(routeStates, ["blocked"]);
});

test("direct: unassigned user message continues with the last direct employee", () => {
  const { router, agentRuns, routeStates } = createRouter({ mode: "direct", lastDirectAgentId: "agent2" });
  router.process(message("user", "continue with the plan"));
  assert.deepEqual(agentRuns.map((run) => run.agentId), ["agent2"]);
  assert.equal(agentRuns[0].prompt, "continue with the plan");
  assert.deepEqual(routeStates, ["routed"]);
});

test("direct: explicit @ switches the direct target and records it", () => {
  const { router, agentRuns, state, routeStates } = createRouter({ mode: "direct", lastDirectAgentId: "agent2" });
  router.process(message("user", "@甄架构: take over the design"));
  assert.deepEqual(agentRuns.map((run) => run.agentId), ["agent1"]);
  assert.equal(state.lastDirectAgentId, "agent1");
  assert.deepEqual(routeStates, ["routed"]);
});

test("direct: one message may only assign a single employee", () => {
  const { router, agentRuns, systemMessages, routeStates } = createRouter({ mode: "direct" });
  router.process(message("user", "@甄架构: plan; @蔡一平: build"));
  assert.equal(agentRuns.length, 0);
  assert.ok(systemMessages[0]?.includes("只能指派一位数字员工"));
  assert.deepEqual(routeStates, ["blocked"]);
});

test("direct: assignment markers in employee replies never trigger runs", () => {
  const { router, agentRuns, systemMessages, routeStates } = createRouter({ mode: "direct", lastDirectAgentId: "agent1" });
  router.process(message("agent", "@蔡一平: handle the rest", { agentId: "agent1" }));
  assert.equal(agentRuns.length, 0);
  assert.equal(systemMessages.length, 0);
  assert.deepEqual(routeStates, ["ignored"]);
});

test("direct: route inherits the message's mode snapshot, not the current mode", () => {
  const { router, agentRuns } = createRouter({ mode: "collaborative" });
  // 消息发送时的快照是 direct：员工回复中的指派必须被忽略，即使当前会话已切回简单协作。
  router.process(message("agent", "@蔡一平: continue", { agentId: "agent1", interactionMode: "direct" }));
  assert.equal(agentRuns.length, 0);
});

test("direct: switching modes away and back keeps the last direct employee", () => {
  const { router, agentRuns, state } = createRouter({ mode: "direct", lastDirectAgentId: "agent2" });
  state.mode = "collaborative";
  router.process(message("user", "@甄架构: plan together"));
  state.mode = "direct";
  router.process(message("user", "keep going"));
  assert.deepEqual(agentRuns.map((run) => run.agentId), ["agent1", "agent2"]);
  assert.equal(state.lastDirectAgentId, "agent2");
});

// ---------------------------------------------------------------------------
// 模式行为：简单协作（collaborative）与复杂协作（supervised）
// ---------------------------------------------------------------------------

test("collaborative: unassigned user message gets a hint instead of routing", () => {
  const { router, agentRuns, systemMessages, routeStates } = createRouter({ mode: "collaborative" });
  router.process(message("user", "build a login feature"));
  assert.equal(agentRuns.length, 0);
  assert.ok(systemMessages[0]?.includes("@一位数字员工"));
  assert.deepEqual(routeStates, ["ignored"]);
});

test("collaborative: agent handoff routes without any supervisor involvement", () => {
  const { router, agentRuns, systemMessages } = createRouter({ mode: "collaborative" });
  router.process(message("agent", "@蔡一平: please verify", { agentId: "agent1" }));
  assert.deepEqual(agentRuns.map((run) => run.agentId), ["agent2"]);
  assert.equal(systemMessages.length, 0);
});

test("supervised: unassigned user message routes to no employee and stays silent", () => {
  const { router, agentRuns, systemMessages, routeStates } = createRouter({ mode: "supervised" });
  router.process(message("user", "build a login feature"));
  assert.equal(agentRuns.length, 0);
  assert.equal(systemMessages.length, 0);
  assert.deepEqual(routeStates, ["ignored"]);
});
