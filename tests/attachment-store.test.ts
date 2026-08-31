import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ATTACHMENT_LIMITS } from "../src/shared/types.ts";
import { AttachmentStore } from "../src/core/attachment-store.ts";
import { ConversationStore } from "../src/core/conversation-store.ts";
import { knownAttachmentExtension } from "../src/shared/attachment-registry.ts";

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
  // WebP magic: RIFF....WEBP
  const webpBuffer = Buffer.from([
    0x52, 0x49, 0x46, 0x46, // RIFF
    0x00, 0x00, 0x00, 0x00, // file size (placeholder)
    0x57, 0x45, 0x42, 0x50, // WEBP
    // ... rest of WebP data
  ]);
  const result = AttachmentStore.validateImageFile(webpBuffer, "image/webp", "test.webp");
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

// --- validateUpload (general files: PDF / text / code) ---

function makePdfBuffer(size = 100): Buffer {
  const header = Buffer.from("%PDF-1.7\n");
  return Buffer.concat([header, Buffer.alloc(Math.max(0, size - header.length), 0x41)]);
}

test("validateUpload accepts a PDF with %PDF- header", () => {
  const result = AttachmentStore.validateUpload(makePdfBuffer(), "application/pdf", "spec.pdf");
  assert.equal(result.valid, true);
  if (result.valid) {
    assert.equal(result.attachment.kind, "file");
    assert.equal(result.attachment.mimeType, "application/pdf");
    assert.equal(result.attachment.ext, "pdf");
    assert.equal(result.attachment.filename, "spec.pdf");
  }
});

test("validateUpload rejects a renamed file that is not a real PDF", () => {
  const result = AttachmentStore.validateUpload(Buffer.from("just text, not a pdf"), "application/pdf", "fake.pdf");
  assert.equal(result.valid, false);
  assert.ok(result.error?.includes("不符"));
});

test("validateUpload accepts text and code files by extension", () => {
  for (const [name, mime] of [
    ["notes.txt", "text/plain"],
    ["README.md", "text/markdown"],
    ["index.ts", "text/typescript"],
    ["app.py", ""],
    ["config.yaml", "text/yaml"],
  ] as const) {
    const result = AttachmentStore.validateUpload(Buffer.from("hello world"), mime, name);
    assert.equal(result.valid, true, name);
  }
});

test("validateUpload rejects dangerous and unknown extensions", () => {
  for (const name of ["archive.zip", "tool.exe", "run.sh", "script.bat", "lib.dll", "noext", "emoji.😀"]) {
    const result = AttachmentStore.validateUpload(Buffer.from("payload"), "", name);
    assert.equal(result.valid, false, name);
    assert.ok(result.error?.includes("不支持的附件类型"), name);
  }
});

// --- Prototype-key extensions must not bypass the whitelist ---

test("extension lookup ignores inherited object keys", () => {
  assert.equal(knownAttachmentExtension("payload.constructor"), null);
  assert.equal(knownAttachmentExtension("evil.__proto__"), null);
  assert.equal(knownAttachmentExtension("data.toString"), null);
  assert.equal(knownAttachmentExtension("x.hasOwnProperty"), null);
  // Real whitelist entries keep working, including case normalization.
  assert.equal(knownAttachmentExtension("photo.png"), "png");
  assert.equal(knownAttachmentExtension("README.MD"), "md");
});

test("validateUpload rejects prototype-key extensions carrying arbitrary bytes", () => {
  for (const name of ["payload.constructor", "evil.__proto__", "data.toString"]) {
    const result = AttachmentStore.validateUpload(Buffer.from("malicious-bytes"), "text/plain", name);
    assert.equal(result.valid, false, name);
    assert.ok(result.error?.includes("不支持的附件类型"), name);
  }
});

test("saveDraft rejects prototype-key extensions before writing anything", async () => {
  const baseDir = makeTmpDir();
  const store = new AttachmentStore(baseDir);
  await assert.rejects(
    () => store.saveDraft({
      workspaceId: "ws1",
      conversationId: "conv1",
      data: Buffer.from("malicious"),
      ext: "constructor",
      filename: "evil.constructor",
    }),
    /Unsupported attachment extension/,
  );
  assert.ok(!fs.existsSync(path.join(baseDir, "tmp", "attachments", "ws1", "conv1")));
});

test("validateUpload rejects empty and oversized files regardless of kind", () => {
  assert.equal(AttachmentStore.validateUpload(Buffer.alloc(0), "text/plain", "empty.txt").valid, false);
  const big = Buffer.alloc(ATTACHMENT_LIMITS.MAX_FILE_SIZE + 1, 0x42);
  assert.equal(AttachmentStore.validateUpload(big, "text/plain", "big.txt").valid, false);
});

test("validateUpload keeps the whitelist extension even when the client MIME disagrees", () => {
  const result = AttachmentStore.validateUpload(Buffer.from("print('hi')"), "application/octet-stream", "script.py");
  assert.equal(result.valid, true);
  if (result.valid) {
    assert.equal(result.attachment.ext, "py");
    assert.equal(result.attachment.mimeType, "text/plain");
  }
});

// --- sanitizeFilename ---

test("sanitizeFilename strips paths, control characters, and mismatched extensions", () => {
  assert.equal(AttachmentStore.sanitizeFilename("/etc/passwd", "txt"), "passwd.txt");
  assert.equal(AttachmentStore.sanitizeFilename("..\\..\\win\\evil.exe", "png"), "evil.png");
  assert.equal(AttachmentStore.sanitizeFilename("bad\x07name.txt", "txt"), "badname.txt");
  assert.equal(AttachmentStore.sanitizeFilename("   .hidden", "md"), "attachment.md");
  assert.equal(AttachmentStore.sanitizeFilename("", "pdf"), "attachment.pdf");
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
    ext: "png",
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
    ext: "png",
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
    ext: "png",
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

  // url field should be generated server-side
  assert.ok(attachments[0].url);
  assert.equal(attachments[0].url, `/api/attachments/ws1/conv1/${draft.id}`);
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

// PR #147 M3④：resource_link 的 URI/MIME/文件名/大小必须取自服务端已校验
// 的永久附件元数据。即使提交请求被篡改（伪造 MIME、谎报大小、携带路径
// 遍历文件名），进入消息与 ACP 链路的仍是服务端固化的值。
test("commitDrafts ignores forged client metadata and uses server-validated values", async () => {
  const baseDir = makeTmpDir();
  const store = new AttachmentStore(baseDir);
  const data = makePdfBuffer(200);

  const draft = await store.saveDraft({
    workspaceId: "ws1",
    conversationId: "conv1",
    data,
    ext: "pdf",
    filename: "innocent.pdf",
  });

  const attachments = await store.commitDrafts({
    workspaceId: "ws1",
    conversationId: "conv1",
    draftAttachments: [{
      id: draft.id,
      // 伪造字段：声明的 MIME、大小与文件名都试图篡改最终元数据。
      mimeType: "text/html",
      filename: "../../evil.pdf",
      size: 1,
    }],
  });

  assert.equal(attachments.length, 1);
  const attachment = attachments[0];
  assert.equal(attachment.mimeType, "application/pdf", "MIME must come from the stored extension, not the request");
  assert.equal(attachment.size, data.length, "size must come from the stored file, not the request");
  assert.equal(attachment.filename, "evil.pdf", "filename must be sanitized: no path segments survive");
  assert.ok(!attachment.filename.includes("/"));
  assert.ok(!attachment.filename.includes("\\"), "backslash traversal must not survive either");
  assert.ok(attachment.path.startsWith(path.join(baseDir, "conversations")), "path must stay inside the server-side store");
});

test("commitDrafts fails the whole message when a draft is missing", async () => {
  const baseDir = makeTmpDir();
  const store = new AttachmentStore(baseDir);

  // Commit a draft that was never saved
  await assert.rejects(
    () => store.commitDrafts({
      workspaceId: "ws1",
      conversationId: "conv1",
      draftAttachments: [{
        id: "nonexistent-id",
        filename: "ghost.png",
      }],
    }),
    /缺失或过期/,
  );
});

test("commitDrafts keeps earlier drafts in place when a later draft is missing", async () => {
  const baseDir = makeTmpDir();
  const store = new AttachmentStore(baseDir);
  const data = makePngBuffer(200);

  const draft = await store.saveDraft({
    workspaceId: "ws1",
    conversationId: "conv1",
    data,
    ext: "png",
    filename: "kept.png",
  });

  await assert.rejects(
    store.commitDrafts({
      workspaceId: "ws1",
      conversationId: "conv1",
      draftAttachments: [
        { id: draft.id, filename: "kept.png" },
        { id: "missing-id", filename: "gone.pdf" },
      ],
    }),
    /缺失或过期/,
  );

  // The valid draft was not moved — the message can be retried after re-upload.
  assert.ok(fs.existsSync(draft.path), "valid draft must survive a failed commit");
});

test("commitDrafts rolls back partial copies so a failed commit stays retryable", async () => {
  const baseDir = makeTmpDir();
  const store = new AttachmentStore(baseDir);

  const draft1 = await store.saveDraft({
    workspaceId: "ws1", conversationId: "conv1",
    data: makePngBuffer(100), ext: "png", filename: "one.png",
  });
  const draft2 = await store.saveDraft({
    workspaceId: "ws1", conversationId: "conv1",
    data: makePngBuffer(120), ext: "png", filename: "two.png",
  });

  // Block the SECOND attachment's permanent target with a directory so its copy fails.
  const permDir = path.join(baseDir, "conversations", "ws1", "conv1", "attachments");
  const blockedTarget = path.join(permDir, `${draft2.id}.png`);
  fs.mkdirSync(blockedTarget, { recursive: true });

  await assert.rejects(store.commitDrafts({
    workspaceId: "ws1",
    conversationId: "conv1",
    draftAttachments: [
      { id: draft1.id, filename: "one.png" },
      { id: draft2.id, filename: "two.png" },
    ],
  }));

  // The first (already copied) target is rolled back and BOTH drafts survive.
  assert.ok(!fs.existsSync(path.join(permDir, `${draft1.id}.png`)), "partial copy must be rolled back");
  assert.ok(fs.existsSync(draft1.path), "first draft must survive the failed commit");
  assert.ok(fs.existsSync(draft2.path), "second draft must survive the failed commit");

  // Remove the block: retrying the SAME drafts now succeeds.
  fs.rmSync(blockedTarget, { recursive: true, force: true });
  const attachments = await store.commitDrafts({
    workspaceId: "ws1",
    conversationId: "conv1",
    draftAttachments: [
      { id: draft1.id, filename: "one.png" },
      { id: draft2.id, filename: "two.png" },
    ],
  });
  assert.equal(attachments.length, 2);
  assert.ok(!fs.existsSync(draft1.path), "first draft moves on retry");
  assert.ok(!fs.existsSync(draft2.path), "second draft moves on retry");
  assert.ok(fs.existsSync(attachments[0].path));
  assert.ok(fs.existsSync(attachments[1].path));
});

test("commitDrafts finds actual file regardless of client mimeType", async () => {
  const baseDir = makeTmpDir();
  const store = new AttachmentStore(baseDir);
  const data = makePngBuffer(200);

  // Upload as PNG
  const draft = await store.saveDraft({
    workspaceId: "ws1",
    conversationId: "conv1",
    data,
    ext: "png",
    filename: "photo.png",
  });

  // Claim it's JPEG in commit — store should find the actual PNG file
  const attachments = await store.commitDrafts({
    workspaceId: "ws1",
    conversationId: "conv1",
    draftAttachments: [{
      id: draft.id,
      mimeType: "image/jpeg", // wrong! file is actually .png
      filename: "photo.png",
      size: draft.size,
    }],
  });

  assert.equal(attachments.length, 1);
  // mimeType should reflect the actual file, not the client claim
  assert.equal(attachments[0].mimeType, "image/png");
  assert.deepEqual(fs.readFileSync(attachments[0].path), data);
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
    ext: "jpg",
    filename: "photo.jpg",
  });

  const [attachment] = await store.commitDrafts({
    workspaceId: "ws1",
    conversationId: "conv1",
    draftAttachments: [{
      id: draft.id,
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
    ext: "png",
    filename: "test.png",
  });

  await store.commitDrafts({
    workspaceId: "ws1",
    conversationId: "conv1",
    draftAttachments: [{
      id: draft.id,
      filename: "test.png",
      size: draft.size,
    }],
  });

  // Using a prefix of the id should NOT match
  const result = await store.getAttachment("ws1", "conv1", draft.id.slice(0, 8));
  assert.equal(result, null);
});

// --- conversation deletion removes permanent attachments ---

test("deleting a conversation removes its permanent attachments", async () => {
  // ConversationStore.delete() 会删除整个 conversations/<ws>/<conv> 目录，
  // 永久附件随之清理；服务端不再额外并发删除同一目录（避免 Windows 上的
  // EBUSY/EPERM 竞态）。
  const baseDir = makeTmpDir();
  const store = new AttachmentStore(baseDir);
  const conversations = new ConversationStore(baseDir);
  const conversation = conversations.create("ws1", "With attachments");

  const draft = await store.saveDraft({
    workspaceId: "ws1", conversationId: conversation.id, data: makePngBuffer(100),
    ext: "png", filename: "img1.png",
  });

  const [attachment] = await store.commitDrafts({
    workspaceId: "ws1",
    conversationId: conversation.id,
    draftAttachments: [
      { id: draft.id, mimeType: "image/png", filename: "img1.png", size: draft.size },
    ],
  });

  assert.ok(fs.existsSync(attachment.path));

  conversations.delete("ws1", conversation.id);

  assert.ok(!fs.existsSync(attachment.path), "attachments must not survive conversation deletion");
  assert.ok(!fs.existsSync(path.dirname(attachment.path)), "the attachment directory must be gone");
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
    ext: "png",
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
      ext: "png",
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

// --- 展示文件名索引（PR #147 审查修复：下载不再全量扫描历史分片） ---

test("commitDrafts records display filenames so downloads skip the history scan", async () => {
  const baseDir = makeTmpDir();
  const store = new AttachmentStore(baseDir);

  const draft = await store.saveDraft({
    workspaceId: "ws1", conversationId: "conv1", data: makePngBuffer(120),
    ext: "png", filename: "设计稿 终版.png",
  });

  assert.equal(
    await store.attachmentFilename("ws1", "conv1", draft.id),
    null,
    "the index must be empty before the draft is committed",
  );

  const [attachment] = await store.commitDrafts({
    workspaceId: "ws1",
    conversationId: "conv1",
    draftAttachments: [{ id: draft.id, mimeType: "image/png", filename: "设计稿 终版.png", size: draft.size }],
  });

  assert.equal(
    await store.attachmentFilename("ws1", "conv1", draft.id),
    attachment.filename,
    "the committed display name must be readable from the index alone",
  );
  assert.equal(attachment.filename, "设计稿 终版.png");
});

test("rememberAttachmentFilename backfills names for attachments predating the index", async () => {
  const baseDir = makeTmpDir();
  const store = new AttachmentStore(baseDir);

  await store.rememberAttachmentFilename("ws1", "conv1", "legacy-id", "旧附件.txt");

  assert.equal(await store.attachmentFilename("ws1", "conv1", "legacy-id"), "旧附件.txt");
  assert.equal(await store.attachmentFilename("ws1", "conv1", "other-id"), null);
  await assert.rejects(
    () => store.attachmentFilename("ws1", "conv1", "../../etc/passwd"),
    /Invalid id/,
  );
});

// --- 单条消息附件合计上限（PR #147 审查修复） ---

test("commitDrafts rejects a batch whose combined size exceeds the per-message cap", async () => {
  const baseDir = makeTmpDir();
  const store = new AttachmentStore(baseDir);

  // 5 个文件合计 > MAX_TOTAL_SIZE_PER_MESSAGE (20MB)，单个仍 < MAX_FILE_SIZE (5MB)。
  const perFile = Math.floor(ATTACHMENT_LIMITS.MAX_TOTAL_SIZE_PER_MESSAGE / 5) + 1;
  const drafts: Array<{ id: string; path: string; size: number }> = [];
  for (let i = 0; i < ATTACHMENT_LIMITS.MAX_FILES_PER_MESSAGE; i++) {
    drafts.push(await store.saveDraft({
      workspaceId: "ws1", conversationId: "conv1", data: makePngBuffer(perFile),
      ext: "png", filename: `big-${i}.png`,
    }));
  }

  await assert.rejects(
    () => store.commitDrafts({
      workspaceId: "ws1",
      conversationId: "conv1",
      draftAttachments: drafts.map((draft) => ({
        id: draft.id, mimeType: "image/png", filename: "big.png", size: draft.size,
      })),
    }),
    /超过限制/,
    "the combined cap must reject the whole batch",
  );

  // 失败后草稿与永久目录都必须保持可重试状态：草稿还在，没有永久文件落地。
  for (const draft of drafts) {
    assert.ok(fs.existsSync(draft.path), "drafts must survive a rejected commit");
  }
  const permDir = path.join(baseDir, "conversations", "ws1", "conv1", "attachments");
  assert.ok(!fs.existsSync(permDir), "no permanent file may be written before the size cap passes");
});

test("commitDrafts accepts a batch under the combined cap", async () => {
  const baseDir = makeTmpDir();
  const store = new AttachmentStore(baseDir);

  const a = await store.saveDraft({
    workspaceId: "ws1", conversationId: "conv1", data: makePngBuffer(500),
    ext: "png", filename: "a.png",
  });
  const b = await store.saveDraft({
    workspaceId: "ws1", conversationId: "conv1", data: makeJpegBuffer(700),
    ext: "jpg", filename: "b.jpg",
  });

  const attachments = await store.commitDrafts({
    workspaceId: "ws1",
    conversationId: "conv1",
    draftAttachments: [
      { id: a.id, mimeType: "image/png", filename: "a.png", size: a.size },
      { id: b.id, mimeType: "image/jpeg", filename: "b.jpg", size: b.size },
    ],
  });

  assert.equal(attachments.length, 2);
  assert.equal(attachments.reduce((sum, item) => sum + item.size, 0), 1200);
});
