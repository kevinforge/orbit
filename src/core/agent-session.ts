import type { AgentId, AgentStatus, PermissionProfile, RunResult } from "../shared/types.ts";
import type { AgentRuntime } from "./agent-runtime.ts";
import { sanitizeAgentVisibleReply } from "./agent-prompt.ts";
import { isCleanFinalAnswer } from "./claude-output-detector.ts";
import { EventBus } from "./event-bus.ts";
import type { SessionRecord, SessionStore } from "./session-store.ts";

export type AgentSessionOptions = {
  id: AgentId;
  label: string;
  cwd: string;
  permissionProfile: PermissionProfile;
  runtime: AgentRuntime;
  eventBus: EventBus;
  quietWindowMs?: number;
  sessionStore: SessionStore;
  conversationId: string;
};

type ActiveRun = {
  runId: string;
  child: { kill: () => unknown };
};

export class AgentSession {
  private status: AgentStatus = "stopped";
  private activeRun: ActiveRun | null = null;
  private runCount = 0;
  private interrupted = false;

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

  send(runId: string, prompt: string): Promise<RunResult> {
    if (this.activeRun) {
      return Promise.reject(new Error(`${this.id} is already running`));
    }

    this.interrupted = false;
    this.runCount += 1;
    const runIndex = this.runCount;
    this.setStatus("running");

    const existingSession = this.options.sessionStore.load(
      this.options.runtime.kind, this.options.conversationId, this.id,
    );

    return this.executeRun(runId, prompt, runIndex, existingSession?.sessionId ?? undefined)
      .catch((error: unknown) => {
        if (this.isResumeFailure(error, existingSession)) {
          this.options.sessionStore.clear(
            this.options.runtime.kind, this.options.conversationId, this.id,
          );
          return this.executeRun(runId, prompt, runIndex, undefined);
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

  interrupt(): void {
    if (!this.activeRun) {
      return;
    }

    this.interrupted = true;
    this.activeRun.child.kill();
    this.activeRun = null;
    this.setStatus("idle");
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
      lower.includes("invalid session") ||
      lower.includes("no conversation found") ||
      (
        lower.includes("failed to deserialize the json body") &&
        lower.includes("messages[") &&
        lower.includes(".role") &&
        lower.includes("unknown variant") &&
        lower.includes("system")
      )
    );
  }

  private executeRun(runId: string, prompt: string, runIndex: number, resumeSessionId?: string): Promise<RunResult> {
    this.setStatus("running");

    const handle = this.options.runtime.run({
      agentId: this.id,
      cwd: this.options.cwd,
      prompt,
      permissionProfile: this.options.permissionProfile,
      resumeSessionId,
      onOutput: (text) => {
        this.options.eventBus.publish({
          type: "terminal.chunk",
          conversationId: this.options.conversationId,
          agentId: this.id,
          runId,
          text,
        });
      },
    });
    this.activeRun = { runId, child: handle.process };

    handle.sessionId.then((sessionId) => {
      if (sessionId && this.activeRun?.runId === runId) {
        this.options.eventBus.publish({
          type: "run.sessionId",
          conversationId: this.options.conversationId,
          agentId: this.id,
          runId,
          sessionId,
        });
      }
    });

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
        return { content: cleaned, sessionId: sessionId ?? undefined, runIndex };
      })
      .catch((error: unknown) => {
        this.activeRun = null;
        if (!this.interrupted) {
          this.setStatus("error");
        }
        throw error;
      });
  }

  private persistSession(sessionId: string): void {
    const prev = this.options.sessionStore.load(
      this.options.runtime.kind, this.options.conversationId, this.id,
    );
    this.options.sessionStore.save(this.options.runtime.kind, this.options.conversationId, this.id, {
      agentId: this.id,
      runtime: this.options.runtime.kind,
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
      conversationId: this.options.conversationId,
      agentId: this.id,
      status,
    });
  }
}
