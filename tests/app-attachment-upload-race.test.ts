import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { createAttachmentUploadLifecycle } from "../src/ui/attachment-upload-state.ts";

/**
 * PR #147 审查修复 M1：附件上传竞态。
 *
 * 上传进行中发送会把附件错投给当前消息甚至串到下一条消息；上传中切换
 * 工作区/会话时，旧请求的结果必须丢弃，不得写入新会话的输入区，也不得
 * 递减新会话的上传计数。无 React 渲染环境下：状态机做行为单测，App 组
 * 件以源码结构断言关键接线点。
 */

const appSource = fs.readFileSync(
  path.resolve(import.meta.dirname, "../src/ui/App.tsx"),
  "utf-8",
);

describe("attachment upload lifecycle state machine", () => {
  test("upload in progress blocks sending; count recovers after completion", () => {
    const lifecycle = createAttachmentUploadLifecycle();
    assert.equal(lifecycle.getUploadingCount(), 0, "idle composer must allow sending");

    const context = lifecycle.beginUpload({ workspaceId: "ws", conversationId: "conv-a" });
    assert.equal(lifecycle.getUploadingCount(), 1, "sending must be blocked while uploading");

    assert.equal(lifecycle.finishUpload(context), true, "fresh completion releases the slot");
    assert.equal(lifecycle.getUploadingCount(), 0, "sending is allowed again after the upload finishes");
  });

  test("concurrent upload batches are counted together", () => {
    const lifecycle = createAttachmentUploadLifecycle();
    const first = lifecycle.beginUpload({ workspaceId: "ws", conversationId: "conv-a" });
    const second = lifecycle.beginUpload({ workspaceId: "ws", conversationId: "conv-a" });
    assert.equal(lifecycle.getUploadingCount(), 2);

    assert.equal(lifecycle.finishUpload(first), true);
    assert.equal(lifecycle.getUploadingCount(), 1, "one outstanding upload still blocks sending");
    assert.equal(lifecycle.finishUpload(second), true);
    assert.equal(lifecycle.getUploadingCount(), 0);
  });

  test("switching conversations mid-upload discards the stale result without touching the new context", () => {
    const lifecycle = createAttachmentUploadLifecycle();
    const stale = lifecycle.beginUpload({ workspaceId: "ws", conversationId: "conv-a" });

    // 用户从会话 A 切到会话 B：上下文重置，B 的计数从 0 开始。
    lifecycle.resetContext();
    assert.equal(lifecycle.getUploadingCount(), 0, "new conversation starts with no uploads");
    assert.equal(lifecycle.isStale(stale), true, "conv-a upload is stale after the switch");

    // A 的上传完成回调：不得递减 B 的计数，也不得被接受。
    assert.equal(lifecycle.finishUpload(stale), false, "stale completion must not decrement the new count");
    assert.equal(lifecycle.getUploadingCount(), 0, "conv-b count stays untouched");

    // 会话 B 自己开始并完成一次上传：行为不受 A 的残留影响。
    const fresh = lifecycle.beginUpload({ workspaceId: "ws", conversationId: "conv-b" });
    assert.equal(lifecycle.getUploadingCount(), 1);
    assert.equal(lifecycle.finishUpload(fresh), true);
    assert.equal(lifecycle.getUploadingCount(), 0);
  });

  test("switching back to the original conversation still rejects the old result", () => {
    const lifecycle = createAttachmentUploadLifecycle();
    const stale = lifecycle.beginUpload({ workspaceId: "ws", conversationId: "conv-a" });
    lifecycle.resetContext(); // -> conv-b
    lifecycle.resetContext(); // -> back to a context with a different version

    // 版本是单调递增的全局计数：即使会话 ID 回到 conv-a，旧版本号仍过期。
    assert.equal(lifecycle.isStale(stale), true);
    assert.equal(lifecycle.finishUpload(stale), false);
    assert.equal(lifecycle.getUploadingCount(), 0);
  });
});

describe("App composer wiring for upload races", () => {
  test("sendMessage rejects synchronously while attachments are uploading", () => {
    const sendMatch = appSource.match(/async function sendMessage\([\s\S]*?\n  \}/);
    assert.ok(sendMatch, "sendMessage must exist in App.tsx");
    const body = sendMatch[0];
    const guardIndex = body.indexOf("getUploadingCount() > 0");
    const sendIndex = body.indexOf("api/messages");
    assert.ok(guardIndex > 0, "sendMessage must check the synchronous upload count");
    assert.ok(
      sendIndex < 0 || guardIndex < sendIndex,
      "the upload guard must run before the message request is issued",
    );
  });

  test("Enter send path keeps the IME guard first and delegates the rest to sendMessage", () => {
    const guardIndex = appSource.indexOf("if (isImeComposition(event)) {");
    const enterIndex = appSource.indexOf('if (event.key === "Enter" && !event.shiftKey) {');
    assert.ok(guardIndex > 0, "composer onKeyDown must keep the IME composition guard");
    assert.ok(enterIndex > guardIndex, "IME guard must still precede the Enter-send branch");
  });

  test("send button is disabled while uploads are pending", () => {
    assert.match(
      appSource,
      /disabled=\{[^}]*uploadingAttachments > 0[^}]*\}/,
      "send button disabled condition must include uploadingAttachments",
    );
  });

  test("workspace/conversation switch resets the upload lifecycle in a layout effect", () => {
    const effectMatch = appSource.match(
      /useLayoutEffect\(\(\) => \{\s*attachmentUploadLifecycleRef\.current\.resetContext\(\);[\s\S]*?\}, \[state\.workspace\.id, state\.conversation\.id\]\);/,
    );
    assert.ok(effectMatch, "switching context must resetContext() synchronously before paint");
  });

  test("upload requests carry the captured workspace and conversation ids", () => {
    const uploadMatch = appSource.match(/async function uploadAttachmentFiles\([\s\S]*?\n  \}/);
    assert.ok(uploadMatch, "uploadAttachmentFiles must exist in App.tsx");
    const body = uploadMatch[0];
    assert.ok(body.includes("workspaceId: uploadContext.workspaceId"), "request body must send the captured workspaceId");
    assert.ok(body.includes("conversationId: uploadContext.conversationId"), "request body must send the captured conversationId");
    assert.ok(
      body.indexOf("lifecycle.isStale(uploadContext)") >= 0 &&
        body.indexOf("setPendingAttachments") > body.indexOf("lifecycle.isStale(uploadContext)"),
      "stale results must be discarded before they can reach the composer state",
    );
  });
});
