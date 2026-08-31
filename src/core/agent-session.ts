import type {
  AgentElicitationRequest,
  AgentId,
  AgentModelStateSnapshot,
  AgentPermissionRequest,
  AgentStatus,
  ApprovalMode,
  ElicitationResponse,
  MessageAttachment,
  PendingElicitation,
  PendingPermission,
  PermissionDecision,
  RunResult,
  RuntimeEvent,
} from "../shared/types.ts";
import { isAgentRunCancelledError, type AgentRuntime } from "./agent-runtime.ts";
import { sanitizeAgentVisibleReply } from "./agent-prompt.ts";
import { isCleanFinalAnswer } from "./claude-output-detector.ts";
import { EventBus } from "./event-bus.ts";
import type { SessionRecord, SessionStore } from "./session-store.ts";

/**
 * 模型快照桥（issue #142）：运行开始前读最近快照（池复用捷径补发偏好用），
 * runtime 返回或切换模型后回写。由服务层提供，写穿到 workspace 级存储。
 */
export type AgentModelStateBridge = {
  load(agentId: AgentId): AgentModelStateSnapshot | undefined;
  update(snapshot: AgentModelStateSnapshot): void;
};

export type AgentSessionOptions = {
  id: AgentId;
  label: string;
  cwd: string;
  runtime: AgentRuntime;
  eventBus: EventBus;
  quietWindowMs?: number;
  sessionStore: SessionStore;
  conversationId: string;
  /** Workspace scope for events; optional for standalone unit-test callers. */
  workspaceId?: string;
  interactionTimeoutMs?: number;
  preferredModelId?: string;
  modelState?: AgentModelStateBridge;
};

type ActiveRun = {
  runId: string;
  cancellationRequested?: boolean;
  child: {
    kill: () => void;
    pid: number;
    interrupt: () => void;
  };
};

type PendingPermissionState = {
  permission: PendingPermission;
  resolve: (decision: PermissionDecision) => void;
  timer: NodeJS.Timeout;
};

type PendingElicitationState = {
  elicitation: PendingElicitation;
  resolve: (response: ElicitationResponse) => void;
  timer: NodeJS.Timeout;
};

const DEFAULT_INTERACTION_TIMEOUT_MS = 30 * 60 * 1000;

export class AgentSession {
  private status: AgentStatus = "stopped";
  private activeRun: ActiveRun | null = null;
  private readonly pendingPermissionStates = new Map<string, PendingPermissionState>();
  private readonly pendingElicitationStates = new Map<string, PendingElicitationState>();
  private elicitationCount = 0;
  private runCount = 0;
  /** 首选模型可在会话运行期间更新（issue #153），下一次运行开始时生效。 */
  private preferredModelId?: string;

  constructor(private readonly options: AgentSessionOptions) {
    this.preferredModelId = options.preferredModelId;
  }

  /**
   * 更新首选模型。只改内存中的偏好，不重启会话、不中断当前运行：
   * 偏好在每次运行开始时惰性应用，因此新值从下一次运行开始生效。
   */
  setPreferredModelId(preferredModelId?: string): void {
    this.preferredModelId = preferredModelId?.trim() || undefined;
  }

  preferredModel(): string | undefined {
    return this.preferredModelId;
  }

  private publish(event: RuntimeEvent): void {
    this.options.eventBus.publish(
      this.options.workspaceId && "conversationId" in event
        ? { ...event, workspaceId: this.options.workspaceId }
        : event,
    );
  }

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

  send(runId: string, prompt: string, attachments?: readonly MessageAttachment[], approvalMode: ApprovalMode = "ask"): Promise<RunResult> {
    if (this.activeRun) {
      return Promise.reject(new Error(`${this.id} is already running`));
    }

    this.runCount += 1;
    const runIndex = this.runCount;
    this.setStatus("running");

    const existingSession = this.options.sessionStore.load(
      this.options.runtime.kind, this.options.conversationId, this.id,
    );

    return this.executeRun(runId, prompt, runIndex, existingSession?.sessionId ?? undefined, attachments, approvalMode)
      .catch((error: unknown) => {
        if (this.isResumeFailure(error, existingSession)) {
          this.options.sessionStore.clear(
            this.options.runtime.kind, this.options.conversationId, this.id,
          );
          return this.executeRun(runId, prompt, runIndex, undefined, attachments, approvalMode);
        }

        throw error;
      });
  }

  stop(): void {
    if (this.activeRun) {
      this.settlePendingPermissions(this.activeRun.runId, "reject");
      this.settlePendingElicitations(this.activeRun.runId, { action: "cancel" });
      // Terminate entire process tree (same behavior as interrupt)
      this.activeRun.child.interrupt();
      this.activeRun = null;
    }

    this.setStatus("stopped");
  }

  /** Request cancellation and keep the active run until its runtime settles. */
  interrupt(runId: string): boolean {
    if (!this.activeRun || this.activeRun.runId !== runId) {
      return false;
    }

    this.settlePendingPermissions(runId, "reject");
    this.settlePendingElicitations(runId, { action: "cancel" });
    this.activeRun.cancellationRequested = true;
    // ACP runtimes send session/cancel first and only terminate the process
    // tree if the runtime does not settle within its grace period.
    this.activeRun.child.interrupt();

    // Note: We intentionally do NOT clear the session here.
    // The CLI's --resume parameter restores the entire conversation context,
    // not just the interrupted operation. Users interrupt to stop the current
    // operation, but should be able to continue the conversation afterward.

    return true;
  }

  pendingPermissions(): PendingPermission[] {
    return [...this.pendingPermissionStates.values()].map((pending) => pending.permission);
  }

  pendingElicitations(): PendingElicitation[] {
    return [...this.pendingElicitationStates.values()].map((pending) => pending.elicitation);
  }

  resolvePermission(requestId: string, decision: PermissionDecision): boolean {
    const pending = this.pendingPermissionStates.get(requestId);
    if (!pending) return false;
    this.settlePendingPermission(requestId, pending, decision);
    return true;
  }

  resolveElicitation(requestId: string, response: ElicitationResponse): boolean {
    const pending = this.pendingElicitationStates.get(requestId);
    if (!pending) return false;
    this.settlePendingElicitation(requestId, pending, response);
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
    attachments?: readonly MessageAttachment[],
    approvalMode: ApprovalMode = "ask",
  ): Promise<RunResult> {
    this.setStatus("running");

    const handle = this.options.runtime.run({
      agentId: this.id,
      poolKey: `${this.options.conversationId}:${this.id}`,
      cwd: this.options.cwd,
      prompt,
      approvalMode,
      resumeSessionId,
      attachments,
      // 模型偏好（issue #142）：每次运行开始时读最近快照并惰性应用。
      // 读可变字段而非 options，使运行期更新的偏好在下一次运行生效（issue #153）。
      preferredModelId: this.preferredModelId,
      lastSessionConfig: this.options.modelState?.load(this.id),
      onSessionConfig: this.options.modelState
        ? (snapshot) => this.options.modelState!.update(snapshot)
        : undefined,
      requestPermission: (request) => this.requestPermission(runId, request),
      requestElicitation: (request) => this.requestElicitation(runId, request),
      onOutput: (text) => {
        this.publish({
          type: "terminal.chunk",
          conversationId: this.options.conversationId,
          agentId: this.id,
          runId,
          text,
        });
      },
      onActivity: (activity) => {
        this.publish({
          type: "runtime.activity",
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
        this.publish({
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

        this.settlePendingPermissions(runId, "reject");
        this.settlePendingElicitations(runId, { action: "cancel" });
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

        this.settlePendingPermissions(runId, "reject");
        this.settlePendingElicitations(runId, { action: "cancel" });
        const cancellationRequested = this.activeRun?.runId === runId && this.activeRun.cancellationRequested === true;
        this.activeRun = null;

        // ACP reports a rejected permission as a cancelled turn. Keep the
        // agent available for the next task instead of leaving it in error.
        if (isAgentRunCancelledError(error) || cancellationRequested) {
          this.setStatus("idle");
        } else if (this.status !== "idle") {
          this.setStatus("error");
        }

        throw error;
      });
  }

  private requestPermission(runId: string, request: AgentPermissionRequest): Promise<PermissionDecision> {
    if (this.activeRun?.runId !== runId) {
      return Promise.resolve("reject");
    }

    const createdAt = new Date();
    const timeoutMs = this.interactionTimeoutMs();
    const permission: PendingPermission = {
      ...request,
      id: `${runId}:${request.id}`,
      conversationId: this.options.conversationId,
      agentId: this.id,
      runId,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + timeoutMs).toISOString(),
    };
    if (this.pendingPermissionStates.has(permission.id)) {
      return Promise.resolve("reject");
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const pending = this.pendingPermissionStates.get(permission.id);
        if (!pending) return;
        this.settlePendingPermission(permission.id, pending, "reject", "审批请求已过期，操作未获批准。");
      }, timeoutMs);
      this.pendingPermissionStates.set(permission.id, { permission, resolve, timer });
      this.publish({
        type: "permission.requested",
        conversationId: this.options.conversationId,
        permission,
      });
      this.publish({
        type: "runtime.activity",
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

  private requestElicitation(runId: string, request: AgentElicitationRequest): Promise<ElicitationResponse> {
    if (this.activeRun?.runId !== runId) {
      return Promise.resolve({ action: "cancel" });
    }

    const id = `${runId}:elicitation-${++this.elicitationCount}`;
    const createdAt = new Date();
    const timeoutMs = this.interactionTimeoutMs();
    const elicitation: PendingElicitation = {
      ...request,
      id,
      conversationId: this.options.conversationId,
      agentId: this.id,
      runId,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + timeoutMs).toISOString(),
    };

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const pending = this.pendingElicitationStates.get(id);
        if (!pending) return;
        this.settlePendingElicitation(id, pending, { action: "cancel" }, "用户输入请求已过期。");
      }, timeoutMs);
      this.pendingElicitationStates.set(id, { elicitation, resolve, timer });
      this.publish({
        type: "elicitation.requested",
        conversationId: this.options.conversationId,
        elicitation,
      });
      this.publish({
        type: "runtime.activity",
        conversationId: this.options.conversationId,
        agentId: this.id,
        runId,
        activity: {
          type: "status",
          text: `等待用户输入：${request.message}`,
          timestamp: elicitation.createdAt,
        },
      });
    });
  }

  private settlePendingPermission(
    requestId: string,
    pending: PendingPermissionState,
    decision: PermissionDecision,
    activityText?: string,
  ): void {
    this.pendingPermissionStates.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(decision);
    this.publish({
      type: "permission.resolved",
      conversationId: this.options.conversationId,
      requestId: pending.permission.id,
    });
    this.publish({
      type: "runtime.activity",
      conversationId: this.options.conversationId,
      agentId: this.id,
      runId: pending.permission.runId,
      activity: {
        type: "status",
        text: activityText ?? (decision === "allow" ? "操作已批准，继续执行。" : "操作已拒绝。"),
        timestamp: new Date().toISOString(),
      },
    });
  }

  private settlePendingPermissions(runId: string, decision: PermissionDecision): void {
    for (const [requestId, pending] of this.pendingPermissionStates) {
      if (pending.permission.runId !== runId) continue;
      this.settlePendingPermission(requestId, pending, decision);
    }
  }

  private settlePendingElicitations(runId: string, response: ElicitationResponse): void {
    for (const [requestId, pending] of this.pendingElicitationStates) {
      if (pending.elicitation.runId !== runId) continue;
      this.settlePendingElicitation(requestId, pending, response);
    }
  }

  private settlePendingElicitation(
    requestId: string,
    pending: PendingElicitationState,
    response: ElicitationResponse,
    activityText?: string,
  ): void {
    this.pendingElicitationStates.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(response);
    this.publish({
      type: "elicitation.resolved",
      conversationId: this.options.conversationId,
      requestId,
    });
    if (activityText) {
      this.publish({
        type: "runtime.activity",
        conversationId: this.options.conversationId,
        agentId: this.id,
        runId: pending.elicitation.runId,
        activity: {
          type: "status",
          text: activityText,
          timestamp: new Date().toISOString(),
        },
      });
    }
  }

  private interactionTimeoutMs(): number {
    return Math.max(1, this.options.interactionTimeoutMs ?? DEFAULT_INTERACTION_TIMEOUT_MS);
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
    this.publish({
      type: "agent.status",
      conversationId: this.options.conversationId,
      agentId: this.id,
      status,
    });
  }
}
