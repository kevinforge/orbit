import type {
  AgentId,
  AgentPermissionRequest,
  AgentStatus,
  ApprovalMode,
  PendingPermission,
  PermissionDecision,
  RunResult,
} from "../shared/types.ts";
import type { AgentRuntime } from "./agent-runtime.ts";
import { sanitizeAgentVisibleReply } from "./agent-prompt.ts";
import { isCleanFinalAnswer } from "./claude-output-detector.ts";
import { EventBus } from "./event-bus.ts";
import type { SessionRecord, SessionStore } from "./session-store.ts";

export type AgentSessionOptions = {
  id: AgentId;
  label: string;
  cwd: string;
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

type PendingPermissionState = {
  permission: PendingPermission;
  resolve: (decision: PermissionDecision) => void;
};

export class AgentSession {
  private status: AgentStatus = "stopped";
  private activeRun: ActiveRun | null = null;
  private pendingPermission: PendingPermissionState | null = null;
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

  send(runId: string, prompt: string, imagePaths?: string[], approvalMode: ApprovalMode = "ask"): Promise<RunResult> {
    if (this.activeRun) {
      return Promise.reject(new Error(`${this.id} is already running`));
    }

    this.runCount += 1;
    const runIndex = this.runCount;
    this.setStatus("running");

    const existingSession = this.options.sessionStore.load(
      this.options.runtime.kind, this.options.conversationId, this.id,
    );

    return this.executeRun(runId, prompt, runIndex, existingSession?.sessionId ?? undefined, imagePaths, approvalMode)
      .catch((error: unknown) => {
        if (this.isResumeFailure(error, existingSession)) {
          this.options.sessionStore.clear(
            this.options.runtime.kind, this.options.conversationId, this.id,
          );
          return this.executeRun(runId, prompt, runIndex, undefined, imagePaths, approvalMode);
        }

        throw error;
      });
  }

  stop(): void {
    if (this.activeRun) {
      this.settlePendingPermission(this.activeRun.runId, "reject");
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

    this.settlePendingPermission(runId, "reject");
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

  pendingPermissions(): PendingPermission[] {
    return this.pendingPermission ? [this.pendingPermission.permission] : [];
  }

  resolvePermission(requestId: string, decision: PermissionDecision): boolean {
    const pending = this.pendingPermission;
    if (!pending || pending.permission.id !== requestId) {
      return false;
    }
    this.settlePendingPermission(pending.permission.runId, decision);
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

  private executeRun(
    runId: string,
    prompt: string,
    runIndex: number,
    resumeSessionId?: string,
    imagePaths?: string[],
    approvalMode: ApprovalMode = "ask",
  ): Promise<RunResult> {
    this.setStatus("running");

    const handle = this.options.runtime.run({
      agentId: this.id,
      cwd: this.options.cwd,
      prompt,
      approvalMode,
      resumeSessionId,
      imagePaths,
      requestPermission: (request) => this.requestPermission(runId, request),
      onOutput: (text) => {
        this.options.eventBus.publish({
          type: "terminal.chunk",
          conversationId: this.options.conversationId,
          agentId: this.id,
          runId,
          text,
        });
      },
      onActivity: (activity) => {
        this.options.eventBus.publish({
          type: "run.activity",
          conversationId: this.options.conversationId,
          agentId: this.id,
          runId,
          activity,
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

        this.settlePendingPermission(runId, "reject");
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

        this.settlePendingPermission(runId, "reject");
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

  private requestPermission(runId: string, request: AgentPermissionRequest): Promise<PermissionDecision> {
    if (this.activeRun?.runId !== runId || this.pendingPermission) {
      return Promise.resolve("reject");
    }

    const permission: PendingPermission = {
      ...request,
      id: `${runId}:${request.id}`,
      conversationId: this.options.conversationId,
      agentId: this.id,
      runId,
      createdAt: new Date().toISOString(),
    };

    return new Promise((resolve) => {
      this.pendingPermission = { permission, resolve };
      this.options.eventBus.publish({
        type: "permission.requested",
        conversationId: this.options.conversationId,
        permission,
      });
      this.options.eventBus.publish({
        type: "run.activity",
        conversationId: this.options.conversationId,
        agentId: this.id,
        runId,
        activity: {
          type: "status",
          text: `等待审批：${request.title}`,
          timestamp: permission.createdAt,
        },
      });
    });
  }

  private settlePendingPermission(runId: string, decision: PermissionDecision): void {
    const pending = this.pendingPermission;
    if (!pending || pending.permission.runId !== runId) {
      return;
    }

    this.pendingPermission = null;
    pending.resolve(decision);
    this.options.eventBus.publish({
      type: "permission.resolved",
      conversationId: this.options.conversationId,
      requestId: pending.permission.id,
    });
    this.options.eventBus.publish({
      type: "run.activity",
      conversationId: this.options.conversationId,
      agentId: this.id,
      runId,
      activity: {
        type: "status",
        text: decision === "allow" ? "操作已批准，继续执行。" : "操作已拒绝。",
        timestamp: new Date().toISOString(),
      },
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
      ...(this.options.runtime.transport ? { transport: this.options.runtime.transport } : {}),
      ...(this.options.runtime.protocolVersion
        ? { protocolVersion: this.options.runtime.protocolVersion }
        : {}),
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
