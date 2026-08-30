import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { resolveMessageTarget, shouldPromoteNewConversation } from "../src/server/message-target.ts";

/**
 * PR #147 M1 服务端收尾：消息发送目标的解析规则。
 *
 * 入口快照在读取请求体之前取得，字段缺失（undefined）才允许回退快照；
 * 显式空串/非字符串一律 400 拒绝，绝不静默改投其他会话。显式会话存在但
 * context 被 LRU 回收时，handlePostMessage 走 getOrCreateContext 恢复而
 * 不是新建会话（源码断言）。
 */

const exists = {
  workspace(workspaceId: string) {
    return workspaceId === "ws-1";
  },
  conversation(workspaceId: string, conversationId: string) {
    return workspaceId === "ws-1" && conversationId === "conv-1";
  },
};

describe("resolveMessageTarget", () => {
  test("explicit empty ids are rejected outright, never silently rerouted", () => {
    for (const input of [
      { workspaceId: "" },
      { conversationId: "" },
      { workspaceId: "", conversationId: "conv-1" },
      { workspaceId: "ws-1", conversationId: "" },
      { workspaceId: 42 },
      { conversationId: null },
    ]) {
      const result = resolveMessageTarget(input, { workspaceId: "ws-1", conversationId: "conv-1" }, exists);
      assert.equal(result.ok, false, `input ${JSON.stringify(input)} must be rejected`);
      assert.equal((result as { status: number }).status, 400);
      // 拒绝意味着不产生任何目标：消息不会被改投到 active 或其他会话。
    }
  });

  test("missing fields fall back to the request-entry snapshot", () => {
    const result = resolveMessageTarget({}, { workspaceId: "ws-1", conversationId: "conv-1" }, exists);
    assert.deepEqual(result, { ok: true, workspaceId: "ws-1", conversationId: "conv-1" });
  });

  test("explicit existing ids win and are verified", () => {
    const result = resolveMessageTarget(
      { workspaceId: "ws-1", conversationId: "conv-1" },
      { workspaceId: "ws-other", conversationId: "conv-other" },
      exists,
    );
    assert.deepEqual(result, { ok: true, workspaceId: "ws-1", conversationId: "conv-1" });
  });

  test("explicit unknown workspace or conversation is 404", () => {
    const ws = resolveMessageTarget(
      { workspaceId: "ws-missing", conversationId: "conv-1" },
      { workspaceId: "ws-1", conversationId: "conv-1" },
      exists,
    );
    assert.equal((ws as { status: number }).status, 404);

    const conv = resolveMessageTarget(
      { workspaceId: "ws-1", conversationId: "conv-missing" },
      { workspaceId: "ws-1", conversationId: "conv-1" },
      exists,
    );
    assert.equal((conv as { status: number }).status, 404);
  });

  test("no workspace anywhere yields 409", () => {
    const result = resolveMessageTarget({}, { workspaceId: "", conversationId: "" }, exists);
    assert.equal((result as { status: number }).status, 409);
  });

  test("explicit workspace without a conversation id falls back to the entry conversation", () => {
    // 旧调用兼容语义：只带 workspaceId 时，会话回退入口快照。
    const result = resolveMessageTarget(
      { workspaceId: "ws-1" },
      { workspaceId: "ws-1", conversationId: "conv-1" },
      exists,
    );
    assert.deepEqual(result, { ok: true, workspaceId: "ws-1", conversationId: "conv-1" });
  });

  test("no conversation at all resolves to null for the first-message scenario", () => {
    const result = resolveMessageTarget(
      { workspaceId: "ws-1" },
      { workspaceId: "ws-1", conversationId: "" },
      exists,
    );
    assert.deepEqual(result, { ok: true, workspaceId: "ws-1", conversationId: null });
  });
});

describe("shouldPromoteNewConversation (active write-back compare-and-set)", () => {
  test("promotes the new conversation when the live pointers still match the entry snapshot", () => {
    // 正向用例：请求处理期间用户未做任何切换（首条消息场景，入口无会话）。
    assert.equal(
      shouldPromoteNewConversation(
        { workspaceId: "ws-a", conversationId: "" },
        { workspaceId: "ws-a", conversationId: "" },
      ),
      true,
    );
    // 入口已有会话的场景（创建会话端点）：无切换同样写回。
    assert.equal(
      shouldPromoteNewConversation(
        { workspaceId: "ws-a", conversationId: "conv-old" },
        { workspaceId: "ws-a", conversationId: "conv-old" },
      ),
      true,
    );
  });

  test("a conversation switch during the request blocks the write-back", () => {
    // 复现序列：入口 ws-a 无会话 → readJson 等待期间切到 B → 不写回，
    // B 保持 active，用户不被拽回新会话。
    assert.equal(
      shouldPromoteNewConversation(
        { workspaceId: "ws-a", conversationId: "" },
        { workspaceId: "ws-a", conversationId: "conv-b" },
      ),
      false,
    );
  });

  test("a workspace switch during the request blocks the write-back", () => {
    assert.equal(
      shouldPromoteNewConversation(
        { workspaceId: "ws-a", conversationId: "" },
        { workspaceId: "ws-c", conversationId: "" },
      ),
      false,
    );
    assert.equal(
      shouldPromoteNewConversation(
        { workspaceId: "ws-a", conversationId: "conv-old" },
        { workspaceId: "ws-c", conversationId: "conv-x" },
      ),
      false,
    );
  });

  test("switching away and back still differs from a plain unchanged pointer only via ids", () => {
    // 快照与实时逐字段相等才写回；会话 id 相同但工作区不同同样拒绝。
    assert.equal(
      shouldPromoteNewConversation(
        { workspaceId: "ws-a", conversationId: "conv-1" },
        { workspaceId: "ws-c", conversationId: "conv-1" },
      ),
      false,
    );
  });
});

describe("handlePostMessage context recovery wiring", () => {
  const serverSource = fs.readFileSync(
    path.resolve(import.meta.dirname, "../src/server/index.ts"),
    "utf-8",
  );

  test("an existing target conversation recovers its context instead of creating a new conversation", () => {
    const handler = serverSource.match(/async function handlePostMessage\([\s\S]*?\nasync function |async function handlePostMessage\([\s\S]*?\n\}/)?.[0] ?? "";
    assert.ok(handler, "handlePostMessage must exist in server/index.ts");
    const recoveryIndex = handler.indexOf("context = getOrCreateContext(target.workspaceId, conversation.id);");
    assert.ok(recoveryIndex > 0, "an existing conversation must restore its context via getOrCreateContext");
    const createIndex = handler.indexOf("conversationStore.create(");
    assert.ok(createIndex > recoveryIndex, "conversationStore.create may only run when no target conversation exists");
    // 恢复与新建之间必须有分支隔离：存在会话绝不新建。
    assert.ok(
      handler.slice(recoveryIndex, createIndex).includes("} else {"),
      "recovery and creation must be mutually exclusive branches",
    );
  });

  test("the entry snapshot is taken before the request body is read", () => {
    const handler = serverSource.match(/async function handlePostMessage\([\s\S]*?\n\}/)?.[0] ?? "";
    const snapshotIndex = handler.indexOf("const entryActiveWorkspaceId = activeWorkspaceId;");
    const readBodyIndex = handler.indexOf("await readJson(req)");
    assert.ok(snapshotIndex > 0, "handlePostMessage must snapshot the active pointers at entry");
    assert.ok(
      readBodyIndex > snapshotIndex,
      "the entry snapshot must be taken before awaiting the request body",
    );
  });

  test("new-conversation write-back is guarded by compare-and-set with no await in between", () => {
    const handler = serverSource.match(/async function handlePostMessage\([\s\S]*?\n\}/)?.[0] ?? "";
    const promoteIndex = handler.indexOf("shouldPromoteNewConversation(");
    const writeBackIndex = handler.indexOf("activeConversationId = conversation.id;");
    assert.ok(promoteIndex > 0, "handlePostMessage must guard the write-back with shouldPromoteNewConversation");
    assert.ok(writeBackIndex > promoteIndex, "the write-back must follow the guard");
    // 判定与写回之间不允许再穿插 await（否则判定结果可能已过期）。
    assert.ok(
      !handler.slice(promoteIndex, writeBackIndex).includes("await "),
      "no await may sit between the compare-and-set check and the write-back",
    );
  });

  test("conversation creation guards its active write-back the same way", () => {
    const createRoute = serverSource.match(/req\.method === "POST" && url\.pathname === "\/api\/conversations"[\s\S]*?\n    \}/)?.[0] ?? "";
    assert.ok(createRoute, "the conversation creation route must exist");
    assert.ok(
      createRoute.includes("shouldPromoteNewConversation("),
      "creating a conversation must guard switch/activate with compare-and-set",
    );
    // 快照先于 readJson，创建与写回之间无其他 await。
    const snapshotIndex = createRoute.indexOf("const entryActiveWorkspaceId = activeWorkspaceId;");
    const readBodyIndex = createRoute.indexOf("await readJson(req)");
    const promoteIndex = createRoute.indexOf("shouldPromoteNewConversation(");
    assert.ok(snapshotIndex > 0 && readBodyIndex > snapshotIndex, "the entry snapshot must precede readJson");
    assert.ok(promoteIndex > readBodyIndex, "the guard runs after the body is read");
  });
});
