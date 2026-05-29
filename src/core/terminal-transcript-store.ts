import fs from "node:fs";
import path from "node:path";
import { stripAnsi } from "./ansi-text-extractor.ts";
import type { AgentId, TerminalState } from "../shared/types.ts";

const RETRY_SAVE_DELAY_MS = 50;

export class TerminalTranscriptStore {
  private transcripts: TerminalState = {};
  private handles = new Map<AgentId, number>();
  private persistedLengths = new Map<AgentId, number>();
  private retryTimers = new Map<AgentId, ReturnType<typeof setTimeout>>();
  private warnedAgents = new Set<AgentId>();
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

  dispose(): void {
    for (const timer of this.retryTimers.values()) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();
    for (const agentId of this.handles.keys()) {
      this.closeHandle(agentId);
    }
  }

  private load(): void {
    try {
      const entries = fs.readdirSync(this.dirPath!);
      for (const entry of entries) {
        if (!entry.endsWith(".log")) continue;
        const agentId = entry.slice(0, -4);
        try {
          this.transcripts[agentId] = fs.readFileSync(path.join(this.dirPath!, entry), "utf8");
          this.persistedLengths.set(agentId, this.transcripts[agentId].length);
        } catch {
          this.transcripts[agentId] = "";
          this.persistedLengths.set(agentId, 0);
        }
      }
    } catch {
      // directory doesn't exist yet
    }
  }

  private saveAgentChunk(agentId: AgentId, chunk: string): void {
    if (!this.dirPath || chunk.length === 0) return;
    this.flushAgent(agentId);
  }

  private flushAgent(agentId: AgentId): void {
    if (!this.dirPath) return;
    const transcript = this.transcripts[agentId] ?? "";
    const persistedLength = this.persistedLengths.get(agentId) ?? 0;
    const pending = transcript.slice(persistedLength);
    if (!pending) {
      this.clearRetry(agentId);
      return;
    }
    try {
      const handle = this.openHandle(agentId);
      fs.writeSync(handle, pending);
      this.persistedLengths.set(agentId, transcript.length);
      this.warnedAgents.delete(agentId);
      this.clearRetry(agentId);
    } catch (error) {
      this.closeHandle(agentId);
      this.warnOnce(agentId, error);
      this.scheduleRetry(agentId);
    }
  }

  private openHandle(agentId: AgentId): number {
    const existing = this.handles.get(agentId);
    if (existing !== undefined) return existing;
    if (!this.dirPath) throw new Error("Transcript directory is not configured.");
    fs.mkdirSync(this.dirPath, { recursive: true });
    const handle = fs.openSync(path.join(this.dirPath, `${agentId}.log`), "a");
    this.handles.set(agentId, handle);
    return handle;
  }

  private closeHandle(agentId: AgentId): void {
    const handle = this.handles.get(agentId);
    if (handle === undefined) return;
    this.handles.delete(agentId);
    try {
      fs.closeSync(handle);
    } catch {
      // best effort cleanup after a write failure
    }
  }

  private scheduleRetry(agentId: AgentId): void {
    if (this.retryTimers.has(agentId)) return;
    const timer = setTimeout(() => {
      this.retryTimers.delete(agentId);
      this.flushAgent(agentId);
    }, RETRY_SAVE_DELAY_MS);
    timer.unref?.();
    this.retryTimers.set(agentId, timer);
  }

  private clearRetry(agentId: AgentId): void {
    const timer = this.retryTimers.get(agentId);
    if (!timer) return;
    clearTimeout(timer);
    this.retryTimers.delete(agentId);
  }

  private warnOnce(agentId: AgentId, error: unknown): void {
    if (this.warnedAgents.has(agentId)) return;
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[orbit] failed to persist terminal transcript for ${agentId}: ${message}`);
    this.warnedAgents.add(agentId);
  }
}
