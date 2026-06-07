import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { ATTACHMENT_LIMITS, type MessageAttachment } from "../shared/types.ts";

const ALLOWED_MIME_TYPES: ReadonlySet<string> = new Set<string>(ATTACHMENT_LIMITS.ALLOWED_MIME_TYPES);

// MIME_TO_EXT must include all types from ATTACHMENT_LIMITS.ALLOWED_MIME_TYPES in types.ts
// If adding a new MIME type, update both this map and ALLOWED_MIME_TYPES
const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

const KNOWN_EXTENSIONS = ["png", "jpg", "webp"];

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
    mimeType: string;
    filename: string;
  }): Promise<{ id: string; path: string; size: number }> {
    const id = randomUUID();
    const ext = MIME_TO_EXT[params.mimeType] ?? (path.extname(params.filename).slice(1) || "bin");
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
  ): Promise<{ data: Buffer; mimeType: string; filename: string } | null> {
    AttachmentStore.validateId(draftId);
    const draftBase = this.safePath("tmp", "attachments", workspaceId, conversationId, draftId);
    try {
      await fsPromises.access(draftBase);
    } catch {
      return null;
    }

    // Find the file with matching id in the draft directory
    for (const ext of KNOWN_EXTENSIONS) {
      const candidate = path.join(draftBase, `${draftId}.${ext}`);
      try {
        await fsPromises.access(candidate);
        const mimeType = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
        return {
          data: await fsPromises.readFile(candidate),
          mimeType,
          filename: `${draftId}.${ext}`,
        };
      } catch {
        // File doesn't exist, try next extension
      }
    }

    return null;
  }

  // --- Permanent attachment operations ---

  async commitDrafts(params: {
    workspaceId: string;
    conversationId: string;
    draftAttachments: Array<{ id: string; mimeType: string; filename: string; size: number }>;
  }): Promise<MessageAttachment[]> {
    if (params.draftAttachments.length === 0) return [];

    for (const draft of params.draftAttachments) {
      AttachmentStore.validateId(draft.id);
    }

    const permDir = this.safePath(
      "conversations",
      params.workspaceId, params.conversationId, "attachments",
    );
    await fsPromises.mkdir(permDir, { recursive: true });

    const results: MessageAttachment[] = [];

    for (const draft of params.draftAttachments) {
      // Rebuild draft directory from workspaceId + conversationId + id (not client path)
      const draftDir = this.safePath(
        "tmp", "attachments",
        params.workspaceId, params.conversationId, draft.id,
      );

      // Find the actual file in draft directory by scanning known extensions
      // (don't trust client-provided mimeType — it may differ from the saved file)
      let draftFile: string | null = null;
      let actualExt: string | null = null;
      for (const ext of KNOWN_EXTENSIONS) {
        const candidate = path.join(draftDir, `${draft.id}.${ext}`);
        try {
          await fsPromises.access(candidate);
          draftFile = candidate;
          actualExt = ext;
          break;
        } catch {
          // File doesn't exist, try next extension
        }
      }

      if (!draftFile || !actualExt) {
        // Draft file was cleaned up or never existed — skip with warning
        console.warn(`[orbit] draft file not found for attachment ${draft.id}, skipping`);
        try { await fsPromises.rm(draftDir, { recursive: true, force: true }); } catch { /* already gone */ }
        continue;
      }

      const mimeType = actualExt === "jpg" ? "image/jpeg" : `image/${actualExt}` as MessageAttachment["mimeType"];
      const permPath = path.join(permDir, `${draft.id}.${actualExt}`);

      // Move the file (copy + delete for cross-device safety)
      await fsPromises.copyFile(draftFile, permPath);
      await fsPromises.rm(draftFile, { force: true });
      // Clean up draft directory
      try { await fsPromises.rm(draftDir, { recursive: true, force: true }); } catch { /* already gone */ }

      results.push({
        id: draft.id,
        kind: "image",
        mimeType,
        filename: draft.filename,
        path: permPath,
        url: `/api/attachments/${params.workspaceId}/${params.conversationId}/${draft.id}`,
        size: draft.size,
        createdAt: new Date().toISOString(),
      });
    }

    return results;
  }

  async getAttachment(
    workspaceId: string,
    conversationId: string,
    attachmentId: string,
  ): Promise<{ data: Buffer; mimeType: string } | null> {
    AttachmentStore.validateId(attachmentId);
    const permDir = this.safePath("conversations", workspaceId, conversationId, "attachments");
    try {
      await fsPromises.access(permDir);
    } catch {
      return null;
    }

    // Exact extension match — iterate known extensions instead of prefix matching
    for (const ext of KNOWN_EXTENSIONS) {
      const candidate = path.join(permDir, `${attachmentId}.${ext}`);
      try {
        await fsPromises.access(candidate);
        const mimeType = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
        return { data: await fsPromises.readFile(candidate), mimeType };
      } catch {
        // File doesn't exist, try next extension
      }
    }

    return null;
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
    if (!ALLOWED_MIME_TYPES.has(mimeType)) {
      return { valid: false, error: `Unsupported image type: ${mimeType}. Allowed: ${ATTACHMENT_LIMITS.ALLOWED_MIME_TYPES.join(", ")}` };
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
}
