import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { ATTACHMENT_LIMITS, type MessageAttachment } from "../shared/types.ts";

const ALLOWED_MIME_TYPES: ReadonlySet<string> = new Set<string>(ATTACHMENT_LIMITS.ALLOWED_MIME_TYPES);

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

export class AttachmentStore {
  constructor(private readonly baseDir: string) {}

  // --- Draft operations ---

  async saveDraft(params: {
    workspaceId: string;
    conversationId: string;
    data: Buffer;
    mimeType: string;
    filename: string;
  }): Promise<{ id: string; path: string; size: number }> {
    const id = randomUUID();
    const ext = MIME_TO_EXT[params.mimeType] ?? (path.extname(params.filename).slice(1) || "bin");
    const draftDir = path.join(
      this.baseDir, "tmp", "attachments",
      params.workspaceId, params.conversationId, id,
    );
    fs.mkdirSync(draftDir, { recursive: true });
    const filePath = path.join(draftDir, `${id}.${ext}`);
    fs.writeFileSync(filePath, params.data);
    return { id, path: filePath, size: params.data.length };
  }

  async deleteDraft(workspaceId: string, conversationId: string, attachmentId: string): Promise<boolean> {
    const draftBase = path.join(this.baseDir, "tmp", "attachments", workspaceId, conversationId, attachmentId);
    if (!fs.existsSync(draftBase)) return false;
    fs.rmSync(draftBase, { recursive: true, force: true });
    return true;
  }

  // --- Permanent attachment operations ---

  async commitDrafts(params: {
    workspaceId: string;
    conversationId: string;
    draftAttachments: Array<{ id: string; path: string; mimeType: string; filename: string; size: number }>;
  }): Promise<MessageAttachment[]> {
    if (params.draftAttachments.length === 0) return [];

    const permDir = path.join(
      this.baseDir, "conversations",
      params.workspaceId, params.conversationId, "attachments",
    );
    fs.mkdirSync(permDir, { recursive: true });

    const results: MessageAttachment[] = [];

    for (const draft of params.draftAttachments) {
      const ext = MIME_TO_EXT[draft.mimeType] ?? (path.extname(draft.filename).slice(1) || "bin");
      const permPath = path.join(permDir, `${draft.id}.${ext}`);

      if (fs.existsSync(draft.path)) {
        // Move the file (copy + delete for cross-device safety)
        fs.copyFileSync(draft.path, permPath);
        fs.rmSync(draft.path, { force: true });
        // Clean up draft directory if empty
        const draftDir = path.dirname(draft.path);
        try { fs.rmdirSync(draftDir); } catch { /* not empty or already gone */ }
      }

      results.push({
        id: draft.id,
        kind: "image",
        mimeType: draft.mimeType as "image/png" | "image/jpeg" | "image/webp",
        filename: draft.filename,
        path: permPath,
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
    const permDir = path.join(this.baseDir, "conversations", workspaceId, conversationId, "attachments");
    if (!fs.existsSync(permDir)) return null;

    const files = fs.readdirSync(permDir);
    const match = files.find((f) => f.startsWith(attachmentId + "."));
    if (!match) return null;

    const filePath = path.join(permDir, match);
    const ext = path.extname(match).slice(1);
    const mimeType = ext === "jpg" ? "image/jpeg" : `image/${ext}`;

    return { data: fs.readFileSync(filePath), mimeType };
  }

  async deleteConversationAttachments(workspaceId: string, conversationId: string): Promise<void> {
    const permDir = path.join(this.baseDir, "conversations", workspaceId, conversationId, "attachments");
    if (fs.existsSync(permDir)) {
      fs.rmSync(permDir, { recursive: true, force: true });
    }
  }

  // --- Cleanup ---

  async cleanupExpiredDrafts(): Promise<number> {
    const tmpDir = path.join(this.baseDir, "tmp", "attachments");
    if (!fs.existsSync(tmpDir)) return 0;

    const now = Date.now();
    let cleaned = 0;

    this.cleanExpiredRecursive(tmpDir, now, (count) => { cleaned += count; });
    return cleaned;
  }

  private cleanExpiredRecursive(dir: string, now: number, onCleaned: (n: number) => void): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        this.cleanExpiredRecursive(fullPath, now, onCleaned);
        // Remove empty directories
        try {
          fs.rmdirSync(fullPath);
        } catch { /* not empty */ }
      } else if (entry.isFile()) {
        const stat = fs.statSync(fullPath);
        if (now - stat.mtimeMs > ATTACHMENT_LIMITS.DRAFT_MAX_AGE_MS) {
          fs.rmSync(fullPath, { force: true });
          onCleaned(1);
        }
      }
    }
  }

  // --- Validation ---

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
    return { valid: true };
  }
}
