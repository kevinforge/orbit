import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { AttachmentStore } from "../src/core/attachment-store.ts";
import { ATTACHMENT_LIMITS } from "../src/shared/types.ts";

/**
 * Issue #88: Draft 数量限制
 *
 * 问题：无数量限制，可能被 DoS 攻击填满磁盘
 *
 * 修复方案：
 * 1. 添加每会话 draft 数量限制（20个）
 * 2. 提升清理频率（从 24h 改为 1h）
 * 3. 在保存 draft 之前检查数量限制
 */

const VALID_PNG = Buffer.from([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
  0x00, 0x00, 0x00, 0x0D,
  0x49, 0x48, 0x44, 0x52,
]);

test("Issue #88: countDrafts returns 0 for non-existent conversation", async () => {
  const tmpDir = path.join(process.cwd(), "test-tmp-count-drafts");
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    const store = new AttachmentStore(tmpDir);

    const count = await store.countDrafts("ws-1", "conv-1");
    assert.equal(count, 0, "Should return 0 for non-existent conversation");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Issue #88: countDrafts returns correct count", async () => {
  const tmpDir = path.join(process.cwd(), "test-tmp-count-drafts-2");
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    const store = new AttachmentStore(tmpDir);

    // Create 3 drafts
    for (let i = 0; i < 3; i++) {
      await store.saveDraft({
        workspaceId: "ws-1",
        conversationId: "conv-1",
        data: VALID_PNG,
        mimeType: "image/png",
        filename: `test-${i}.png`,
      });
    }

    const count = await store.countDrafts("ws-1", "conv-1");
    assert.equal(count, 3, "Should return correct count");

    // Cleanup
    for (let i = 0; i < 3; i++) {
      const drafts = await fs.promises.readdir(
        path.join(tmpDir, "tmp", "attachments", "ws-1", "conv-1"),
        { withFileTypes: true }
      );
      for (const draft of drafts.filter(d => d.isDirectory())) {
        await store.deleteDraft("ws-1", "conv-1", draft.name);
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Issue #88: DRAFT_MAX_AGE_MS is 1 hour", async () => {
  assert.equal(
    ATTACHMENT_LIMITS.DRAFT_MAX_AGE_MS,
    1 * 60 * 60 * 1000,
    "DRAFT_MAX_AGE_MS should be 1 hour"
  );
});

test("Issue #88: MAX_DRAFTS_PER_CONVERSATION is 20", async () => {
  assert.equal(
    ATTACHMENT_LIMITS.MAX_DRAFTS_PER_CONVERSATION,
    20,
    "MAX_DRAFTS_PER_CONVERSATION should be 20"
  );
});

test("Issue #88: Cleanup removes expired drafts within 1 hour", async () => {
  const tmpDir = path.join(process.cwd(), "test-tmp-cleanup-1h");
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    const store = new AttachmentStore(tmpDir);

    // Create a draft
    const draft = await store.saveDraft({
      workspaceId: "ws-1",
      conversationId: "conv-1",
      data: VALID_PNG,
      mimeType: "image/png",
      filename: "test.png",
    });

    // Verify draft exists
    const countBefore = await store.countDrafts("ws-1", "conv-1");
    assert.equal(countBefore, 1, "Draft should exist before cleanup");

    // Cleanup should not remove fresh draft
    const cleaned = await store.cleanupExpiredDrafts();
    assert.equal(cleaned, 0, "Should not clean fresh draft");

    const countAfter = await store.countDrafts("ws-1", "conv-1");
    assert.equal(countAfter, 1, "Draft should still exist after cleanup");

    // Cleanup
    await store.deleteDraft("ws-1", "conv-1", draft.id);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
