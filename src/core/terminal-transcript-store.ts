import { stripAnsi } from "./ansi-text-extractor.ts";
import type { AgentId, TerminalState } from "../shared/types.ts";

export class TerminalTranscriptStore {
  private transcripts: TerminalState = {};

  append(agentId: AgentId, chunk: string): string {
    this.transcripts[agentId] ??= "";
    this.transcripts[agentId] += stripAnsi(chunk);
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
}
