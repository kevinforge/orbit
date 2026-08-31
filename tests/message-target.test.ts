import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";


/**
 * PR #147 M1 服务端收尾（已合并 #155 页面上下文）。
 *
 * 消息发送目标自 #155 起统一从请求 query 参数解析（页面上下文契约），
 * 显式 conversationId 不存在即 404，不静默改投。新建会话写回 active 指
 * 针采用 compare-and-set：仅当实时指针仍等于请求入口快照（读取请求体期
 * 间用户未切换）才写回。
 */

describe("server wiring for message targets and write-backs", () => {
  const serverSource = fs.readFileSync(
    path.resolve(import.meta.dirname, "../src/server/index.ts"),
    "utf-8",
  );

  test("handlePostMessage resolves the target from query params with an entry snapshot fallback", () => {
    const handler = serverSource.match(/async function handlePostMessage\([\s\S]*?\n\}/)?.[0] ?? "";
    assert.ok(handler, "handlePostMessage must exist in server/index.ts");
    // 目标来自 query（页面上下文契约）；入口快照仅作为旧调用回退。
    assert.ok(handler.includes('url.searchParams.get("workspaceId")'), "workspace must come from the query string");
    assert.ok(handler.includes('url.searchParams.get("conversationId")'), "conversation must come from the query string");
    const snapshotIndex = handler.indexOf("const entryActiveWorkspaceId = activeWorkspaceId;");
    const readBodyIndex = handler.indexOf("await readJson(req)");
    assert.ok(snapshotIndex > 0, "handlePostMessage must snapshot the active pointers at entry");
    assert.ok(readBodyIndex > snapshotIndex, "the entry snapshot must be taken before awaiting the request body");
    assert.ok(
      handler.includes("workspaceParam === null ? entryActiveWorkspaceId"),
      "the legacy fallback must use the entry snapshot, not the live pointer",
    );
    // 显式 conversationId 不存在 → 404，不静默改投。
    assert.ok(handler.includes("Conversation not found."), "an explicit unknown conversation must 404");
  });

  test("an existing target conversation recovers its context instead of creating a new conversation", () => {
    const handler = serverSource.match(/async function handlePostMessage\([\s\S]*?\n\}/)?.[0] ?? "";
    assert.ok(handler, "handlePostMessage must exist in server/index.ts");
    const recoveryIndex = handler.indexOf("getOrCreateContext(workspaceId, conversation.id)");
    assert.ok(recoveryIndex > 0, "an existing conversation must restore its context via getOrCreateContext");
    const createIndex = handler.indexOf("conversationStoreFor(workspaceId).create(");
    assert.ok(createIndex > recoveryIndex, "conversationStoreFor().create may only run when no target conversation exists");
    assert.ok(
      handler.slice(recoveryIndex, createIndex).includes("} else if") || handler.slice(recoveryIndex, createIndex).includes("if (!context)"),
      "recovery and creation must be mutually exclusive branches",
    );
  });

  test("handlePostMessage accepts an attachment-only message", () => {
    const handler = serverSource.match(/async function handlePostMessage\([\s\S]*?\n\}/)?.[0] ?? "";
    assert.ok(handler.includes("canSendMessage(content, draftAttachments.length)"));
    assert.ok(handler.indexOf("const draftAttachments =") < handler.indexOf("canSendMessage("));
  });

  test("new-conversation write-back is guarded by compare-and-set with no await in between", () => {
    const handler = serverSource.match(/async function handlePostMessage\([\s\S]*?\n\}/)?.[0] ?? "";
    const promoteIndex = handler.indexOf("const legacyRequest =");
    const writeBackIndex = handler.indexOf("activeConversationId = conversation.id;");
    assert.ok(promoteIndex > 0, "handlePostMessage must guard legacy active write-back with a compare-and-set");
    assert.ok(writeBackIndex > promoteIndex, "the write-back must follow the guard");
    // 判定与写回之间不允许再穿插 await（否则判定结果可能已过期）。
    assert.ok(
      !handler.slice(promoteIndex, writeBackIndex).includes("await "),
      "no await may sit between the compare-and-set check and the write-back",
    );
  });

  test("creating a conversation no longer touches the active pointers at all", () => {
    // #155 将创建与激活解耦：无写回即无竞态（compare-and-set 由消息链路承担）。
    const createRoute = serverSource.match(/req\.method === "POST" && url\.pathname === "\/api\/conversations"[\s\S]*?\n    \}/)?.[0] ?? "";
    assert.ok(createRoute, "the conversation creation route must exist");
    assert.ok(
      !createRoute.includes("activeConversationId ="),
      "conversation creation must not write the active conversation pointer",
    );
    assert.ok(
      !createRoute.includes("switchWorkspace("),
      "conversation creation must not switch workspaces",
    );
  });

  test("draft uploads resolve their target from the query page context", () => {
    const draftRoute = serverSource.match(/req\.method === "POST" && url\.pathname === "\/api\/attachments\/drafts"[\s\S]*?\n    \}/)?.[0] ?? "";
    assert.ok(draftRoute, "the draft upload route must exist");
    assert.ok(
      draftRoute.includes("resolveTargetDetailed(url)"),
      "draft uploads must resolve the target from the query page context",
    );
  });
});
