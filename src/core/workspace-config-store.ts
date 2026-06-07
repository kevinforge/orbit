import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { WorkspaceConfig, WorkspaceRuntimeConfig } from "../shared/types.ts";
import { DEFAULT_WORKSPACE_CONFIG } from "../shared/types.ts";

export type { WorkspaceConfig };
export { DEFAULT_WORKSPACE_CONFIG };

export function resolveWorkspaceConfig(raw?: WorkspaceConfig | null): WorkspaceRuntimeConfig {
  const resolved: WorkspaceRuntimeConfig = {
    systemPrompt: raw?.systemPrompt?.trim() ? raw.systemPrompt.trim() : DEFAULT_WORKSPACE_CONFIG.systemPrompt,
    rules: raw?.rules && Array.isArray(raw.rules)
      ? raw.rules.filter((r) => typeof r === "string" && r.trim()).map((r) => r.trim())
      : DEFAULT_WORKSPACE_CONFIG.rules,
    enableRunLogs: raw?.enableRunLogs !== undefined
      ? Boolean(raw.enableRunLogs)
      : DEFAULT_WORKSPACE_CONFIG.enableRunLogs,
  };
  return resolved;
}

export class WorkspaceConfigStore {
  private readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? path.join(os.homedir(), ".orbit");
  }

  load(workspaceId: string): WorkspaceRuntimeConfig {
    const filePath = this.configPath(workspaceId);
    try {
      const data = fs.readFileSync(filePath, "utf8");
      const raw = JSON.parse(data) as WorkspaceConfig;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return structuredClone(DEFAULT_WORKSPACE_CONFIG);
      }
      return resolveWorkspaceConfig(raw);
    } catch {
      return structuredClone(DEFAULT_WORKSPACE_CONFIG);
    }
  }

  save(workspaceId: string, config: WorkspaceConfig): void {
    const filePath = this.configPath(workspaceId);
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpFile = filePath + ".tmp";
    fs.writeFileSync(tmpFile, JSON.stringify(config, null, 2) + os.EOL);
    fs.renameSync(tmpFile, filePath);
  }

  private configPath(workspaceId: string): string {
    return path.join(this.baseDir, "workspaces", workspaceId, "config.json");
  }
}
