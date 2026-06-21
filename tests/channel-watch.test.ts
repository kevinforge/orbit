import assert from "node:assert/strict";
import test from "node:test";

import { EventBus } from "../src/core/event-bus.ts";
import { MessageStore } from "../src/core/message-store.ts";
import {
  ChannelWatchService,
  DEBOUNCE_MS,
  MAX_TRIGGERS_PER_CONVERSATION,
} from "../src/core/channel-watch.ts";
import type { AgentId, AgentProfile, AgentStatus, ChatMessage, RunResult } from "../src/shared/types.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createUserMessage(content: string): ChatMessage {
  return {
    id: `msg_user_${Date.now()}`,
    kind: "user",
    content,
    createdAt: new Date().toISOString(),
    status: "sent",
  };
}

function createBlockedMessage(agentId: AgentId): ChatMessage {
  return {
    id: `msg_blocked_${Date.now()}`,
    kind: "agent",
    agentId,
    content: "failed to route",
    createdAt: new Date().toISOString(),
    status: "error",
    routeState: "blocked",
  };
}

function makeSupervisorProfile(id = "supervisor"): AgentProfile {
  return {
    id,
    name: "Supervisor",
    role: "coordinator",
    runtime: "claude-code",
    cwd: "/tmp",
    systemPrompt: "You are a supervisor.",
    permissionProfile: {
      canReadFiles: false,
      canWriteFiles: false,
      canRunCommands: false,
      canInstallDependencies: false,
      canGitCommit: false,
      allowedDirectories: [],
    },
    triggers: {
      onUnassignedMessage: true,
      onAgentBlocked: true,
    },
  };
}

function makePlainAgentProfile(id: AgentId): AgentProfile {
  return {
    id,
    name: id,
    role: "developer",
    runtime: "claude-code",
    cwd: "/tmp",
    systemPrompt: `You are ${id}.`,
    permissionProfile: {
      canReadFiles: true,
      canWriteFiles: true,
      canRunCommands: true,
      canInstallDependencies: true,
      canGitCommit: true,
      allowedDirectories: [],
    },
  };
}

interface EnqueueCall {
  agentId: AgentId;
  prompt: string;
  sourceMessage: ChatMessage;
}

function createMocks(opts?: {
  agentStatuses?: Record<AgentId, AgentStatus>;
  hasQueued?: boolean;
  enqueueCalls?: EnqueueCall[];
}) {
  const hasQueued = opts?.hasQueued ?? false;
  const enqueueCalls: EnqueueCall[] = opts?.enqueueCalls ?? [];

  const agentRegistry = {
    ids: () => Object.keys(opts?.agentStatuses ?? {}),
    has: (id: string) => id in (opts?.agentStatuses ?? {}),
    get: (id: string) => {
      const status = opts?.agentStatuses?.[id];
      if (status === undefined) throw new Error(`Unknown agent: ${id}`);
      return { getStatus: () => status };
    },
  };

  const runManager = {
    hasQueuedRuns: () => hasQueued,
    enqueue: (agentId: AgentId, prompt: string, sourceMessage: ChatMessage) => {
      enqueueCalls.push({ agentId, prompt, sourceMessage });
      return {
        id: `run_${agentId}_${Date.now()}`,
        agentId,
        prompt,
        sourceMessage,
        status: "queued" as const,
        createdAt: new Date().toISOString(),
        resultMessageId: `msg_${Date.now()}`,
        activity: [],
      };
    },
  };

  return { agentRegistry, runManager, enqueueCalls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("zero trigger profiles → zero subscriptions (no-op)", async () => {
  const eventBus = new EventBus();
  const messages = new MessageStore();
  const { agentRegistry, runManager, enqueueCalls } = createMocks({
    agentStatuses: { dev: "idle" },
  });

  // No profiles have triggers
  const profiles = [makePlainAgentProfile("dev")];
  const service = new ChannelWatchService(
    "conv-1",
    agentRegistry as any,
    runManager as any,
    messages,
    eventBus,
    profiles,
  );

  // Publish events — nothing should happen
  eventBus.publish({
    type: "message.created",
    conversationId: "conv-1",
    message: createUserMessage("hello"),
  });

  assert.equal(enqueueCalls.length, 0);
  service.dispose();
});

test("run.completed without @agent: triggers supervisor when channel idle", async () => {
  const eventBus = new EventBus();
  const messages = new MessageStore();
  const { agentRegistry, runManager, enqueueCalls } = createMocks({
    agentStatuses: { supervisor: "idle", dev: "idle" },
  });

  const profiles = [makeSupervisorProfile("supervisor"), makePlainAgentProfile("dev")];
  const service = new ChannelWatchService(
    "conv-1",
    agentRegistry as any,
    runManager as any,
    messages,
    eventBus,
    profiles,
  );

  // Agent dev completes with a reply that has NO @agent: markers
  const agentReply = messages.add({
    kind: "agent",
    agentId: "dev",
    content: "Done implementing the feature.",
    status: "done",
    runId: "run_1",
    runStatus: "completed",
  });

  eventBus.publish({
    type: "run.completed",
    conversationId: "conv-1",
    agentId: "dev",
    runId: "run_1",
    resultMessageId: agentReply.id,
  });

  assert.equal(enqueueCalls.length, 1);
  assert.equal(enqueueCalls[0].agentId, "supervisor");
  assert.ok(enqueueCalls[0].prompt.includes("Supervisor Check"));

  service.dispose();
});

test("run.completed with @agent: does NOT trigger supervisor", async () => {
  const eventBus = new EventBus();
  const messages = new MessageStore();
  const { agentRegistry, runManager, enqueueCalls } = createMocks({
    agentStatuses: { supervisor: "idle", dev: "idle", tester: "idle" },
  });

  const profiles = [makeSupervisorProfile("supervisor"), makePlainAgentProfile("dev"), makePlainAgentProfile("tester")];
  const service = new ChannelWatchService(
    "conv-1",
    agentRegistry as any,
    runManager as any,
    messages,
    eventBus,
    profiles,
  );

  // Agent dev completes and already delegated work via @agent:
  const agentReply = messages.add({
    kind: "agent",
    agentId: "dev",
    content: "API done. @tester: please verify.",
    status: "done",
    runId: "run_1",
    runStatus: "completed",
  });

  eventBus.publish({
    type: "run.completed",
    conversationId: "conv-1",
    agentId: "dev",
    runId: "run_1",
    resultMessageId: agentReply.id,
  });

  assert.equal(enqueueCalls.length, 0);
  service.dispose();
});

test("run.completed at max route depth still triggers supervisor wrap-up", async () => {
  const eventBus = new EventBus();
  const messages = new MessageStore();
  const { agentRegistry, runManager, enqueueCalls } = createMocks({
    agentStatuses: { supervisor: "idle", dev: "idle" },
  });

  const profiles = [makeSupervisorProfile("supervisor"), makePlainAgentProfile("dev")];
  const service = new ChannelWatchService(
    "conv-1",
    agentRegistry as any,
    runManager as any,
    messages,
    eventBus,
    profiles,
  );

  // The deepest delegation (routeDepth = MAX_ROUTE_DEPTH) finishes. The
  // supervisor must still run its wrap-up check — its own run resets to a low
  // route depth (rate-limited by maxTriggers), so the completing message's
  // depth must not gate the trigger.
  const agentReply = messages.add({
    kind: "agent",
    agentId: "dev",
    content: "Deepest delegation done.",
    status: "done",
    runId: "run_deep",
    runStatus: "completed",
    routeDepth: 10,
  });

  eventBus.publish({
    type: "run.completed",
    conversationId: "conv-1",
    agentId: "dev",
    runId: "run_deep",
    resultMessageId: agentReply.id,
  });

  assert.equal(enqueueCalls.length, 1);
  assert.equal(enqueueCalls[0].agentId, "supervisor");

  service.dispose();
});

test("user message without @agent: triggers supervisor", async () => {
  const eventBus = new EventBus();
  const messages = new MessageStore();
  const { agentRegistry, runManager, enqueueCalls } = createMocks({
    agentStatuses: { supervisor: "idle", dev: "idle" },
  });

  const profiles = [makeSupervisorProfile("supervisor"), makePlainAgentProfile("dev")];
  const service = new ChannelWatchService(
    "conv-1",
    agentRegistry as any,
    runManager as any,
    messages,
    eventBus,
    profiles,
  );

  const userMessage = createUserMessage("Build a login feature.");
  eventBus.publish({
    type: "message.created",
    conversationId: "conv-1",
    message: userMessage,
  });

  assert.equal(enqueueCalls.length, 1);
  assert.equal(enqueueCalls[0].agentId, "supervisor");
  assert.equal(enqueueCalls[0].sourceMessage.id, userMessage.id);

  service.dispose();
});

test("user message with @agent: does NOT trigger supervisor", async () => {
  const eventBus = new EventBus();
  const messages = new MessageStore();
  const { agentRegistry, runManager, enqueueCalls } = createMocks({
    agentStatuses: { supervisor: "idle", developer: "idle", tester: "idle" },
  });

  const profiles = [makeSupervisorProfile("supervisor"), makePlainAgentProfile("developer"), makePlainAgentProfile("tester")];
  const service = new ChannelWatchService(
    "conv-1",
    agentRegistry as any,
    runManager as any,
    messages,
    eventBus,
    profiles,
  );

  eventBus.publish({
    type: "message.created",
    conversationId: "conv-1",
    message: createUserMessage("@developer: Build login. @tester: verify."),
  });

  // Should NOT trigger because user already delegated via @agent:
  assert.equal(enqueueCalls.length, 0);

  service.dispose();
});

test("user message resets trigger count", async () => {
  const eventBus = new EventBus();
  const messages = new MessageStore();
  const { agentRegistry, runManager, enqueueCalls } = createMocks({
    agentStatuses: { supervisor: "idle", dev: "idle" },
  });

  const profiles = [makeSupervisorProfile("supervisor"), makePlainAgentProfile("dev")];
  const service = new ChannelWatchService(
    "conv-1",
    agentRegistry as any,
    runManager as any,
    messages,
    eventBus,
    profiles,
  );

  // setTimeout can resolve a touch early on CI runners, dropping the elapsed
  // window right onto the debounce boundary (strict `<` in channel-watch) so the
  // debounce swallows a trigger. Wait a bit past DEBOUNCE_MS to keep this timing
  // test stable under scheduler jitter.
  const settleMs = DEBOUNCE_MS + 100;

  // Trigger supervisor 5 times (max)
  for (let i = 0; i < MAX_TRIGGERS_PER_CONVERSATION; i++) {
    const msg = messages.add({
      kind: "agent",
      agentId: "dev",
      content: "Done.",
      status: "done",
      runId: `run_${i}`,
      runStatus: "completed",
    });

    // Need to advance time past debounce for each trigger
    await sleep(settleMs);

    eventBus.publish({
      type: "run.completed",
      conversationId: "conv-1",
      agentId: "dev",
      runId: `run_${i}`,
      resultMessageId: msg.id,
    });
  }

  assert.equal(enqueueCalls.length, MAX_TRIGGERS_PER_CONVERSATION);

  // Next trigger should be blocked
  const extraMsg = messages.add({
    kind: "agent",
    agentId: "dev",
    content: "Extra.",
    status: "done",
    runId: "run_extra",
    runStatus: "completed",
  });

  await sleep(settleMs);

  eventBus.publish({
    type: "run.completed",
    conversationId: "conv-1",
    agentId: "dev",
    runId: "run_extra",
    resultMessageId: extraMsg.id,
  });

  assert.equal(enqueueCalls.length, MAX_TRIGGERS_PER_CONVERSATION); // still capped

  // User message resets
  eventBus.publish({
    type: "message.created",
    conversationId: "conv-1",
    message: createUserMessage("New task"),
  });

  // The user message without @agent: also triggers supervisor (onUnassignedMessage).
  // So after reset: user message → enqueue #6, then run.completed → enqueue #7.
  const newMsg = messages.add({
    kind: "agent",
    agentId: "dev",
    content: "Done with new task.",
    status: "done",
    runId: "run_after_reset",
    runStatus: "completed",
  });

  await sleep(settleMs);

  eventBus.publish({
    type: "run.completed",
    conversationId: "conv-1",
    agentId: "dev",
    runId: "run_after_reset",
    resultMessageId: newMsg.id,
  });

  // 5 capped + 1 user-message trigger + 1 post-reset run.completed = 7
  assert.equal(enqueueCalls.length, MAX_TRIGGERS_PER_CONVERSATION + 2);

  service.dispose();
});

test("isChannelTrulyIdle returns false when another agent is running", async () => {
  const eventBus = new EventBus();
  const messages = new MessageStore();
  const { agentRegistry, runManager, enqueueCalls } = createMocks({
    agentStatuses: { supervisor: "idle", dev: "running", tester: "idle" },
  });

  const profiles = [
    makeSupervisorProfile("supervisor"),
    makePlainAgentProfile("dev"),
    makePlainAgentProfile("tester"),
  ];
  const service = new ChannelWatchService(
    "conv-1",
    agentRegistry as any,
    runManager as any,
    messages,
    eventBus,
    profiles,
  );

  const msg = messages.add({
    kind: "agent",
    agentId: "tester",
    content: "Tests pass.",
    status: "done",
    runId: "run_1",
    runStatus: "completed",
  });

  eventBus.publish({
    type: "run.completed",
    conversationId: "conv-1",
    agentId: "tester",
    runId: "run_1",
    resultMessageId: msg.id,
  });

  // Should NOT trigger — dev is still running
  assert.equal(enqueueCalls.length, 0);

  service.dispose();
});

test("isChannelTrulyIdle returns false when runs are queued", async () => {
  const eventBus = new EventBus();
  const messages = new MessageStore();
  const { agentRegistry, runManager, enqueueCalls } = createMocks({
    agentStatuses: { supervisor: "idle", dev: "idle" },
    hasQueued: true,
  });

  const profiles = [makeSupervisorProfile("supervisor"), makePlainAgentProfile("dev")];
  const service = new ChannelWatchService(
    "conv-1",
    agentRegistry as any,
    runManager as any,
    messages,
    eventBus,
    profiles,
  );

  const msg = messages.add({
    kind: "agent",
    agentId: "dev",
    content: "Done.",
    status: "done",
    runId: "run_1",
    runStatus: "completed",
  });

  eventBus.publish({
    type: "run.completed",
    conversationId: "conv-1",
    agentId: "dev",
    runId: "run_1",
    resultMessageId: msg.id,
  });

  // Should NOT trigger — runs are queued
  assert.equal(enqueueCalls.length, 0);

  service.dispose();
});

test("supervisor not idle → skip trigger", async () => {
  const eventBus = new EventBus();
  const messages = new MessageStore();
  const { agentRegistry, runManager, enqueueCalls } = createMocks({
    agentStatuses: { supervisor: "running", dev: "idle" },
  });

  const profiles = [makeSupervisorProfile("supervisor"), makePlainAgentProfile("dev")];
  const service = new ChannelWatchService(
    "conv-1",
    agentRegistry as any,
    runManager as any,
    messages,
    eventBus,
    profiles,
  );

  const msg = messages.add({
    kind: "agent",
    agentId: "dev",
    content: "Done.",
    status: "done",
    runId: "run_1",
    runStatus: "completed",
  });

  eventBus.publish({
    type: "run.completed",
    conversationId: "conv-1",
    agentId: "dev",
    runId: "run_1",
    resultMessageId: msg.id,
  });

  // Should NOT trigger — supervisor is busy
  assert.equal(enqueueCalls.length, 0);

  service.dispose();
});

test("debounce coalesces rapid triggers", async () => {
  const eventBus = new EventBus();
  const messages = new MessageStore();
  const { agentRegistry, runManager, enqueueCalls } = createMocks({
    agentStatuses: { supervisor: "idle", dev: "idle" },
  });

  const profiles = [makeSupervisorProfile("supervisor"), makePlainAgentProfile("dev")];
  const service = new ChannelWatchService(
    "conv-1",
    agentRegistry as any,
    runManager as any,
    messages,
    eventBus,
    profiles,
  );

  // Fire two rapid run.completed events without waiting
  const msg1 = messages.add({
    kind: "agent",
    agentId: "dev",
    content: "Part 1 done.",
    status: "done",
    runId: "run_1",
    runStatus: "completed",
  });

  eventBus.publish({
    type: "run.completed",
    conversationId: "conv-1",
    agentId: "dev",
    runId: "run_1",
    resultMessageId: msg1.id,
  });

  const msg2 = messages.add({
    kind: "agent",
    agentId: "dev",
    content: "Part 2 done.",
    status: "done",
    runId: "run_2",
    runStatus: "completed",
  });

  eventBus.publish({
    type: "run.completed",
    conversationId: "conv-1",
    agentId: "dev",
    runId: "run_2",
    resultMessageId: msg2.id,
  });

  // Only one enqueue (debounce coalesces the second)
  assert.equal(enqueueCalls.length, 1);

  service.dispose();
});

test("supervisor completing does not trigger itself (self-trigger prevention)", async () => {
  const eventBus = new EventBus();
  const messages = new MessageStore();
  const { agentRegistry, runManager, enqueueCalls } = createMocks({
    agentStatuses: { supervisor: "idle", dev: "idle" },
  });

  const profiles = [makeSupervisorProfile("supervisor"), makePlainAgentProfile("dev")];
  const service = new ChannelWatchService(
    "conv-1",
    agentRegistry as any,
    runManager as any,
    messages,
    eventBus,
    profiles,
  );

  // Supervisor completes with a plain message (no @agent:)
  const supervisorReply = messages.add({
    kind: "agent",
    agentId: "supervisor",
    content: "All tasks are complete.",
    status: "done",
    runId: "run_supervisor_1",
    runStatus: "completed",
  });

  eventBus.publish({
    type: "run.completed",
    conversationId: "conv-1",
    agentId: "supervisor",
    runId: "run_supervisor_1",
    resultMessageId: supervisorReply.id,
  });

  // Should NOT trigger itself — ctx.agentId === agentId guard
  assert.equal(enqueueCalls.length, 0);

  service.dispose();
});

test("trigger count caps at MAX_TRIGGERS and final prompt indicates last", async () => {
  const eventBus = new EventBus();
  const messages = new MessageStore();
  const { agentRegistry, runManager, enqueueCalls } = createMocks({
    agentStatuses: { supervisor: "idle", dev: "idle" },
  });

  const profiles = [makeSupervisorProfile("supervisor"), makePlainAgentProfile("dev")];
  const service = new ChannelWatchService(
    "conv-1",
    agentRegistry as any,
    runManager as any,
    messages,
    eventBus,
    profiles,
  );

  // Same debounce-jitter margin as the reset-count test — see note there.
  const settleMs = DEBOUNCE_MS + 100;

  // Trigger up to max
  for (let i = 0; i < MAX_TRIGGERS_PER_CONVERSATION; i++) {
    const msg = messages.add({
      kind: "agent",
      agentId: "dev",
      content: "Done.",
      status: "done",
      runId: `run_${i}`,
      runStatus: "completed",
    });

    await sleep(settleMs);

    eventBus.publish({
      type: "run.completed",
      conversationId: "conv-1",
      agentId: "dev",
      runId: `run_${i}`,
      resultMessageId: msg.id,
    });
  }

  assert.equal(enqueueCalls.length, MAX_TRIGGERS_PER_CONVERSATION);
  assert.ok(
    enqueueCalls[MAX_TRIGGERS_PER_CONVERSATION - 1].prompt.includes("FINAL"),
    "Last prompt should indicate it's the final check",
  );

  service.dispose();
});

test("dispose cleans up subscriptions", async () => {
  const eventBus = new EventBus();
  const messages = new MessageStore();
  const { agentRegistry, runManager, enqueueCalls } = createMocks({
    agentStatuses: { supervisor: "idle", dev: "idle" },
  });

  const profiles = [makeSupervisorProfile("supervisor"), makePlainAgentProfile("dev")];
  const service = new ChannelWatchService(
    "conv-1",
    agentRegistry as any,
    runManager as any,
    messages,
    eventBus,
    profiles,
  );

  service.dispose();

  // Events after dispose should be ignored
  const msg = messages.add({
    kind: "agent",
    agentId: "dev",
    content: "Done after dispose.",
    status: "done",
    runId: "run_1",
    runStatus: "completed",
  });

  eventBus.publish({
    type: "run.completed",
    conversationId: "conv-1",
    agentId: "dev",
    runId: "run_1",
    resultMessageId: msg.id,
  });

  assert.equal(enqueueCalls.length, 0);
});

test("does not react to events from other conversations", async () => {
  const eventBus = new EventBus();
  const messages = new MessageStore();
  const { agentRegistry, runManager, enqueueCalls } = createMocks({
    agentStatuses: { supervisor: "idle", dev: "idle" },
  });

  const profiles = [makeSupervisorProfile("supervisor"), makePlainAgentProfile("dev")];
  const service = new ChannelWatchService(
    "conv-1",
    agentRegistry as any,
    runManager as any,
    messages,
    eventBus,
    profiles,
  );

  // Event from conv-2 should not trigger supervisor in conv-1
  eventBus.publish({
    type: "run.completed",
    conversationId: "conv-2",
    agentId: "dev",
    runId: "run_other",
    resultMessageId: "msg_other",
  });

  assert.equal(enqueueCalls.length, 0);

  service.dispose();
});

test("isChannelTrulyIdle returns true when all non-supervisor agents are idle and no queued runs", async () => {
  const eventBus = new EventBus();
  const messages = new MessageStore();
  const { agentRegistry, runManager, enqueueCalls } = createMocks({
    agentStatuses: { supervisor: "idle", dev: "idle", tester: "idle" },
    hasQueued: false,
  });

  const profiles = [
    makeSupervisorProfile("supervisor"),
    makePlainAgentProfile("dev"),
    makePlainAgentProfile("tester"),
  ];
  const service = new ChannelWatchService(
    "conv-1",
    agentRegistry as any,
    runManager as any,
    messages,
    eventBus,
    profiles,
  );

  assert.equal(service.isChannelTrulyIdle("supervisor"), true);

  service.dispose();
});

test("isChannelTrulyIdle returns false when a non-supervisor agent is running", async () => {
  const eventBus = new EventBus();
  const messages = new MessageStore();
  const { agentRegistry } = createMocks({
    agentStatuses: { supervisor: "idle", dev: "running", tester: "idle" },
  });

  const { runManager } = createMocks();

  const profiles = [
    makeSupervisorProfile("supervisor"),
    makePlainAgentProfile("dev"),
    makePlainAgentProfile("tester"),
  ];
  const service = new ChannelWatchService(
    "conv-1",
    agentRegistry as any,
    runManager as any,
    messages,
    eventBus,
    profiles,
  );

  assert.equal(service.isChannelTrulyIdle("supervisor"), false);

  service.dispose();
});

test("blocked message triggers supervisor via onAgentBlocked", async () => {
  const eventBus = new EventBus();
  const messages = new MessageStore();
  const { agentRegistry, runManager, enqueueCalls } = createMocks({
    agentStatuses: { supervisor: "idle", dev: "idle" },
  });

  const profiles = [makeSupervisorProfile("supervisor"), makePlainAgentProfile("dev")];
  const service = new ChannelWatchService(
    "conv-1",
    agentRegistry as any,
    runManager as any,
    messages,
    eventBus,
    profiles,
  );

  eventBus.publish({
    type: "message.updated",
    conversationId: "conv-1",
    message: createBlockedMessage("dev"),
  });

  assert.equal(enqueueCalls.length, 1);
  assert.equal(enqueueCalls[0].agentId, "supervisor");

  service.dispose();
});

test("agent with triggers.disabled → not used as supervisor", async () => {
  const eventBus = new EventBus();
  const messages = new MessageStore();
  const { agentRegistry, runManager, enqueueCalls } = createMocks({
    agentStatuses: { reviewer: "idle", dev: "idle" },
  });

  // Agent has triggers but onAgentBlocked is false and onUnassignedMessage not set
  const reviewerProfile: AgentProfile = {
    ...makePlainAgentProfile("reviewer"),
    triggers: { onAgentBlocked: false },
  };

  const profiles = [reviewerProfile, makePlainAgentProfile("dev")];
  const service = new ChannelWatchService(
    "conv-1",
    agentRegistry as any,
    runManager as any,
    messages,
    eventBus,
    profiles,
  );

  // Blocked message should NOT trigger agent with onAgentBlocked: false
  eventBus.publish({
    type: "message.created",
    conversationId: "conv-1",
    message: createBlockedMessage("dev"),
  });

  assert.equal(enqueueCalls.length, 0);

  service.dispose();
});

test("hasAssignmentMarker only matches known agent IDs — @agent: reference text does not suppress trigger", async () => {
  const eventBus = new EventBus();
  const messages = new MessageStore();
  const { agentRegistry, runManager, enqueueCalls } = createMocks({
    agentStatuses: { supervisor: "idle", architect: "idle", dev: "idle" },
  });

  const profiles = [makeSupervisorProfile("supervisor"), makePlainAgentProfile("architect"), makePlainAgentProfile("dev")];
  const service = new ChannelWatchService(
    "conv-1",
    agentRegistry as any,
    runManager as any,
    messages,
    eventBus,
    profiles,
  );

  // Architect's reply mentions "@agent:" as reference text — "agent" is NOT a known ID
  const architectReply = messages.add({
    kind: "agent",
    agentId: "architect",
    content: "The @agent: convention is used for assigning work to specific agents.",
    status: "done",
    runId: "run_1",
    runStatus: "completed",
  });

  eventBus.publish({
    type: "run.completed",
    conversationId: "conv-1",
    agentId: "architect",
    runId: "run_1",
    resultMessageId: architectReply.id,
  });

  // Should trigger — @agent: matched "agent" but "agent" is not a known ID
  assert.equal(enqueueCalls.length, 1);
  assert.equal(enqueueCalls[0].agentId, "supervisor");

  service.dispose();
});

test("suppressed run.completed (suppressFollowupRouting=true) does NOT trigger supervisor", async () => {
  const eventBus = new EventBus();
  const messages = new MessageStore();
  const { agentRegistry, runManager, enqueueCalls } = createMocks({
    agentStatuses: { supervisor: "idle", dev: "idle" },
  });

  const profiles = [makeSupervisorProfile("supervisor"), makePlainAgentProfile("dev")];
  const service = new ChannelWatchService(
    "conv-1",
    agentRegistry as any,
    runManager as any,
    messages,
    eventBus,
    profiles,
  );

  // Dev completes with no @agent: but the run is suppressed (interrupted)
  const agentReply = messages.add({
    kind: "agent",
    agentId: "dev",
    content: "Done implementing. Need review.",
    status: "done",
    runId: "run_suppressed",
    runStatus: "completed",
  });

  eventBus.publish({
    type: "run.completed",
    conversationId: "conv-1",
    agentId: "dev",
    runId: "run_suppressed",
    resultMessageId: agentReply.id,
    suppressFollowupRouting: true,
  });

  // Should NOT trigger supervisor because the run was suppressed
  assert.equal(enqueueCalls.length, 0);

  service.dispose();
});

test("hasAssignmentMarker matches @user: as known ID — @user: in reply suppresses trigger", async () => {
  const eventBus = new EventBus();
  const messages = new MessageStore();
  const { agentRegistry, runManager, enqueueCalls } = createMocks({
    agentStatuses: { supervisor: "idle", architect: "idle" },
  });

  const profiles = [makeSupervisorProfile("supervisor"), makePlainAgentProfile("architect")];
  const service = new ChannelWatchService(
    "conv-1",
    agentRegistry as any,
    runManager as any,
    messages,
    eventBus,
    profiles,
  );

  // Supervisor concludes with @user:
  const supervisorReply = messages.add({
    kind: "agent",
    agentId: "supervisor",
    content: "@user: Login feature is complete. All tasks done.",
    status: "done",
    runId: "run_sup",
    runStatus: "completed",
  });

  eventBus.publish({
    type: "run.completed",
    conversationId: "conv-1",
    agentId: "supervisor",
    runId: "run_sup",
    resultMessageId: supervisorReply.id,
  });

  // Should NOT trigger — @user: matches known ID "user" → self-trigger suppressed
  assert.equal(enqueueCalls.length, 0);

  service.dispose();
});

test("unassigned user message triggers supervisor even when other agent is running (relaxIdleCheck)", async () => {
  const eventBus = new EventBus();
  const messages = new MessageStore();
  const { agentRegistry, runManager, enqueueCalls } = createMocks({
    agentStatuses: { supervisor: "idle", dev: "running" },
  });

  const profiles = [makeSupervisorProfile("supervisor"), makePlainAgentProfile("dev")];
  const service = new ChannelWatchService(
    "conv-1",
    agentRegistry as any,
    runManager as any,
    messages,
    eventBus,
    profiles,
  );

  // Verify that isChannelTrulyIdle would return false
  assert.equal(service.isChannelTrulyIdle("supervisor"), false);

  // But user unassigned message should still trigger supervisor
  eventBus.publish({
    type: "message.created",
    conversationId: "conv-1",
    message: createUserMessage("What's the status?"),
  });

  assert.equal(enqueueCalls.length, 1);
  assert.equal(enqueueCalls[0].agentId, "supervisor");

  service.dispose();
});

test("unassigned user message enqueues supervisor even when supervisor is running", async () => {
  const eventBus = new EventBus();
  const messages = new MessageStore();
  const { agentRegistry, runManager, enqueueCalls } = createMocks({
    agentStatuses: { supervisor: "running", dev: "running" },
  });

  const profiles = [makeSupervisorProfile("supervisor"), makePlainAgentProfile("dev")];
  const service = new ChannelWatchService(
    "conv-1",
    agentRegistry as any,
    runManager as any,
    messages,
    eventBus,
    profiles,
  );

  eventBus.publish({
    type: "message.created",
    conversationId: "conv-1",
    message: createUserMessage("Hello?"),
  });

  // Should still enqueue — supervisor is busy but runManager queues it
  assert.equal(enqueueCalls.length, 1);
  assert.equal(enqueueCalls[0].agentId, "supervisor");

  service.dispose();
});

test("unassigned user message does NOT enqueue supervisor in error or stopped state", async () => {
  for (const badStatus of ["error", "stopped"] as AgentStatus[]) {
    const eventBus = new EventBus();
    const messages = new MessageStore();
    const { agentRegistry, runManager, enqueueCalls } = createMocks({
      agentStatuses: { supervisor: badStatus, dev: "idle" },
    });

    const profiles = [makeSupervisorProfile("supervisor"), makePlainAgentProfile("dev")];
    const service = new ChannelWatchService(
      "conv-1",
      agentRegistry as any,
      runManager as any,
      messages,
      eventBus,
      profiles,
    );

    eventBus.publish({
      type: "message.created",
      conversationId: "conv-1",
      message: createUserMessage("Hello?"),
    });

    assert.equal(enqueueCalls.length, 0, `Expected no enqueue for supervisor status=${badStatus}`);
    service.dispose();
  }
});

test("no supervisor configured — unassigned user message does not trigger any enqueue", async () => {
  const eventBus = new EventBus();
  const messages = new MessageStore();
  const { agentRegistry, runManager, enqueueCalls } = createMocks({
    agentStatuses: { dev: "idle" },
  });

  // Only a plain agent, no supervisor with triggers
  const profiles = [makePlainAgentProfile("dev")];
  const service = new ChannelWatchService(
    "conv-1",
    agentRegistry as any,
    runManager as any,
    messages,
    eventBus,
    profiles,
  );

  eventBus.publish({
    type: "message.created",
    conversationId: "conv-1",
    message: createUserMessage("Unassigned message"),
  });

  assert.equal(enqueueCalls.length, 0);
  service.dispose();
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Issue #80: @user: from non-supervisor should NOT suppress supervisor trigger
// ---------------------------------------------------------------------------

test("Issue #80: agent reply with @user: should NOT suppress supervisor trigger", async () => {
  const eventBus = new EventBus();
  const messages = new MessageStore();
  const { agentRegistry, runManager, enqueueCalls } = createMocks({
    agentStatuses: { supervisor: "idle", developer: "idle" },
  });

  const profiles = [makeSupervisorProfile("supervisor"), makePlainAgentProfile("developer")];
  const service = new ChannelWatchService(
    "conv-1",
    agentRegistry as any,
    runManager as any,
    messages,
    eventBus,
    profiles,
  );

  // Developer completes with a reply that contains @user:
  // This should NOT suppress supervisor trigger because only supervisor's own
  // @user: is a closure signal
  const agentReply = messages.add({
    kind: "agent",
    agentId: "developer",
    content: "I've implemented the feature. I'll let @user: know about the completion.",
    status: "done",
    runId: "run_1",
    runStatus: "completed",
  });

  eventBus.publish({
    type: "run.completed",
    conversationId: "conv-1",
    agentId: "developer",
    runId: "run_1",
    resultMessageId: agentReply.id,
  });

  // Supervisor SHOULD be triggered even though developer mentioned @user:
  assert.equal(enqueueCalls.length, 1, "supervisor should be triggered when developer mentions @user:");
  assert.equal(enqueueCalls[0].agentId, "supervisor");
  assert.ok(enqueueCalls[0].prompt.includes("Supervisor Check"));

  service.dispose();
});

test("supervisor's own @user: should suppress further supervisor triggers", async () => {
  const eventBus = new EventBus();
  const messages = new MessageStore();
  const { agentRegistry, runManager, enqueueCalls } = createMocks({
    agentStatuses: { supervisor: "idle" },
  });

  const profiles = [makeSupervisorProfile("supervisor")];
  const service = new ChannelWatchService(
    "conv-1",
    agentRegistry as any,
    runManager as any,
    messages,
    eventBus,
    profiles,
  );

  // Supervisor completes with @user: closure signal
  const agentReply = messages.add({
    kind: "agent",
    agentId: "supervisor",
    content: "@user: All tasks are complete. The feature has been implemented and tested.",
    status: "done",
    runId: "run_1",
    runStatus: "completed",
  });

  eventBus.publish({
    type: "run.completed",
    conversationId: "conv-1",
    agentId: "supervisor",
    runId: "run_1",
    resultMessageId: agentReply.id,
  });

  // Supervisor should NOT be triggered again because it said @user: (closure signal)
  assert.equal(enqueueCalls.length, 0, "supervisor's own @user: should suppress further triggers");

  service.dispose();
});

// ---------------------------------------------------------------------------
// Issue #82: Supervisor should handle run.failed events
// ---------------------------------------------------------------------------

test("Issue #82: run.failed triggers supervisor with onRunFailed configured", async () => {
  const eventBus = new EventBus();
  const messages = new MessageStore();
  const { agentRegistry, runManager, enqueueCalls } = createMocks({
    agentStatuses: { supervisor: "idle", developer: "error" },
  });

  // Supervisor profile with onRunFailed trigger
  const supervisorProfile: AgentProfile = {
    id: "supervisor",
    name: "Supervisor",
    role: "coordinator",
    runtime: "claude-code",
    cwd: "/tmp",
    systemPrompt: "You are a supervisor.",
    permissionProfile: {
      canReadFiles: false,
      canWriteFiles: false,
      canRunCommands: false,
      canInstallDependencies: false,
      canGitCommit: false,
      allowedDirectories: [],
    },
    triggers: {
      onRunFailed: true,
    },
  };

  const profiles = [supervisorProfile, makePlainAgentProfile("developer")];
  const service = new ChannelWatchService(
    "conv-1",
    agentRegistry as any,
    runManager as any,
    messages,
    eventBus,
    profiles,
  );

  const source = messages.add({ kind: "user", content: "Fix the API", status: "sent" });
  const failedRun = messages.add({
    kind: "agent",
    agentId: "developer",
    content: "developer failed",
    status: "error",
    runId: "run_1",
    runStatus: "failed",
    parentMessageId: source.id,
    completedAt: new Date().toISOString(),
  });

  // Developer run fails
  eventBus.publish({
    type: "run.failed",
    conversationId: "conv-1",
    agentId: "developer",
    runId: "run_1",
    error: "API rate limit exceeded",
  });

  // Supervisor should be triggered because onRunFailed is configured
  assert.equal(enqueueCalls.length, 1, "supervisor should be triggered when agent run fails");
  assert.equal(enqueueCalls[0].agentId, "supervisor");
  // The prompt should be a supervisor check prompt
  assert.ok(enqueueCalls[0].prompt.includes("Supervisor Check"));
  // Preserve the persisted failed run as the parent so supervisor remains in the task chain.
  assert.equal(enqueueCalls[0].sourceMessage.id, failedRun.id);

  service.dispose();
});

test("run.failed does NOT trigger supervisor without onRunFailed configured", async () => {
  const eventBus = new EventBus();
  const messages = new MessageStore();
  const { agentRegistry, runManager, enqueueCalls } = createMocks({
    agentStatuses: { supervisor: "idle", developer: "error" },
  });

  // Supervisor profile WITHOUT onRunFailed trigger
  const supervisorProfile: AgentProfile = {
    id: "supervisor",
    name: "Supervisor",
    role: "coordinator",
    runtime: "claude-code",
    cwd: "/tmp",
    systemPrompt: "You are a supervisor.",
    permissionProfile: {
      canReadFiles: false,
      canWriteFiles: false,
      canRunCommands: false,
      canInstallDependencies: false,
      canGitCommit: false,
      allowedDirectories: [],
    },
    triggers: {
      onUnassignedMessage: true,
      // onRunFailed is NOT configured
    },
  };

  const profiles = [supervisorProfile, makePlainAgentProfile("developer")];
  const service = new ChannelWatchService(
    "conv-1",
    agentRegistry as any,
    runManager as any,
    messages,
    eventBus,
    profiles,
  );

  // Developer run fails
  eventBus.publish({
    type: "run.failed",
    conversationId: "conv-1",
    agentId: "developer",
    runId: "run_1",
    error: "API rate limit exceeded",
  });

  // Supervisor should NOT be triggered because onRunFailed is not configured
  assert.equal(enqueueCalls.length, 0, "supervisor should NOT be triggered when onRunFailed is not configured");

  service.dispose();
});
