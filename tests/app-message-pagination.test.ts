import test from "node:test";
import assert from "node:assert/strict";

import { mergeOlderMessagesPage } from "../src/ui/App.tsx";
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
