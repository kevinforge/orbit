import test from "node:test";
import assert from "node:assert/strict";

import {
  getAgentHandoffSummary,
  getConversationRunningLabel,
  getWorkspaceCreationAction,
  mergeOlderMessagesPage,
  resolveActiveView,
  resolveApprovalMode,
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
    agents: [], terminal: {}, runningSummaries: [], runtimeAvailability: [], pendingPermissions: [], pendingElicitations: [],
  };
}

test("approval and view preferences fall back safely", () => {
  assert.equal(resolveApprovalMode(null), "ask");
  assert.equal(resolveApprovalMode("full-access"), "full-access");
  assert.equal(resolveApprovalMode("unknown"), "ask");
  assert.equal(resolveActiveView("analysis"), "analysis");
  assert.equal(resolveActiveView("unknown"), "conversation");
});

test("workspace creation falls back to blank creation when presets are unavailable", () => {
  assert.deepEqual(getWorkspaceCreationAction([]), { kind: "create" });
});

test("older pages ignore stale conversations and deduplicate current messages", () => {
  const current = state("conv2", [message("msg_000003", "current")]);
  const page: MessagePage = { messages: [message("msg_000001", "stale")], hasOlderMessages: false, olderCursor: null };
  assert.equal(mergeOlderMessagesPage(current, { workspaceId: "ws1", conversationId: "conv1" }, page), current);

  const next = mergeOlderMessagesPage(
    state("conv1", [message("msg_000002", "existing"), message("msg_000003", "current")]),
    { workspaceId: "ws1", conversationId: "conv1" },
    { messages: [message("msg_000001", "older"), message("msg_000002", "existing")], hasOlderMessages: false, olderCursor: null },
  );
  assert.deepEqual(next.messages.map((item) => item.id), ["msg_000001", "msg_000002", "msg_000003"]);
});

const agents: AgentState[] = [
  { id: "implementation", label: "开发实现", runtime: "claude-code", status: "running" },
  { id: "verification", label: "质量验证", runtime: "codebuddy", status: "running" },
];

test("running summaries use employee display names once in summary order", () => {
  const summaries: RunningSummary[] = [{ workspaceId: "ws1", conversationId: "conv1", runningAgentIds: ["verification", "implementation", "verification"] }];
  assert.equal(getConversationRunningLabel(summaries, agents, "ws1", "conv1"), "数字员工正在工作：质量验证、开发实现");
});

test("running summary falls back to unknown ids and is absent for another conversation", () => {
  assert.equal(
    getConversationRunningLabel([{ workspaceId: "ws1", conversationId: "conv1", runningAgentIds: ["custom-agent"] }], agents, "ws1", "conv1"),
    "数字员工正在工作：custom-agent",
  );
  assert.equal(
    getConversationRunningLabel([{ workspaceId: "ws1", conversationId: "conv2", runningAgentIds: ["implementation"] }], agents, "ws1", "conv1"),
    null,
  );
});

test("handoff summaries use display names", () => {
  const source: ChatMessage = { id: "msg_000001", kind: "agent", agentId: "implementation", content: "@质量验证: review this", createdAt: "2026-01-01T00:00:01.000Z" };
  const agentMessage: ChatMessage = { id: "msg_000002", kind: "agent", agentId: "implementation", content: "done", createdAt: source.createdAt, parentMessageId: source.id };
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  assert.ok(getAgentHandoffSummary(agentMessage, source, agentsById)?.includes("开发实现"));
});
