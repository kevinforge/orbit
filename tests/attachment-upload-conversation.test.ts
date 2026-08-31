import assert from "node:assert/strict";
import test from "node:test";

import { createConversationForUpload } from "../src/ui/attachment-upload-conversation.ts";

/**
 * PR #147 审查修复：切换工作区后没有 active 会话，而服务端要求上传目标
 * 会话已存在（草稿存在该会话目录下），直接上传会拿到 409——"新工作区第一
 * 条消息就是附件"这个场景完全用不了。补建会话放在客户端，避免只上传不
 * 发送时在 `~/.orbit` 留下空会话记录。
 */

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

test("creating a conversation for upload posts to the target workspace and returns its id", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const id = await createConversationForUpload("ws 1", async (url, init) => {
    calls.push({ url, init });
    return jsonResponse(200, { id: "conv_new", name: "新会话" });
  });

  assert.equal(id, "conv_new");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/conversations?workspaceId=ws%201");
  assert.equal(calls[0].init.method, "POST");
});

test("an existing conversation id is never re-created", async () => {
  // 调用方只在本函数之外判断是否需要补建；这里验证它不会静默吞掉空 id。
  await assert.rejects(
    () => createConversationForUpload("ws-1", async () => jsonResponse(200, {})),
    /创建会话失败/,
  );
});

test("uploads without a workspace fail with an actionable message instead of a 409", async () => {
  let called = false;
  await assert.rejects(
    () => createConversationForUpload("", async () => {
      called = true;
      return jsonResponse(200, { id: "conv_new" });
    }),
    /请先选择或创建工作区/,
  );
  assert.equal(called, false, "no request may be issued without a workspace");
});

test("a failed creation surfaces the server message", async () => {
  await assert.rejects(
    () => createConversationForUpload("ws-1", async () => jsonResponse(409, { message: "Workspace not found." })),
    /Workspace not found\./,
  );
});

test("a malformed creation response fails without throwing a parse error", async () => {
  await assert.rejects(
    () => createConversationForUpload("ws-1", async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new Error("invalid json"); },
    }) as unknown as Response),
    /创建会话失败/,
  );
});
