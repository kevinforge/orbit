import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { ATTACHMENT_LIMITS, type MessageAttachment } from "../shared/types.ts";
import {
  attachmentExtensionSpec,
  knownAttachmentExtension,
} from "../shared/attachment-registry.ts";

const ALLOWED_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set<string>(ATTACHMENT_LIMITS.ALLOWED_IMAGE_MIME_TYPES);

const MAX_DISPLAY_FILENAME_LENGTH = 120;

export type ValidatedUpload = {
  kind: "image" | "file";
  /** Server-validated extension (from the whitelist) used for the stored file. */
  ext: string;
  /** Canonical MIME derived from the extension, not the client claim. */
  mimeType: string;
  /** Sanitized display filename with the validated extension. */
  filename: string;
};

export type StoredAttachment = {
  data: Buffer;
  ext: string;
  kind: "image" | "file";
  /** Canonical MIME for the stored extension. */
  mimeType: string;
  /** Stored file name (`<id>.<ext>`), always ASCII-safe. */
  filename: string;
};

export class AttachmentStore {
  constructor(private readonly baseDir: string) {}

  // --- Path safety ---

  /** Resolve path segments under baseDir and verify no directory traversal. */
  private safePath(...segments: string[]): string {
    const resolved = path.resolve(this.baseDir, ...segments);
    const base = path.resolve(this.baseDir) + path.sep;
    if (!resolved.startsWith(base) && resolved !== path.resolve(this.baseDir)) {
      throw new Error("Invalid path: directory traversal detected");
    }
    return resolved;
  }

  /** Validate that an id segment does not contain path separators or traversal. */
  private static validateId(id: string): void {
    if (id.includes("/") || id.includes("\\") || id.includes("..")) {
      throw new Error("Invalid id: contains path separators or traversal");
    }
  }

  // --- Draft operations ---

  /**
   * Issue #88: Count drafts for a conversation.
   * Used to enforce the MAX_DRAFTS_PER_CONVERSATION limit.
   */
  async countDrafts(workspaceId: string, conversationId: string): Promise<number> {
    const draftDir = this.safePath("tmp", "attachments", workspaceId, conversationId);
    try {
      await fsPromises.access(draftDir);
    } catch {
      return 0;
    }

    const entries = await fsPromises.readdir(draftDir, { withFileTypes: true });
    return entries.filter(entry => entry.isDirectory()).length;
  }

  async saveDraft(params: {
    workspaceId: string;
    conversationId: string;
    data: Buffer;
    /** Server-validated extension from the whitelist — never a client MIME. */
    ext: string;
    /** Sanitized display filename. */
    filename: string;
  }): Promise<{ id: string; path: string; size: number }> {
    const spec = attachmentExtensionSpec(params.ext);
    if (!spec) {
      throw new Error(`Unsupported attachment extension: ${params.ext}`);
    }
    const id = randomUUID();
    const ext = params.ext.toLowerCase();
    const draftDir = this.safePath(
      "tmp", "attachments",
      params.workspaceId, params.conversationId, id,
    );
    await fsPromises.mkdir(draftDir, { recursive: true });
    const filePath = path.join(draftDir, `${id}.${ext}`);
    await fsPromises.writeFile(filePath, params.data);
    return { id, path: filePath, size: params.data.length };
  }

  async deleteDraft(workspaceId: string, conversationId: string, attachmentId: string): Promise<boolean> {
    AttachmentStore.validateId(attachmentId);
    const draftBase = this.safePath("tmp", "attachments", workspaceId, conversationId, attachmentId);
    try {
      await fsPromises.access(draftBase);
    } catch {
      return false;
    }
    await fsPromises.rm(draftBase, { recursive: true, force: true });
    return true;
  }

  async getDraft(
    workspaceId: string,
    conversationId: string,
    draftId: string,
  ): Promise<StoredAttachment | null> {
    AttachmentStore.validateId(draftId);
    const draftBase = this.safePath("tmp", "attachments", workspaceId, conversationId, draftId);
    return AttachmentStore.findStoredFile(draftBase, draftId);
  }

  // --- Permanent attachment operations ---

  async commitDrafts(params: {
    workspaceId: string;
    conversationId: string;
    draftAttachments: Array<{ id: string; mimeType?: string; filename: string; size?: number }>;
  }): Promise<MessageAttachment[]> {
    if (params.draftAttachments.length === 0) return [];

    for (const draft of params.draftAttachments) {
      AttachmentStore.validateId(draft.id);
    }

    // Phase 1: locate and re-validate every draft without mutating anything.
    // A missing/expired/tampered draft fails the whole message so attachments
    // are never silently dropped; drafts stay in place for a retry.
    const located: Array<{
      draft: { id: string; filename: string };
      draftDir: string;
      stored: StoredAttachment;
    }> = [];
    for (const draft of params.draftAttachments) {
      const draftDir = this.safePath(
        "tmp", "attachments",
        params.workspaceId, params.conversationId, draft.id,
      );
      const stored = await AttachmentStore.findStoredFile(draftDir, draft.id);
      if (!stored) {
        const displayExt = knownAttachmentExtension(draft.filename) ?? "file";
        throw new Error(`附件草稿已缺失或过期：${AttachmentStore.sanitizeFilename(draft.filename, displayExt)}，请重新上传后再发送。`);
      }
      const recheck = AttachmentStore.validateStoredContent(stored.data, stored.ext);
      if (!recheck.valid) {
        throw new Error(`附件内容校验失败：${recheck.error}`);
      }
      located.push({ draft, draftDir, stored });
    }

    const permDir = this.safePath(
      "conversations",
      params.workspaceId, params.conversationId, "attachments",
    );
    await fsPromises.mkdir(permDir, { recursive: true });

    // Phase 2: copy EVERY draft to its permanent path before deleting anything.
    // A mid-batch failure rolls the partial copies back and keeps all drafts so
    // the same message can be retried; no orphan permanent files are left behind.
    const staged = located.map((entry) => ({
      ...entry,
      sourcePath: path.join(entry.draftDir, entry.stored.filename),
      permPath: path.join(permDir, entry.stored.filename),
    }));
    const copied: string[] = [];
    try {
      for (const item of staged) {
        // Copy + delete (instead of rename) for cross-device safety.
        await fsPromises.copyFile(item.sourcePath, item.permPath);
        copied.push(item.permPath);
      }
    } catch (error) {
      for (const permPath of copied) {
        try { await fsPromises.rm(permPath, { force: true }); } catch { /* best effort */ }
      }
      throw error;
    }

    // Phase 3: everything is in place — remove the draft directories and report.
    const results: MessageAttachment[] = [];
    for (const { draft, draftDir, stored, permPath } of staged) {
      try { await fsPromises.rm(draftDir, { recursive: true, force: true }); } catch { /* already gone */ }

      const base = {
        id: draft.id,
        // Actual size comes from the file system, not the commit request.
        filename: AttachmentStore.sanitizeFilename(draft.filename, stored.ext),
        path: permPath,
        url: `/api/attachments/${params.workspaceId}/${params.conversationId}/${draft.id}`,
        size: stored.data.length,
        createdAt: new Date().toISOString(),
      };
      results.push(stored.kind === "image"
        ? { ...base, kind: "image", mimeType: stored.mimeType } as MessageAttachment
        : { ...base, kind: "file", mimeType: stored.mimeType });
    }

    return results;
  }

  async getAttachment(
    workspaceId: string,
    conversationId: string,
    attachmentId: string,
  ): Promise<StoredAttachment | null> {
    AttachmentStore.validateId(attachmentId);
    const permDir = this.safePath("conversations", workspaceId, conversationId, "attachments");
    return AttachmentStore.findStoredFile(permDir, attachmentId);
  }

  async deleteConversationAttachments(workspaceId: string, conversationId: string): Promise<void> {
    const permDir = this.safePath("conversations", workspaceId, conversationId, "attachments");
    try {
      await fsPromises.access(permDir);
      await fsPromises.rm(permDir, { recursive: true, force: true });
    } catch {
      // Directory doesn't exist, nothing to delete
    }
  }

  // --- Cleanup ---

  async cleanupExpiredDrafts(): Promise<number> {
    const tmpDir = this.safePath("tmp", "attachments");
    try {
      await fsPromises.access(tmpDir);
    } catch {
      return 0;
    }

    const now = Date.now();
    let cleaned = 0;

    await this.cleanExpiredRecursive(tmpDir, now, (count) => { cleaned += count; });
    return cleaned;
  }

  private async cleanExpiredRecursive(dir: string, now: number, onCleaned: (n: number) => void): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fsPromises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.cleanExpiredRecursive(fullPath, now, onCleaned);
        // Remove empty directories
        try {
          await fsPromises.rmdir(fullPath);
        } catch { /* not empty */ }
      } else if (entry.isFile()) {
        const stat = await fsPromises.stat(fullPath);
        if (now - stat.mtimeMs > ATTACHMENT_LIMITS.DRAFT_MAX_AGE_MS) {
          await fsPromises.rm(fullPath, { force: true });
          onCleaned(1);
        }
      }
    }
  }

  // --- Validation ---

  /**
   * Issue #85: Validate image file by checking magic numbers (file headers).
   * This prevents malicious files from being uploaded with forged MIME types.
   */
  private static validateMagicNumber(data: Buffer, mimeType: string): boolean {
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    // JPEG: FF D8 FF
    const JPEG_MAGIC = Buffer.from([0xFF, 0xD8, 0xFF]);
    // WebP: RIFF (52 49 46 46) - note: WebP files start with RIFF....WEBP
    const WEBP_RIFF = Buffer.from([0x52, 0x49, 0x46, 0x46]);
    const WEBP_TAG = Buffer.from([0x57, 0x45, 0x42, 0x50]); // "WEBP" at offset 8

    if (mimeType === "image/png") {
      return data.length >= 8 && data.slice(0, 8).equals(PNG_MAGIC);
    }
    if (mimeType === "image/jpeg") {
      return data.length >= 3 && data.slice(0, 3).equals(JPEG_MAGIC);
    }
    if (mimeType === "image/webp") {
      // WebP format: RIFF....WEBP....
      return data.length >= 12 &&
        data.slice(0, 4).equals(WEBP_RIFF) &&
        data.slice(8, 12).equals(WEBP_TAG);
    }
    // Unknown type - pass through (handled by MIME type check)
    return true;
  }

  static validateImageFile(
    data: Buffer,
    mimeType: string,
    filename: string,
  ): { valid: boolean; error?: string } {
    if (!ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) {
      return { valid: false, error: `Unsupported image type: ${mimeType}. Allowed: ${ATTACHMENT_LIMITS.ALLOWED_IMAGE_MIME_TYPES.join(", ")}` };
    }
    if (data.length === 0) {
      return { valid: false, error: "File is empty." };
    }
    if (data.length > ATTACHMENT_LIMITS.MAX_FILE_SIZE) {
      return { valid: false, error: `File size (${(data.length / 1024 / 1024).toFixed(1)}MB) exceeds limit (${ATTACHMENT_LIMITS.MAX_FILE_SIZE / 1024 / 1024}MB).` };
    }

    // Issue #85: Verify file content matches declared MIME type
    if (!this.validateMagicNumber(data, mimeType)) {
      return { valid: false, error: `File content does not match declared type ${mimeType}.` };
    }

    return { valid: true };
  }

  /**
   * 通用上传校验：以文件名扩展名白名单为准（客户端 MIME 仅作参考），
   * 图片校验魔数，PDF 要求 `%PDF-` 头部，纯文本/代码无稳定魔数故只校验
   * 扩展名与大小。返回规范化后的附件元数据供落盘使用。
   */
  static validateUpload(
    data: Buffer,
    _declaredMimeType: string,
    rawFilename: string,
  ): { valid: true; attachment: ValidatedUpload } | { valid: false; error: string } {
    if (data.length === 0) {
      return { valid: false, error: "文件为空。" };
    }
    if (data.length > ATTACHMENT_LIMITS.MAX_FILE_SIZE) {
      return { valid: false, error: `文件大小 (${(data.length / 1024 / 1024).toFixed(1)}MB) 超过限制 (${ATTACHMENT_LIMITS.MAX_FILE_SIZE / 1024 / 1024}MB)。` };
    }

    const ext = knownAttachmentExtension(rawFilename);
    const spec = ext ? attachmentExtensionSpec(ext) : undefined;
    if (!ext || !spec) {
      return { valid: false, error: `不支持的附件类型：${rawFilename || "未命名文件"}。允许图片（png/jpg/webp）、文档（pdf/txt/md）与常见代码/配置文件。` };
    }

    if (spec.kind === "image" && !this.validateMagicNumber(data, spec.mimeType)) {
      return { valid: false, error: `文件内容与类型不符（${spec.mimeType}）。` };
    }
    if (ext === "pdf") {
      const PDF_MAGIC = Buffer.from("%PDF-");
      if (data.length < 5 || !data.slice(0, 5).equals(PDF_MAGIC)) {
        return { valid: false, error: "文件内容与类型不符（application/pdf）。" };
      }
    }

    return {
      valid: true,
      attachment: {
        kind: spec.kind,
        ext,
        mimeType: spec.mimeType,
        filename: AttachmentStore.sanitizeFilename(rawFilename, ext),
      },
    };
  }

  /** commit 前对已落盘草稿的字节做复验（大小 + 魔数）。 */
  private static validateStoredContent(data: Buffer, ext: string): { valid: boolean; error?: string } {
    const spec = attachmentExtensionSpec(ext);
    if (!spec) {
      return { valid: false, error: `未知扩展名 ${ext}` };
    }
    if (data.length === 0 || data.length > ATTACHMENT_LIMITS.MAX_FILE_SIZE) {
      return { valid: false, error: "文件大小超出限制" };
    }
    if (spec.kind === "image" && !AttachmentStore.validateMagicNumber(data, spec.mimeType)) {
      return { valid: false, error: `文件内容与类型不符（${spec.mimeType}）` };
    }
    const PDF_MAGIC = Buffer.from("%PDF-");
    if (ext === "pdf" && (data.length < 5 || !data.slice(0, 5).equals(PDF_MAGIC))) {
      return { valid: false, error: "文件内容与类型不符（application/pdf）" };
    }
    return { valid: true };
  }

  /**
   * 规范化展示文件名：去除路径与控制字符、限制长度，并强制使用服务端
   * 验证过的扩展名；无法得出有效主干时回退为 `attachment.<ext>`。
   */
  static sanitizeFilename(name: string, ext: string): string {
    const base = path.basename(String(name ?? "").replace(/\\/g, "/"))
      .replace(/[\x00-\x1f\x7f]/g, "")
      .trim()
      .slice(0, MAX_DISPLAY_FILENAME_LENGTH);
    const dot = base.lastIndexOf(".");
    // No dot: the whole base is the stem; a leading dot (".hidden") leaves no stem.
    const stem = dot > 0 ? base.slice(0, dot) : (dot === -1 ? base : "");
    if (!stem || stem === "." || stem === "..") {
      return `attachment.${ext}`;
    }
    return `${stem}.${ext}`;
  }

  /**
   * Locate the stored file for an id: the whole stem must equal the id (no
   * prefix matches) and the extension must be whitelisted.
   */
  private static findStoredFile(dir: string, id: string): Promise<StoredAttachment | null> {
    return fsPromises.readdir(dir).then(
      (names) => {
        for (const name of names) {
          const dot = name.lastIndexOf(".");
          if (dot <= 0 || name.slice(0, dot) !== id) continue;
          const ext = name.slice(dot + 1).toLowerCase();
          const spec = attachmentExtensionSpec(ext);
          if (!spec) continue;
          return fsPromises.readFile(path.join(dir, name)).then((data): StoredAttachment => ({
            data,
            ext,
            kind: spec.kind,
            mimeType: spec.mimeType,
            filename: name,
          }));
        }
        return null;
      },
      () => null,
    );
  }
}
