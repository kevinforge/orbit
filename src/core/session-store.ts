import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AgentRuntimeKind } from "../shared/types.ts";

export type SessionRecord = {
  agentId: string;
  channelId: string;
  runtime: AgentRuntimeKind;
  sessionId: string;
  lastRunAt: string;
  runCount: number;
};

export class SessionStore {
  private readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? path.join(process.cwd(), ".orbit", "sessions");
  }

  load(runtime: AgentRuntimeKind, channelId: string, conversationId: string, agentId: string): SessionRecord | null {
    const filePath = this.filePath(runtime, channelId, conversationId, agentId);
    try {
      const data = fs.readFileSync(filePath, "utf8");
      return JSON.parse(data) as SessionRecord;
    } catch {
      return null;
    }
  }

  save(runtime: AgentRuntimeKind, channelId: string, conversationId: string, agentId: string, record: SessionRecord): void {
    const filePath = this.filePath(runtime, channelId, conversationId, agentId);
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });

    const tmpFile = filePath + ".tmp";
    fs.writeFileSync(tmpFile, JSON.stringify(record, null, 2) + os.EOL);
    fs.renameSync(tmpFile, filePath);
  }

  clear(runtime: AgentRuntimeKind, channelId: string, conversationId: string, agentId: string): void {
    const filePath = this.filePath(runtime, channelId, conversationId, agentId);
    try {
      fs.unlinkSync(filePath);
    } catch {
      // already gone
    }
  }

  private filePath(runtime: AgentRuntimeKind, channelId: string, conversationId: string, agentId: string): string {
    return path.join(this.baseDir, runtime, channelId, conversationId, `${agentId}.json`);
  }
}
