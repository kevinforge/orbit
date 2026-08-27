import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AgentId, AgentModelStateSnapshot } from "../shared/types.ts";

/**
 * 员工模型快照的 workspace 级存储（issue #142）。runtime 每次新建/恢复会话
 * 返回的模型列表与当前值由服务端运行时写入这里；员工的模型偏好存放在
 * agents.json，两者分离，避免整表 PUT /api/agents 覆盖运行时探测结果。
 *
 * 写入采用与 agents.json 相同的临时文件 + 原子替换。
 */
export class AgentModelStateStore {
  private readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? path.join(os.homedir(), ".orbit");
  }

  load(workspaceId: string): Record<AgentId, AgentModelStateSnapshot> {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath(workspaceId), "utf8")) as {
        states?: Record<string, AgentModelStateSnapshot>;
      };
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const states = parsed.states;
      if (!states || typeof states !== "object" || Array.isArray(states)) return {};
      const result: Record<AgentId, AgentModelStateSnapshot> = {};
      for (const [agentId, snapshot] of Object.entries(states)) {
        if (snapshot && typeof snapshot === "object" && typeof agentId === "string") {
          result[agentId] = snapshot;
        }
      }
      return result;
    } catch {
      return {};
    }
  }

  get(workspaceId: string, agentId: AgentId): AgentModelStateSnapshot | undefined {
    return this.load(workspaceId)[agentId];
  }

  /** 单员工键级更新：读取现有表、替换该键后整体原子写回。 */
  update(workspaceId: string, snapshot: AgentModelStateSnapshot): void {
    const states = this.load(workspaceId);
    states[snapshot.agentId] = snapshot;
    const filePath = this.statePath(workspaceId);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpFile = `${filePath}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify({ states }, null, 2) + os.EOL);
    fs.renameSync(tmpFile, filePath);
  }

  private statePath(workspaceId: string): string {
    return path.join(this.baseDir, "workspaces", workspaceId, "agent-model-state.json");
  }
}
