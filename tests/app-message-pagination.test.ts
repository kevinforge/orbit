import test from "node:test";
import assert from "node:assert/strict";

import {
  getAgentHandoffSummary,
  getConversationRunningLabel,
  getWorkspaceCreationAction,
  mergeOlderMessagesPage,
  resolveActiveView,
} from "../src/ui/App.tsx";
import type { AgentState, AppState, ChatMessage, MessagePage, RunningSummary } from "../src/shared/types.ts";

function message(id: string, content: string): ChatMessage {
  return { id, kind: "user", content, createdAt: `2026-01-01T00:00:0${id.slice(-1)}.000Z` };
}

function state(conversationId: string, messages: ChatMessage[]): AppState {
  return {
    workspace: { id: "ws1", name: "Workspace", path: "D:/project" },
    conversation: { id: conversationId, name: conversationId },
    messages,
    messageHistory: { hasOlderMessages: true, olderCursor: messages[0]?.id ?? null },
    agents: [],
    terminal: {},
    runningSummaries: [],
    runtimeAvailability: [],
  };
}

test("mergeOlderMessagesPage ignores stale responses after conversation switch", () => {
  const current = state("conv2", [message("msg_000003", "current")]);
  const page: MessagePage = {
    messages: [message("msg_000001", "stale")],
    hasOlderMessages: false,
    olderCursor: null,
  };

  const next = mergeOlderMessagesPage(current, { workspaceId: "ws1", conversationId: "conv1" }, page);

  assert.equal(next, current);
});

test("mergeOlderMessagesPage prepends older messages and deduplicates current messages", () => {
  const current = state("conv1", [message("msg_000002", "existing"), message("msg_000003", "current")]);
  const page: MessagePage = {
    messages: [message("msg_000001", "older"), message("msg_000002", "existing")],
    hasOlderMessages: false,
    olderCursor: null,
  };

  const next = mergeOlderMessagesPage(current, { workspaceId: "ws1", conversationId: "conv1" }, page);

  assert.deepEqual(next.messages.map((m) => m.id), ["msg_000001", "msg_000002", "msg_000003"]);
  assert.deepEqual(next.messageHistory, { hasOlderMessages: false, olderCursor: null });
});

test("workspace creation falls back to blank creation when presets are unavailable", () => {
  assert.deepEqual(getWorkspaceCreationAction([]), { kind: "create" });
});

test("work analysis view is restored after a page reload", () => {
  assert.equal(resolveActiveView("analysis"), "analysis");
});

test("unknown persisted views fall back to the conversation", () => {
  assert.equal(resolveActiveView(null), "conversation");
  assert.equal(resolveActiveView("unknown"), "conversation");
});

const agents: AgentState[] = [
  { id: "developer", label: "开发", runtime: "claude-code", status: "running", role: "developer" },
  { id: "tester", label: "测试", runtime: "codebuddy", status: "running", role: "tester" },
];

test("conversation running label lists employee display names once in summary order", () => {
  const summaries: RunningSummary[] = [
    { workspaceId: "ws1", conversationId: "conv1", runningAgentIds: ["tester", "developer", "tester"] },
  ];

  assert.equal(getConversationRunningLabel(summaries, agents, "ws1", "conv1"), "数字员工正在工作：测试、开发");
});

test("conversation running label falls back to an unknown employee id", () => {
  const summaries: RunningSummary[] = [
    { workspaceId: "ws1", conversationId: "conv1", runningAgentIds: ["custom-agent"] },
  ];

  assert.equal(getConversationRunningLabel(summaries, agents, "ws1", "conv1"), "数字员工正在工作：custom-agent");
});

test("conversation running label is absent when the conversation has no active employees", () => {
  const summaries: RunningSummary[] = [
    { workspaceId: "ws1", conversationId: "conv2", runningAgentIds: ["developer"] },
  ];

  assert.equal(getConversationRunningLabel(summaries, agents, "ws1", "conv1"), null);
});

test("agent handoff summary describes direct user assignments", () => {
  const source = message("msg_000001", "@developer: implement this");
  const agentMessage: ChatMessage = {
    id: "msg_000002",
    kind: "agent",
    agentId: "developer",
    content: "developer is working...",
    createdAt: "2026-01-01T00:00:02.000Z",
    parentMessageId: source.id,
    routeDepth: 1,
  };

  assert.equal(
    getAgentHandoffSummary(agentMessage, source, new Map()),
    "用户指派 · 来自 用户消息 #000001 · 第 1 层",
  );
});

test("agent handoff summary describes agent-to-agent handoff without internal route names", () => {
  const source: ChatMessage = {
    id: "msg_000010",
    kind: "agent",
    agentId: "pm",
    content: "@developer: build this",
    createdAt: "2026-01-01T00:00:10.000Z",
  };
  const agentMessage: ChatMessage = {
    id: "msg_000011",
    kind: "agent",
    agentId: "developer",
    content: "developer is working...",
    createdAt: "2026-01-01T00:00:11.000Z",
    parentMessageId: source.id,
    routeDepth: 2,
  };
  const agentsById = new Map([["pm", { id: "pm", label: "产品经理" }]]);

  const summary = getAgentHandoffSummary(agentMessage, source, agentsById);

  assert.equal(summary, "数字员工交接 · 来自 产品经理 的消息 #000010 · 第 2 层");
  assert.ok(!summary?.includes("routeState"));
  assert.ok(!summary?.includes("parentMessageId"));
});

test("agent handoff summary falls back when parent message is not loaded", () => {
  const agentMessage: ChatMessage = {
    id: "msg_000011",
    kind: "agent",
    agentId: "developer",
    content: "developer is working...",
    createdAt: "2026-01-01T00:00:11.000Z",
    parentMessageId: "msg_000010",
    routeDepth: 2,
  };

  assert.equal(
    getAgentHandoffSummary(agentMessage, undefined, new Map()),
    "上游消息 · 来自 消息 #000010 · 第 2 层",
  );
});
