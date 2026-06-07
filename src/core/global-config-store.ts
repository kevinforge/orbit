import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { GlobalConfig, GlobalRuntimeConfig } from "../shared/types.ts";
import { DEFAULT_GLOBAL_CONFIG } from "../shared/types.ts";

export type { GlobalConfig };
export { DEFAULT_GLOBAL_CONFIG };

export function resolveGlobalConfig(raw?: GlobalConfig | null): GlobalRuntimeConfig {
  const resolved: GlobalRuntimeConfig = {
    enableRunLogs: raw?.enableRunLogs !== undefined
      ? Boolean(raw.enableRunLogs)
      : DEFAULT_GLOBAL_CONFIG.enableRunLogs,
  };
  return resolved;
}

export class GlobalConfigStore {
  private readonly baseDir: string;
  private readonly configPath: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? path.join(os.homedir(), ".orbit");
    this.configPath = path.join(this.baseDir, "global-config.json");
  }

  load(): GlobalRuntimeConfig {
    try {
      const data = fs.readFileSync(this.configPath, "utf8");
      const raw = JSON.parse(data) as GlobalConfig;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return structuredClone(DEFAULT_GLOBAL_CONFIG);
      }
      return resolveGlobalConfig(raw);
    } catch {
      return structuredClone(DEFAULT_GLOBAL_CONFIG);
    }
  }

  save(config: GlobalConfig): void {
    const dir = path.dirname(this.configPath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpFile = this.configPath + ".tmp";
    fs.writeFileSync(tmpFile, JSON.stringify(config, null, 2) + os.EOL);
    fs.renameSync(tmpFile, this.configPath);
  }
}