import type { ChildProcessWithoutNullStreams } from "node:child_process";

import type { AgentId, AgentStatus } from "../shared/types.ts";
import { sanitizeAgentVisibleReply } from "./agent-prompt.ts";
import { runClaudeCli } from "./claude-cli-runtime.ts";
import { isCleanFinalAnswer } from "./claude-output-detector.ts";
import { EventBus } from "./event-bus.ts";
import type { SessionRecord, SessionStore } from "./session-store.ts";

export type AgentSessionOptions = {
  id: AgentId;
  label: string;
  cwd: string;
  eventBus: EventBus;
  quietWindowMs?: number;
  sessionStore: SessionStore;
  channelId: string;
  conversationId: string;
};

type ActiveRun = {
  runId: string;
  child: ChildProcessWithoutNullStreams;
};

export class AgentSession {
  private status: AgentStatus = "stopped";
  private activeRun: ActiveRun | null = null;

  constructor(private readonly options: AgentSessionOptions) {}

  get id(): AgentId {
    return this.options.id;
  }

  get label(): string {
    return this.options.label;
  }

  getStatus(): AgentStatus {
    return this.status;
  }

  start(): void {
    if (this.status === "stopped" || this.status === "starting") {
      this.setStatus("idle");
    }
  }

  send(runId: string, prompt: string): Promise<string> {
    if (this.activeRun) {
      return Promise.reject(new Error(`${this.id} is already running`));
    }

    this.setStatus("running");

    const existingSession = this.options.sessionStore.load(
      this.options.channelId, this.options.conversationId, this.id,
    );

    return this.executeRun(runId, prompt, existingSession?.sessionId ?? undefined)
      .catch((error: unknown) => {
        if (this.isResumeFailure(error, existingSession)) {
          this.options.sessionStore.clear(
            this.options.channelId, this.options.conversationId, this.id,
          );
          return this.executeRun(runId, prompt, undefined);
        }

        throw error;
      });
  }

  stop(): void {
    if (this.activeRun) {
      this.activeRun.child.kill();
      this.activeRun = null;
    }

    this.setStatus("stopped");
  }

  private isResumeFailure(
    error: unknown,
    session: SessionRecord | null,
  ): session is SessionRecord {
    if (!session) return false;

    const message = error instanceof Error ? error.message : String(error);
    const lower = message.toLowerCase();

    return (
      lower.includes("session not found") ||
      lower.includes("session expired") ||
      lower.includes("could not resume") ||
      lower.includes("invalid session")
    );
  }

  private executeRun(runId: string, prompt: string, resumeSessionId?: string): Promise<string> {
    this.setStatus("running");

    const handle = runClaudeCli({
      agentId: this.id,
      cwd: this.options.cwd,
      prompt,
      resumeSessionId,
      onOutput: (text) => {
        this.options.eventBus.publish({
          type: "terminal.chunk",
          agentId: this.id,
          runId,
          text,
        });
      },
    });
    this.activeRun = { runId, child: handle.process };

    return handle.result
      .then(async (result) => {
        const sessionId = await handle.sessionId;
        if (sessionId) {
          this.persistSession(sessionId);
        }

        this.activeRun = null;
        this.setStatus("idle");
        const cleaned = sanitizeAgentVisibleReply(result.trim());
        if (!isCleanFinalAnswer(cleaned)) {
          throw new Error("Agent did not return a clean final answer.");
        }
        return cleaned;
      })
      .catch((error: unknown) => {
        this.activeRun = null;
        this.setStatus("error");
        throw error;
      });
  }

  private persistSession(sessionId: string): void {
    const prev = this.options.sessionStore.load(
      this.options.channelId, this.options.conversationId, this.id,
    );
    this.options.sessionStore.save(this.options.channelId, this.options.conversationId, this.id, {
      agentId: this.id,
      channelId: this.options.channelId,
      sessionId,
      lastRunAt: new Date().toISOString(),
      runCount: (prev?.runCount ?? 0) + 1,
    });
  }

  private setStatus(status: AgentStatus): void {
    if (this.status === status) {
      return;
    }

    this.status = status;
    this.options.eventBus.publish({
      type: "agent.status",
      agentId: this.id,
      status,
    });
  }
}
