import test from "node:test";
import assert from "node:assert/strict";

import { getAgentHandoffSummary, getWorkspaceCreationAction, mergeOlderMessagesPage } from "../src/ui/App.tsx";
import type { AppState, ChatMessage, MessagePage } from "../src/shared/types.ts";

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
