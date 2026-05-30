import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

import type { Workspace } from "../shared/types.ts";

export type WorkspaceInfo = {
  id: string;
  name: string;
  path: string;
};

type WorkspaceMetadata = WorkspaceInfo & {
  createdAt: string;
  lastOpenedAt: string;
};

export class WorkspaceStore {
  private readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? path.join(os.homedir(), ".orbit");
  }

  static deriveId(cwd: string): string {
    const resolved = path.resolve(cwd);
    const normalized = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 12);
  }

  resolve(cwd: string): WorkspaceInfo {
    const id = WorkspaceStore.deriveId(cwd);
    const metadataPath = this.metadataPath(id);

    try {
      const metadata = this.readMetadata(id);
      const updated = { ...metadata, lastOpenedAt: new Date().toISOString() };
      this.writeMetadata(id, updated);
      return { id: metadata.id, name: metadata.name, path: metadata.path };
    } catch {
      const now = new Date().toISOString();
      const name = path.basename(cwd);
      const workspace: WorkspaceMetadata = { id, name, path: path.resolve(cwd), createdAt: now, lastOpenedAt: now };
      this.writeMetadata(id, workspace);
      return { id, name, path: path.resolve(cwd) };
    }
  }

  list(): Workspace[] {
    const workspacesDir = path.join(this.baseDir, "workspaces");
    try {
      const entries = fs.readdirSync(workspacesDir);
      const workspaces: Workspace[] = [];
      for (const entry of entries) {
        try {
          workspaces.push(this.readMetadata(entry));
        } catch {
          // skip malformed workspace directories
        }
      }
      workspaces.sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));
      return workspaces;
    } catch {
      return [];
    }
  }

  get(id: string): Workspace | null {
    try {
      return this.readMetadata(id);
    } catch {
      return null;
    }
  }

  create(name: string, dirPath: string): Workspace {
    const id = WorkspaceStore.deriveId(dirPath);
    const existing = this.get(id);
    if (existing) {
      throw new Error(`Workspace already exists for path "${dirPath}": ${existing.name} (${existing.id})`);
    }
    const now = new Date().toISOString();
    const resolvedPath = path.resolve(dirPath);
    const workspaceName = name.trim() || path.basename(resolvedPath) || resolvedPath;
    const metadata: WorkspaceMetadata = { id, name: workspaceName, path: resolvedPath, createdAt: now, lastOpenedAt: now };
    this.writeMetadata(id, metadata);
    return metadata;
  }

  update(id: string, patch: { name?: string }): Workspace {
    const existing = this.get(id);
    if (!existing) {
      throw new Error(`Workspace not found: ${id}`);
    }
    const updated: WorkspaceMetadata = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
    };
    this.writeMetadata(id, updated);
    return updated;
  }

  delete(id: string): void {
    const existing = this.get(id);
    if (!existing) {
      throw new Error(`Workspace not found: ${id}`);
    }
    const dirs = [
      path.join(this.baseDir, "workspaces", id),
      path.join(this.baseDir, "sessions", id),
      path.join(this.baseDir, "channels", id),
      path.join(this.baseDir, "transcripts", id),
    ];
    for (const dir of dirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  }

  touchLastOpened(id: string): void {
    const existing = this.get(id);
    if (!existing) return;
    const updated: WorkspaceMetadata = { ...existing, lastOpenedAt: new Date().toISOString() };
    this.writeMetadata(id, updated);
  }

  sessionsDir(workspaceId: string): string {
    return path.join(this.baseDir, "sessions", workspaceId);
  }

  dataDir(workspaceId: string): string {
    return path.join(this.baseDir, "data", workspaceId);
  }

  channelsDir(workspaceId: string, channelId = "default", conversationId = "default"): string {
    return path.join(this.baseDir, "channels", workspaceId, channelId, conversationId);
  }

  transcriptsDir(workspaceId: string, channelId = "default", conversationId = "default"): string {
    return path.join(this.baseDir, "transcripts", workspaceId, channelId, conversationId);
  }

  private metadataPath(id: string): string {
    return path.join(this.baseDir, "workspaces", id, "workspace.json");
  }

  private readMetadata(id: string): WorkspaceMetadata {
    return JSON.parse(fs.readFileSync(this.metadataPath(id), "utf8")) as WorkspaceMetadata;
  }

  private writeMetadata(id: string, metadata: WorkspaceMetadata): void {
    const filePath = this.metadataPath(id);
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpFile = filePath + ".tmp";
    fs.writeFileSync(tmpFile, JSON.stringify(metadata, null, 2) + os.EOL);
    fs.renameSync(tmpFile, filePath);
  }
}
