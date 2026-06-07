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
  child: {
    kill: () => void;
    pid: number;
    interrupt: () => void;
  };
};

export class AgentSession {
  private status: AgentStatus = "stopped";
  private activeRun: ActiveRun | null = null;
  private runCount = 0;

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

  send(runId: string, prompt: string, imagePaths?: string[]): Promise<RunResult> {
    if (this.activeRun) {
      return Promise.reject(new Error(`${this.id} is already running`));
    }

    this.runCount += 1;
    const runIndex = this.runCount;
    this.setStatus("running");

    const existingSession = this.options.sessionStore.load(
      this.options.runtime.kind, this.options.conversationId, this.id,
    );

    return this.executeRun(runId, prompt, runIndex, existingSession?.sessionId ?? undefined, imagePaths)
      .catch((error: unknown) => {
        if (this.isResumeFailure(error, existingSession)) {
          this.options.sessionStore.clear(
            this.options.runtime.kind, this.options.conversationId, this.id,
          );
          return this.executeRun(runId, prompt, runIndex, undefined, imagePaths);
        }

        throw error;
      });
  }

  stop(): void {
    if (this.activeRun) {
      // Terminate entire process tree (same behavior as interrupt)
      this.activeRun.child.interrupt();
      this.activeRun = null;
    }

    this.setStatus("stopped");
  }

  /** Hard interrupt: terminate the entire process tree for the running agent. */
  interrupt(runId: string): boolean {
    if (!this.activeRun || this.activeRun.runId !== runId) {
      return false;
    }

    // Terminate entire process tree
    this.activeRun.child.interrupt();
    this.activeRun = null;
    this.setStatus("idle");

    // Note: We intentionally do NOT clear the session here.
    // The CLI's --resume parameter restores the entire conversation context,
    // not just the interrupted operation. Users interrupt to stop the current
    // operation, but should be able to continue the conversation afterward.

    return true;
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

  private executeRun(runId: string, prompt: string, runIndex: number, resumeSessionId?: string, imagePaths?: string[]): Promise<RunResult> {
    this.setStatus("running");

    const handle = this.options.runtime.run({
      agentId: this.id,
      cwd: this.options.cwd,
      prompt,
      permissionProfile: this.options.permissionProfile,
      resumeSessionId,
      imagePaths,
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
          throw new Error(
            "Agent response was rejected by the final-answer safety guard. " +
            `First 200 chars: "${cleaned.slice(0, 200)}"`,
          );
        }
        return { content: cleaned, sessionId: sessionId ?? undefined, runIndex };
      })
      .catch(async (error: unknown) => {
        // Even on failure, save the sessionId if one was generated.
        // This allows the conversation to continue after errors (e.g., rate limits).
        const sessionId = await handle.sessionId;
        if (sessionId) {
          this.persistSession(sessionId);
        }

        this.activeRun = null;

        // CRITICAL: Check if status is already "idle" (set by interrupt()).
        // If so, this rejection was caused by interrupt, not a real error.
        // Do NOT overwrite the idle status in this case.
        if (this.status !== "idle") {
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
