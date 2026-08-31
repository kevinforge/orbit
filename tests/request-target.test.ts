import assert from "node:assert/strict";
import test from "node:test";

import { resolveTargetIds } from "../src/server/request-target.ts";

/**
 * PR #147 审查修复：此前"没有会话"与"会话不存在"都返回同一个 409
 * "No active conversation."，与 `/api/messages` 对未知会话返回 404 的语义
 * 不一致，排查时也分不清是页面没选会话还是会话已被删除。
 */

const state = { activeWorkspaceId: "ws-1", activeConversationId: "conv-1" };
// ws-2 存在但不是 active 工作区：active 会话指针只对 ws-1 生效。
const exists = {
  workspace: (id: string) => id === "ws-1" || id === "ws-2",
  conversation: (ws: string, conv: string) => ws === "ws-1" && conv === "conv-1",
};

function resolve(query: string, requireConversation = true) {
  return resolveTargetIds(new URL(`http://localhost/api/x${query}`), state, exists, requireConversation);
}

test("an explicit unknown conversation is reported as unknown, not as missing", () => {
  assert.deepEqual(resolve("?workspaceId=ws-1&conversationId=conv-gone"), {
    target: null,
    reason: "unknown_conversation",
  });
});

test("no conversation in scope is reported as missing", () => {
  assert.deepEqual(resolve("?workspaceId=ws-1&conversationId="), {
    target: null,
    reason: "missing_conversation",
  });
  // 别的工作区没有会话：active 指针只对 active 工作区生效。
  assert.deepEqual(resolve("?workspaceId=ws-2"), {
    target: null,
    reason: "missing_conversation",
  });
});

test("a missing workspace is reported separately from a missing conversation", () => {
  assert.deepEqual(resolve("?workspaceId=ws-missing"), { target: null, reason: "missing_workspace" });
  assert.deepEqual(resolve("?workspaceId="), { target: null, reason: "missing_workspace" });
});

test("a resolvable target wins over the active-pointer fallback", () => {
  assert.deepEqual(resolve("?workspaceId=ws-1&conversationId=conv-1"), {
    target: { workspaceId: "ws-1", conversationId: "conv-1" },
    reason: null,
  });
  // 旧客户端不带 query：回落到同一工作区的 active 会话。
  assert.deepEqual(resolve(""), {
    target: { workspaceId: "ws-1", conversationId: "conv-1" },
    reason: null,
  });
});

test("callers that do not require a conversation skip the existence check", () => {
  assert.deepEqual(resolve("?workspaceId=ws-1&conversationId=conv-gone", false), {
    target: { workspaceId: "ws-1", conversationId: "conv-gone" },
    reason: null,
  });
});
