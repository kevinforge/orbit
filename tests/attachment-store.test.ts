import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ATTACHMENT_LIMITS } from "../src/shared/types.ts";
import { AttachmentStore } from "../src/core/attachment-store.ts";

function makeTmpDir(): string {
  const dir = path.join(import.meta.dirname, "..", ".test-tmp", `attach-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makePngBuffer(size = 100): Buffer {
  // Minimal valid PNG header + fill bytes
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([header, Buffer.alloc(size - header.length, 0xaa)]);
}

function makeJpegBuffer(size = 100): Buffer {
  const header = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  return Buffer.concat([header, Buffer.alloc(size - header.length, 0xbb)]);
}

// --- validateImageFile ---

test("validateImageFile accepts valid PNG", () => {
  const result = AttachmentStore.validateImageFile(makePngBuffer(), "image/png", "test.png");
  assert.equal(result.valid, true);
});

test("validateImageFile accepts valid JPEG", () => {
  const result = AttachmentStore.validateImageFile(makeJpegBuffer(), "image/jpeg", "test.jpg");
  assert.equal(result.valid, true);
});

test("validateImageFile accepts valid WebP", () => {
  const result = AttachmentStore.validateImageFile(Buffer.alloc(50), "image/webp", "test.webp");
  assert.equal(result.valid, true);
});

test("validateImageFile rejects unsupported MIME type", () => {
  const result = AttachmentStore.validateImageFile(Buffer.alloc(50), "image/gif", "test.gif");
  assert.equal(result.valid, false);
  assert.ok(result.error?.includes("Unsupported"));
});

test("validateImageFile rejects file exceeding max size", () => {
  const bigBuffer = Buffer.alloc(ATTACHMENT_LIMITS.MAX_FILE_SIZE + 1);
  const result = AttachmentStore.validateImageFile(bigBuffer, "image/png", "big.png");
  assert.equal(result.valid, false);
  assert.ok(result.error?.includes("exceeds"));
});

test("validateImageFile rejects empty file", () => {
  const result = AttachmentStore.validateImageFile(Buffer.alloc(0), "image/png", "empty.png");
  assert.equal(result.valid, false);
  assert.ok(result.error?.includes("empty"));
});

// --- saveDraft / deleteDraft ---

test("saveDraft saves file and returns metadata", async () => {
  const baseDir = makeTmpDir();
  const store = new AttachmentStore(baseDir);
  const data = makePngBuffer(200);

  const result = await store.saveDraft({
    workspaceId: "ws1",
    conversationId: "conv1",
    data,
    mimeType: "image/png",
    filename: "screenshot.png",
  });

  assert.ok(result.id, "should return an id");
  assert.ok(result.path, "should return a path");
  assert.equal(result.size, data.length);
  assert.ok(fs.existsSync(result.path));
  assert.deepEqual(fs.readFileSync(result.path), data);
});

test("deleteDraft removes draft file", async () => {
  const baseDir = makeTmpDir();
  const store = new AttachmentStore(baseDir);
  const data = makePngBuffer(100);

  const saved = await store.saveDraft({
    workspaceId: "ws1",
    conversationId: "conv1",
    data,
    mimeType: "image/png",
    filename: "img.png",
  });

  assert.ok(fs.existsSync(saved.path));
  const deleted = await store.deleteDraft("ws1", "conv1", saved.id);
  assert.equal(deleted, true);
  assert.ok(!fs.existsSync(saved.path));
});

test("deleteDraft returns false for non-existent draft", async () => {
  const baseDir = makeTmpDir();
  const store = new AttachmentStore(baseDir);

  const deleted = await store.deleteDraft("ws1", "conv1", "nonexistent");
  assert.equal(deleted, false);
});

// --- commitDrafts (rebuilt path from ws+conv+id, not client path) ---

test("commitDrafts moves files to permanent directory without client path", async () => {
  const baseDir = makeTmpDir();
  const store = new AttachmentStore(baseDir);
  const data = makePngBuffer(300);

  const draft = await store.saveDraft({
    workspaceId: "ws1",
    conversationId: "conv1",
    data,
    mimeType: "image/png",
    filename: "draft.png",
  });

  const draftPath = draft.path;
  assert.ok(fs.existsSync(draftPath));

  // Note: no `path` field passed — store rebuilds from ws+conv+id
  const attachments = await store.commitDrafts({
    workspaceId: "ws1",
    conversationId: "conv1",
    draftAttachments: [{
      id: draft.id,
      mimeType: "image/png",
      filename: "draft.png",
      size: draft.size,
    }],
  });

  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].id, draft.id);
  assert.equal(attachments[0].kind, "image");
  assert.equal(attachments[0].mimeType, "image/png");
  assert.equal(attachments[0].filename, "draft.png");
  assert.equal(attachments[0].size, data.length);

  // Draft file should no longer exist
  assert.ok(!fs.existsSync(draftPath));

  // Permanent file should exist
  assert.ok(fs.existsSync(attachments[0].path));
  assert.deepEqual(fs.readFileSync(attachments[0].path), data);
});

test("commitDrafts returns empty array for empty input", async () => {
  const baseDir = makeTmpDir();
  const store = new AttachmentStore(baseDir);

  const result = await store.commitDrafts({
    workspaceId: "ws1",
    conversationId: "conv1",
    draftAttachments: [],
  });

  assert.deepEqual(result, []);
});

// --- getAttachment (exact extension match) ---

test("getAttachment returns attachment data for committed file", async () => {
  const baseDir = makeTmpDir();
  const store = new AttachmentStore(baseDir);
  const data = makeJpegBuffer(400);

  const draft = await store.saveDraft({
    workspaceId: "ws1",
    conversationId: "conv1",
    data,
    mimeType: "image/jpeg",
    filename: "photo.jpg",
  });

  const [attachment] = await store.commitDrafts({
    workspaceId: "ws1",
    conversationId: "conv1",
    draftAttachments: [{
      id: draft.id,
      mimeType: "image/jpeg",
      filename: "photo.jpg",
      size: draft.size,
    }],
  });

  const loaded = await store.getAttachment("ws1", "conv1", attachment.id);
  assert.ok(loaded);
  assert.deepEqual(loaded.data, data);
  assert.equal(loaded.mimeType, "image/jpeg");
});

test("getAttachment returns null for non-existent file", async () => {
  const baseDir = makeTmpDir();
  const store = new AttachmentStore(baseDir);

  const result = await store.getAttachment("ws1", "conv1", "nonexistent");
  assert.equal(result, null);
});

test("getAttachment does not match by prefix (exact extension only)", async () => {
  const baseDir = makeTmpDir();
  const store = new AttachmentStore(baseDir);
  const data = makePngBuffer(100);

  const draft = await store.saveDraft({
    workspaceId: "ws1",
    conversationId: "conv1",
    data,
    mimeType: "image/png",
    filename: "test.png",
  });

  await store.commitDrafts({
    workspaceId: "ws1",
    conversationId: "conv1",
    draftAttachments: [{
      id: draft.id,
      mimeType: "image/png",
      filename: "test.png",
      size: draft.size,
    }],
  });

  // Using a prefix of the id should NOT match
  const result = await store.getAttachment("ws1", "conv1", draft.id.slice(0, 8));
  assert.equal(result, null);
});

// --- deleteConversationAttachments ---

test("deleteConversationAttachments removes all attachments for a conversation", async () => {
  const baseDir = makeTmpDir();
  const store = new AttachmentStore(baseDir);

  const data1 = makePngBuffer(100);
  const data2 = makeJpegBuffer(200);

  const draft1 = await store.saveDraft({
    workspaceId: "ws1", conversationId: "conv1", data: data1,
    mimeType: "image/png", filename: "img1.png",
  });
  const draft2 = await store.saveDraft({
    workspaceId: "ws1", conversationId: "conv1", data: data2,
    mimeType: "image/jpeg", filename: "img2.jpg",
  });

  const attachments = await store.commitDrafts({
    workspaceId: "ws1",
    conversationId: "conv1",
    draftAttachments: [
      { id: draft1.id, mimeType: "image/png", filename: "img1.png", size: draft1.size },
      { id: draft2.id, mimeType: "image/jpeg", filename: "img2.jpg", size: draft2.size },
    ],
  });

  assert.equal(attachments.length, 2);

  await store.deleteConversationAttachments("ws1", "conv1");

  // Both files should be gone
  assert.ok(!fs.existsSync(attachments[0].path));
  assert.ok(!fs.existsSync(attachments[1].path));
});

// --- cleanupExpiredDrafts ---

test("cleanupExpiredDrafts removes old drafts but keeps fresh ones", async () => {
  const baseDir = makeTmpDir();
  const store = new AttachmentStore(baseDir);

  // Create a draft
  const data = makePngBuffer(100);
  const draft = await store.saveDraft({
    workspaceId: "ws1",
    conversationId: "conv1",
    data,
    mimeType: "image/png",
    filename: "fresh.png",
  });

  // Manually create an "old" draft by setting its mtime to past
  const oldDir = path.join(baseDir, "tmp", "attachments", "ws1", "conv2", "old-id");
  fs.mkdirSync(oldDir, { recursive: true });
  const oldFile = path.join(oldDir, "old-file.png");
  fs.writeFileSync(oldFile, Buffer.alloc(50));
  // Set mtime to 2 days ago
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  fs.utimesSync(oldFile, twoDaysAgo, twoDaysAgo);

  const cleaned = await store.cleanupExpiredDrafts();
  assert.ok(cleaned >= 1, "should clean at least one expired draft");
  assert.ok(!fs.existsSync(oldFile), "old draft should be deleted");
  assert.ok(fs.existsSync(draft.path), "fresh draft should survive");
});

// --- Path traversal protection ---

// Use a shallow base dir so that traversal actually escapes
function makeShallowTmpDir(): string {
  const dir = path.join(os.tmpdir(), `orbit-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test("saveDraft rejects path traversal in workspaceId", async () => {
  const baseDir = makeShallowTmpDir();
  const store = new AttachmentStore(baseDir);

  await assert.rejects(
    () => store.saveDraft({
      workspaceId: "../../../../etc",
      conversationId: "conv1",
      data: makePngBuffer(),
      mimeType: "image/png",
      filename: "evil.png",
    }),
    /directory traversal/,
  );
  fs.rmSync(baseDir, { recursive: true, force: true });
});

test("deleteDraft rejects path traversal in attachmentId", async () => {
  const baseDir = makeShallowTmpDir();
  const store = new AttachmentStore(baseDir);

  await assert.rejects(
    () => store.deleteDraft("ws1", "conv1", "../../../../../etc/passwd"),
    /Invalid id/,
  );
  fs.rmSync(baseDir, { recursive: true, force: true });
});

test("getAttachment rejects path traversal in attachmentId", async () => {
  const baseDir = makeShallowTmpDir();
  const store = new AttachmentStore(baseDir);

  await assert.rejects(
    () => store.getAttachment("ws1", "conv1", "../../../../../etc/passwd"),
    /Invalid id/,
  );
  fs.rmSync(baseDir, { recursive: true, force: true });
});
