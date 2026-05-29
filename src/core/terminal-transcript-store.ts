import fs from "node:fs";
import path from "node:path";
import { stripAnsi } from "./ansi-text-extractor.ts";
import type { AgentId, TerminalState } from "../shared/types.ts";

export class TerminalTranscriptStore {
  private transcripts: TerminalState = {};
  private readonly dirPath?: string;

  constructor(dirPath?: string) {
    this.dirPath = dirPath;
    if (dirPath) {
      this.load();
    }
  }

  append(agentId: AgentId, chunk: string): string {
    const cleaned = stripAnsi(chunk);
    this.transcripts[agentId] ??= "";
    this.transcripts[agentId] += cleaned;
    this.saveAgentChunk(agentId, cleaned);
    return this.transcripts[agentId];
  }

  get(agentId: AgentId): string {
    return this.transcripts[agentId] ?? "";
  }

  list(): TerminalState {
    return { ...this.transcripts };
  }

  all(): TerminalState {
    return this.list();
  }

  private load(): void {
    try {
      const entries = fs.readdirSync(this.dirPath!);
      for (const entry of entries) {
        if (!entry.endsWith(".log")) continue;
        const agentId = entry.slice(0, -4);
        try {
          this.transcripts[agentId] = fs.readFileSync(path.join(this.dirPath!, entry), "utf8");
        } catch {
          this.transcripts[agentId] = "";
        }
      }
    } catch {
      // directory doesn't exist yet
    }
  }

  private saveAgentChunk(agentId: AgentId, chunk: string): void {
    if (!this.dirPath || chunk.length === 0) return;
    try {
      fs.mkdirSync(this.dirPath, { recursive: true });
      fs.appendFileSync(path.join(this.dirPath, `${agentId}.log`), chunk);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[orbit] failed to persist terminal transcript for ${agentId}: ${message}`);
    }
  }
}
