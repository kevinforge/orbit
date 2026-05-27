import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

export type WorkspaceInfo = {
  id: string;
  name: string;
  path: string;
};

type WorkspaceMetadata = WorkspaceInfo;

export class WorkspaceStore {
  private readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? path.join(os.homedir(), ".orbit", "workspaces");
  }

  static deriveId(cwd: string): string {
    const normalized = path.resolve(cwd).toLowerCase();
    return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 12);
  }

  resolve(cwd: string): WorkspaceInfo {
    const id = WorkspaceStore.deriveId(cwd);
    const metadataPath = path.join(this.baseDir, id, "workspace.json");

    try {
      const data = fs.readFileSync(metadataPath, "utf8");
      return JSON.parse(data) as WorkspaceMetadata;
    } catch {
      const name = path.basename(cwd);
      const workspace: WorkspaceInfo = { id, name, path: cwd };
      const dir = path.dirname(metadataPath);
      fs.mkdirSync(dir, { recursive: true });
      const tmpFile = metadataPath + ".tmp";
      fs.writeFileSync(tmpFile, JSON.stringify(workspace, null, 2) + os.EOL);
      fs.renameSync(tmpFile, metadataPath);
      return workspace;
    }
  }

  sessionsDir(workspaceId: string): string {
    return path.join(this.baseDir, workspaceId, "sessions");
  }
}
