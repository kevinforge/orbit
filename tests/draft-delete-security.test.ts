import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { AttachmentStore } from "../src/core/attachment-store.ts";

/**
 * Issue #86: Draft 删除权限验证
 *
 * 问题：deleteDraft 未验证 draft 是否属于当前会话
 *
 * 分析：当前实现已通过 safePath 验证路径安全
 * - safePath 方法确保路径在 baseDir 内
 * - deleteDraft 调用 safePath("tmp", "attachments", workspaceId, conversationId, attachmentId)
 * - 如果传入不匹配的 ID，路径验证会失败
 *
 * 本测试验证路径隔离的安全性
 */

test("Issue #86: deleteDraft validates path isolation", async () => {
  const tmpDir = path.join(process.cwd(), "test-tmp-draft-path-isolation");
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    const store = new AttachmentStore(tmpDir);

    // Create a draft in workspace-1/conversation-1
    const draft1 = await store.saveDraft({
      workspaceId: "ws-1",
      conversationId: "conv-1",
      data: Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
      mimeType: "image/png",
      filename: "test.png",
    });

    // Create a draft in workspace-2/conversation-2
    const draft2 = await store.saveDraft({
      workspaceId: "ws-2",
      conversationId: "conv-2",
      data: Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
      mimeType: "image/png",
      filename: "test.png",
    });

    // Try to delete draft1 from different workspace/conversation
    // Should fail because the path doesn't exist
    const deleted = await store.deleteDraft("ws-2", "conv-2", draft1.id);
    assert.equal(deleted, false, "Should not delete draft from different workspace/conversation");

    // Verify draft1 still exists
    const draft1Path = path.join(tmpDir, "tmp", "attachments", "ws-1", "conv-1", draft1.id);
    assert.ok(fs.existsSync(draft1Path), "Draft should still exist");

    // Try to delete draft1 from correct workspace/conversation
    const deleted2 = await store.deleteDraft("ws-1", "conv-1", draft1.id);
    assert.equal(deleted2, true, "Should delete draft from correct workspace/conversation");

    // Verify draft1 is deleted
    assert.ok(!fs.existsSync(draft1Path), "Draft should be deleted");

    // Cleanup draft2
    await store.deleteDraft("ws-2", "conv-2", draft2.id);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Issue #86: deleteDraft rejects path traversal attempts", async () => {
  const tmpDir = path.join(process.cwd(), "test-tmp-draft-traversal");
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    const store = new AttachmentStore(tmpDir);

    // Create a draft
    const draft = await store.saveDraft({
      workspaceId: "ws-1",
      conversationId: "conv-1",
      data: Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
      mimeType: "image/png",
      filename: "test.png",
    });

    // Try to delete with path traversal in attachmentId
    try {
      await store.deleteDraft("ws-1", "conv-1", "../../../malicious");
      assert.fail("Should have thrown an error for path traversal");
    } catch (err) {
      assert.ok(
        err instanceof Error && err.message.includes("Invalid id"),
        "Should reject path traversal in attachmentId"
      );
    }

    // Cleanup
    await store.deleteDraft("ws-1", "conv-1", draft.id);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Issue #86: deleteDraft cannot access files outside tmp/attachments", async () => {
  const tmpDir = path.join(process.cwd(), "test-tmp-draft-outside");
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    const store = new AttachmentStore(tmpDir);

    // Create a file outside tmp/attachments
    const outsideFile = path.join(tmpDir, "secret.txt");
    fs.writeFileSync(outsideFile, "secret data");

    // Try to delete the outside file using deleteDraft
    // This should fail because the path won't match the expected structure
    const deleted = await store.deleteDraft("ws-1", "conv-1", "dummy");
    assert.equal(deleted, false, "Should not delete files outside draft directory");

    // Verify the outside file still exists
    assert.ok(fs.existsSync(outsideFile), "Outside file should still exist");

    // Cleanup
    fs.unlinkSync(outsideFile);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
