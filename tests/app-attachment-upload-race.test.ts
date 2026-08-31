import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { createAttachmentUploadLifecycle } from "../src/ui/attachment-upload-state.ts";
import { ATTACHMENT_LIMITS } from "../src/shared/types.ts";

/**
 * PR #147 审查修复 M1：附件上传竞态。
 *
 * 上传进行中发送会把附件错投给当前消息甚至串到下一条消息；上传中切换
 * 工作区/会话时，旧请求的结果必须丢弃，不得写入新会话的输入区，也不得
 * 递减新会话的上传计数或附件槽位（否则可绕过前端附件上限，见回归复现
 * 序列）。无 React 渲染环境下：状态机做行为单测（真实异步时序驱动），
 * App 组件以源码结构断言关键接线点。
 */

const MAX_FILES = ATTACHMENT_LIMITS.MAX_FILES_PER_MESSAGE;

const appSource = fs.readFileSync(
  path.resolve(import.meta.dirname, "../src/ui/App.tsx"),
  "utf-8",
);

describe("attachment upload lifecycle state machine", () => {
  test("upload in progress blocks sending; count recovers after completion", () => {
    const lifecycle = createAttachmentUploadLifecycle();
    assert.equal(lifecycle.getUploadingCount(), 0, "idle composer must allow sending");

    const context = lifecycle.beginUpload({ workspaceId: "ws", conversationId: "conv-a" }, 1);
    assert.equal(lifecycle.getUploadingCount(), 1, "sending must be blocked while uploading");
    assert.equal(lifecycle.getSlotCount(), 1, "an in-flight upload occupies its slot");

    assert.equal(lifecycle.finishUpload(context), true, "fresh completion releases the upload count");
    assert.equal(lifecycle.getUploadingCount(), 0, "sending is allowed again after the upload finishes");
    assert.equal(lifecycle.getSlotCount(), 1, "a successful attachment keeps occupying its slot");
  });

  test("failed uploads release their slots; sending clears all slots", () => {
    const lifecycle = createAttachmentUploadLifecycle();
    const context = lifecycle.beginUpload({ workspaceId: "ws", conversationId: "conv-a" }, 2);

    lifecycle.releaseSlots(context, 2);
    assert.equal(lifecycle.getSlotCount(), 0, "failed uploads must give their slots back");

    const kept = lifecycle.beginUpload({ workspaceId: "ws", conversationId: "conv-a" }, 1);
    lifecycle.finishUpload(kept);
    assert.equal(lifecycle.getSlotCount(), 1);
    const removeContext = lifecycle.captureContext({ workspaceId: "ws", conversationId: "conv-a" });
    assert.equal(lifecycle.removeSlot(removeContext), true);
    assert.equal(lifecycle.getSlotCount(), 0, "removing a pending attachment releases its slot");

    const second = lifecycle.beginUpload({ workspaceId: "ws", conversationId: "conv-a" }, 1);
    lifecycle.finishUpload(second);
    const sendContext = lifecycle.captureContext({ workspaceId: "ws", conversationId: "conv-a" });
    assert.equal(lifecycle.clearSlots(sendContext), true);
    assert.equal(lifecycle.getSlotCount(), 0, "a sent message releases every slot");
  });

  test("the frontend per-message attachment cap cannot be exceeded by concurrent batches", () => {
    const lifecycle = createAttachmentUploadLifecycle();
    const allowsBatch = (size: number) => lifecycle.getSlotCount() + size <= MAX_FILES;

    assert.equal(allowsBatch(5), true);
    const first = lifecycle.beginUpload({ workspaceId: "ws", conversationId: "conv-a" }, 3);
    lifecycle.finishUpload(first);
    assert.equal(allowsBatch(3), false, "three attachments leave room for two more only");

    const second = lifecycle.beginUpload({ workspaceId: "ws", conversationId: "conv-a" }, 2);
    lifecycle.finishUpload(second);
    assert.equal(lifecycle.getSlotCount(), 5);
    assert.equal(allowsBatch(1), false, "the cap holds once five attachments occupy the composer");
  });

  test("switching conversations mid-upload discards the stale result without touching the new context", async () => {
    // 回归复现序列（修复前 A 的过期回调会递减 B 的槽位，绕过附件上限）：
    // A 开始上传 → 切到 B（计数清零）→ B 添加附件 → A 的回调陆续结算。
    const lifecycle = createAttachmentUploadLifecycle();
    const staleContextA = lifecycle.beginUpload({ workspaceId: "ws", conversationId: "conv-a" }, 1);

    // 用户从会话 A 切到会话 B：上下文重置，B 的两个计数从 0 开始。
    lifecycle.resetContext();
    assert.equal(lifecycle.getUploadingCount(), 0, "new conversation starts with no uploads");
    assert.equal(lifecycle.getSlotCount(), 0, "new conversation starts with no occupied slots");
    assert.equal(lifecycle.isStale(staleContextA), true, "conv-a upload is stale after the switch");

    // B 自己开始并完成一次上传：附件落在 B 的输入区。
    const freshContextB = lifecycle.beginUpload({ workspaceId: "ws", conversationId: "conv-b" }, 1);
    assert.equal(lifecycle.getUploadingCount(), 1);
    lifecycle.finishUpload(freshContextB);
    assert.equal(lifecycle.getUploadingCount(), 0);
    assert.equal(lifecycle.getSlotCount(), 1);

    // A 的上传完成回调（stale 成功路径）：不得递减 B 的上传计数与槽位。
    assert.equal(lifecycle.finishUpload(staleContextA), false, "stale completion must not decrement the new count");
    assert.equal(lifecycle.getUploadingCount(), 0, "conv-b uploading count stays untouched");
    lifecycle.releaseSlots(staleContextA);
    assert.equal(lifecycle.getSlotCount(), 1, "conv-b slot count stays untouched by the stale release");

    // A 的失败回调（stale 失败路径）同样被忽略。
    lifecycle.releaseSlots(staleContextA, 5);
    assert.equal(lifecycle.getSlotCount(), 1);

    // 前端附件上限因此不可被 A 的过期回调绕过：B 已占 1 槽，最多再添 4 个。
    assert.equal(lifecycle.getSlotCount() + MAX_FILES > MAX_FILES, true, "a batch of MAX_FILES must be rejected now");
    const allowed = Math.min(4, MAX_FILES - lifecycle.getSlotCount());
    const batch = lifecycle.beginUpload({ workspaceId: "ws", conversationId: "conv-b" }, allowed);
    lifecycle.finishUpload(batch);
    assert.equal(lifecycle.getSlotCount(), 5);
  });

  test("a slow stale upload settles after the switch without polluting the new conversation", async () => {
    // 真实异步时序驱动：模拟 A 的上传请求在多次事件循环之后才返回，
    // 期间用户已切换会话且 B 已完成自己的附件上传。
    const lifecycle = createAttachmentUploadLifecycle();
    const settleA = (async () => {
      const context = lifecycle.beginUpload({ workspaceId: "ws", conversationId: "conv-a" }, 2);
      // 上传请求挂起：让出多个宏任务，模拟网络延迟。
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      // 响应到达后的结算路径（stale 成功 → 删草稿不回写；stale 失败 → 释放槽位）。
      lifecycle.releaseSlots(context);
      lifecycle.releaseSlots(context);
      return lifecycle.finishUpload(context);
    })();

    // 用户在 A 的请求挂起期间切到 B，并完成一次附件上传。
    await new Promise((resolve) => setTimeout(resolve, 0));
    lifecycle.resetContext();
    const contextB = lifecycle.beginUpload({ workspaceId: "ws", conversationId: "conv-b" }, 1);
    lifecycle.finishUpload(contextB);
    assert.equal(lifecycle.getSlotCount(), 1);
    assert.equal(lifecycle.getUploadingCount(), 0);

    const accepted = await settleA;
    // A 的迟到结算被整体拒绝：B 的两个计数保持不变，附件上限依然有效。
    assert.equal(accepted, false, "the late settlement must be rejected");
    assert.equal(lifecycle.getUploadingCount(), 0);
    assert.equal(lifecycle.getSlotCount(), 1, "conv-b slots must be untouched by conv-a's late release");
    assert.equal(lifecycle.getSlotCount() + 5 > MAX_FILES, true, "a full extra batch must still be rejected");
  });

  test("a stale delete confirmation does not decrement the new conversation's slots", async () => {
    // 真实异步时序：A 会话的删除附件请求在途回调期间用户切到 B。
    const lifecycle = createAttachmentUploadLifecycle();

    // A 有一个已上传附件（占 1 槽）。
    const uploadA = lifecycle.beginUpload({ workspaceId: "ws", conversationId: "conv-a" }, 1);
    lifecycle.finishUpload(uploadA);
    const removeContextA = lifecycle.captureContext({ workspaceId: "ws", conversationId: "conv-a" });

    const settleDelete = (async () => {
      // 删除请求挂起：让出事件循环到宏任务，模拟网络延迟后回调到达。
      await new Promise((resolve) => setTimeout(resolve, 0));
      return lifecycle.removeSlot(removeContextA);
    })();

    // 请求在途（回调仍在宏任务队列中）：用户切到 B（A 的槽位随之清零），
    // B 上传两个附件。宏任务回调必然在这些同步操作之后执行。
    lifecycle.resetContext();
    const uploadB = lifecycle.beginUpload({ workspaceId: "ws", conversationId: "conv-b" }, 2);
    lifecycle.finishUpload(uploadB);
    assert.equal(lifecycle.getSlotCount(), 2);

    // A 的删除响应迟到：必须被忽略，B 的两个槽位原封不动。
    assert.equal(await settleDelete, false, "the stale delete must be ignored");
    assert.equal(lifecycle.getSlotCount(), 2, "conv-b slots must be untouched by conv-a's late delete");
    // 上限依然有效：B 已占 2 槽，只能再添 3 个。
    assert.equal(lifecycle.getSlotCount() + 4 > MAX_FILES, true);
  });

  test("a stale send confirmation does not clear the new conversation's slots", async () => {
    // 真实异步时序：A 会话的发送请求在途回调期间用户切到 B 并添加附件。
    const lifecycle = createAttachmentUploadLifecycle();

    // A 有一个待发送附件（占 1 槽），发送捕获当前上下文。
    const uploadA = lifecycle.beginUpload({ workspaceId: "ws", conversationId: "conv-a" }, 1);
    lifecycle.finishUpload(uploadA);
    const sendContextA = lifecycle.captureContext({ workspaceId: "ws", conversationId: "conv-a" });

    const settleSend = (async () => {
      // 发送请求挂起：让出事件循环到宏任务，模拟网络延迟后回调到达。
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      return lifecycle.clearSlots(sendContextA);
    })();

    // 请求在途（回调仍在宏任务队列中）：用户切到 B，B 上传三个附件并完成。
    lifecycle.resetContext();
    const uploadB = lifecycle.beginUpload({ workspaceId: "ws", conversationId: "conv-b" }, 3);
    lifecycle.finishUpload(uploadB);
    assert.equal(lifecycle.getSlotCount(), 3);

    // A 的发送响应迟到：不得清空 B 的输入区占用。
    assert.equal(await settleSend, false, "the stale send must not clear the new composer");
    assert.equal(lifecycle.getSlotCount(), 3, "conv-b slots must be untouched by conv-a's late send");
    assert.equal(lifecycle.getUploadingCount(), 0);
  });

  test("switching back to the original conversation still rejects the old result", () => {
    const lifecycle = createAttachmentUploadLifecycle();
    const stale = lifecycle.beginUpload({ workspaceId: "ws", conversationId: "conv-a" }, 1);
    lifecycle.resetContext(); // -> conv-b
    lifecycle.resetContext(); // -> back to a context with a different version

    // 版本是单调递增的全局计数：即使会话 ID 回到 conv-a，旧版本号仍过期。
    assert.equal(lifecycle.isStale(stale), true);
    assert.equal(lifecycle.finishUpload(stale), false);
    lifecycle.releaseSlots(stale);
    assert.equal(lifecycle.getUploadingCount(), 0);
    assert.equal(lifecycle.getSlotCount(), 0);
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
    assert.ok(sendIndex > 0, "sendMessage must issue the message request");
    assert.ok(
      guardIndex < sendIndex,
      "the upload guard must run before the message request is issued",
    );
  });

  test("sendMessage allows an attachment-only message after uploads settle", () => {
    const sendMatch = appSource.match(/async function sendMessage\([\s\S]*?\n  \}/);
    assert.ok(sendMatch, "sendMessage must exist in App.tsx");
    assert.match(sendMatch[0], /canSendMessage\(trimmed, pendingAttachments\.length\)/);
    assert.match(appSource, /canSendMessage\(content, pendingAttachments\.length\)/);
  });

  test("uploads reject oversized files before reading and time out stalled requests", () => {
    assert.match(appSource, /file\.size > ATTACHMENT_LIMITS\.MAX_FILE_SIZE/);
    assert.match(appSource, /const controller = new AbortController\(\)/);
    assert.match(appSource, /controller\.abort\(\)/);
    assert.match(appSource, /signal: controller\.signal/);
    assert.match(appSource, /window\.clearTimeout\(timeoutId\)/);
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
      /useLayoutEffect\(\(\) => \{[\s\S]*?attachmentUploadLifecycleRef\.current\.resetContext\(\);[\s\S]*?\}, \[state\.workspace\.id, state\.conversation\.id\]\);/,
    );
    assert.ok(effectMatch, "switching context must resetContext() synchronously before paint");
  });

  test("upload requests carry the captured workspace and conversation ids", () => {
    const uploadMatch = appSource.match(/async function uploadAttachmentFiles\([\s\S]*?\n  \}/);
    assert.ok(uploadMatch, "uploadAttachmentFiles must exist in App.tsx");
    const body = uploadMatch[0];
    // #155 页面上下文契约：目标经 query 参数随请求发送（withPageContext
    // 使用捕获的 uploadContext，而非实时页面状态）。
    assert.ok(
      body.includes('withPageContext("/api/attachments/drafts", uploadContext)'),
      "the upload request must carry the captured context as query parameters",
    );
    assert.ok(
      body.indexOf("lifecycle.isStale(uploadContext)") >= 0 &&
        body.indexOf("setPendingAttachments") > body.indexOf("lifecycle.isStale(uploadContext)"),
      "stale results must be discarded before they can reach the composer state",
    );
  });

  test("slot accounting flows through the version-bound lifecycle only", () => {
    assert.ok(!appSource.includes("attachmentSlotCountRef"), "the raw slot ref must be gone; slots live in the lifecycle");
    const uploadMatch = appSource.match(/async function uploadAttachmentFiles\([\s\S]*?\n  \}/)!;
    // 每一处释放都带上批次上下文：lifecycle.releaseSlots 对过期批次直接忽略。
    const releases = uploadMatch[0].match(/lifecycle\.releaseSlots\(uploadContext[^)]*\)/g) ?? [];
    assert.ok(releases.length >= 4, "every failure path must release slots through the upload context");
    assert.ok(uploadMatch[0].includes("lifecycle.getSlotCount()"), "the per-message cap must read the lifecycle slot count");
    assert.ok(
      appSource.includes("lifecycle.removeSlot(removeContext)"),
      "removing a pending attachment must release its slot through the captured context",
    );
    assert.ok(
      appSource.includes("lifecycle.clearSlots(sendContext)"),
      "sending must clear slots through the captured send context",
    );
  });

  test("send and delete responses guard UI settlement on the captured context", () => {
    const sendMatch = appSource.match(/async function sendMessage\([\s\S]*?\n  \}/)!;
    assert.ok(
      sendMatch[0].includes("lifecycle.captureContext("),
      "sendMessage must capture the context before awaiting the request",
    );
    assert.ok(
      sendMatch[0].indexOf("lifecycle.isStale(sendContext)") >= 0 &&
        sendMatch[0].indexOf('setContent("")') > sendMatch[0].indexOf("lifecycle.isStale(sendContext)"),
      "clearing the composer after a send must happen only for a non-stale context",
    );
    assert.ok(
      sendMatch[0].includes('withPageContext("/api/messages", requestedContext)'),
      "the message request must carry the page context as query parameters",
    );
    assert.ok(
      sendMatch[0].includes("clientMessageId: draftMessageIdRef.current.id"),
      "the send request must keep its idempotency key",
    );

    const removeMatch = appSource.match(/async function removePendingAttachment\([\s\S]*?\n  \}/)!;
    assert.ok(
      removeMatch[0].includes("lifecycle.captureContext("),
      "removePendingAttachment must capture the context before awaiting the delete",
    );
    assert.ok(
      removeMatch[0].includes("lifecycle.removeSlot(removeContext)"),
      "slot release on delete must flow through the captured context",
    );
    const guardIndex = removeMatch[0].indexOf("lifecycle.isStale(removeContext)");
    const filterIndex = removeMatch[0].indexOf("setPendingAttachments");
    assert.ok(
      guardIndex > 0 && filterIndex > guardIndex,
      "the composer-state filter must only run for a non-stale delete context",
    );
  });
});
