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
    fs.mkdirSync(draftDir, { recursive: true });
    const filePath = path.join(draftDir, `${id}.${ext}`);
    fs.writeFileSync(filePath, params.data);
    return { id, path: filePath, size: params.data.length };
  }

  async deleteDraft(workspaceId: string, conversationId: string, attachmentId: string): Promise<boolean> {
    AttachmentStore.validateId(attachmentId);
    const draftBase = this.safePath("tmp", "attachments", workspaceId, conversationId, attachmentId);
    if (!fs.existsSync(draftBase)) return false;
    fs.rmSync(draftBase, { recursive: true, force: true });
    return true;
  }

  async getDraft(
    workspaceId: string,
    conversationId: string,
    draftId: string,
  ): Promise<{ data: Buffer; mimeType: string; filename: string } | null> {
    AttachmentStore.validateId(draftId);
    const draftBase = this.safePath("tmp", "attachments", workspaceId, conversationId, draftId);
    if (!fs.existsSync(draftBase)) return null;

    // Find the file with matching id in the draft directory
    for (const ext of KNOWN_EXTENSIONS) {
      const candidate = path.join(draftBase, `${draftId}.${ext}`);
      if (fs.existsSync(candidate)) {
        const mimeType = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
        return {
          data: fs.readFileSync(candidate),
          mimeType,
          filename: `${draftId}.${ext}`,
        };
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
    fs.mkdirSync(permDir, { recursive: true });

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
        if (fs.existsSync(candidate)) {
          draftFile = candidate;
          actualExt = ext;
          break;
        }
      }

      if (!draftFile || !actualExt) {
        // Draft file was cleaned up or never existed — skip with warning
        console.warn(`[orbit] draft file not found for attachment ${draft.id}, skipping`);
        try { fs.rmSync(draftDir, { recursive: true, force: true }); } catch { /* already gone */ }
        continue;
      }

      const mimeType = actualExt === "jpg" ? "image/jpeg" : `image/${actualExt}` as MessageAttachment["mimeType"];
      const permPath = path.join(permDir, `${draft.id}.${actualExt}`);

      // Move the file (copy + delete for cross-device safety)
      fs.copyFileSync(draftFile, permPath);
      fs.rmSync(draftFile, { force: true });
      // Clean up draft directory
      try { fs.rmSync(draftDir, { recursive: true, force: true }); } catch { /* already gone */ }

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
    if (!fs.existsSync(permDir)) return null;

    // Exact extension match — iterate known extensions instead of prefix matching
    for (const ext of KNOWN_EXTENSIONS) {
      const candidate = path.join(permDir, `${attachmentId}.${ext}`);
      if (fs.existsSync(candidate)) {
        const mimeType = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
        return { data: fs.readFileSync(candidate), mimeType };
      }
    }

    return null;
  }

  async deleteConversationAttachments(workspaceId: string, conversationId: string): Promise<void> {
    const permDir = this.safePath("conversations", workspaceId, conversationId, "attachments");
    if (fs.existsSync(permDir)) {
      fs.rmSync(permDir, { recursive: true, force: true });
    }
  }

  // --- Cleanup ---

  async cleanupExpiredDrafts(): Promise<number> {
    const tmpDir = this.safePath("tmp", "attachments");
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
