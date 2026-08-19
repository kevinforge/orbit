import { hasActiveChannelWatchTriggers, type AgentId, type AgentProfile, type ChatMessage, type ChannelWatchTriggers, type InteractionMode } from "../shared/types.ts";
import { assignmentPattern } from "./mention-router.ts";
import type { EventBus } from "./event-bus.ts";
import type { AgentRegistry } from "./agent-registry.ts";
import type { RunManager } from "./run-manager.ts";
import type { MessageStore } from "./message-store.ts";

const MAX_TRIGGERS_PER_CONVERSATION = 5;
const DEBOUNCE_MS = 2_000;

type TriggerContext = {
  agentId: AgentId;
  triggers: ChannelWatchTriggers;
  triggerCount: number;
  lastEnqueueTime: number;
  maxTriggers: number;
  debounceMs: number;
};

export class ChannelWatchService {
  private readonly triggerContexts: Map<AgentId, TriggerContext> = new Map();
  private readonly knownNames: Set<string>;
  private readonly unsubscribe: () => void;
  private disposed = false;

  constructor(
    private readonly conversationId: string,
    private readonly agentRegistry: AgentRegistry,
    private readonly runManager: RunManager,
    private readonly messages: MessageStore,
    eventBus: EventBus,
    profiles: readonly AgentProfile[],
  ) {
    this.knownNames = new Set(profiles.map((p) => p.name.toLocaleLowerCase()));
    this.knownNames.add("user"); // @user: is the task-closure signal

    for (const profile of profiles) {
      if (profile.triggers && hasActiveChannelWatchTriggers(profile.triggers)) {
        this.triggerContexts.set(profile.id, {
          agentId: profile.id,
          triggers: profile.triggers,
          triggerCount: 0,
          lastEnqueueTime: 0,
          maxTriggers: profile.triggers.maxTriggersPerConversation ?? MAX_TRIGGERS_PER_CONVERSATION,
          debounceMs: profile.triggers.debounceMs ?? DEBOUNCE_MS,
        });
      }
    }

    if (this.triggerContexts.size === 0) {
      this.unsubscribe = () => {};
      return;
    }

    this.unsubscribe = eventBus.subscribe((event) => {
      if (this.disposed) return;
      if ("conversationId" in event && event.conversationId !== this.conversationId) return;

      if (event.type === "message.created") {
        this.onMessageCreated(event.message);
      } else if (event.type === "message.updated") {
        this.onMessageUpdated(event.message);
      } else if (event.type === "run.completed" && "agentId" in event) {
        const completedEvent = event as { agentId: AgentId; resultMessageId: string; suppressFollowupRouting?: boolean };
        if (!completedEvent.suppressFollowupRouting) {
          this.onAgentCompleted(completedEvent.agentId, completedEvent.resultMessageId);
        }
      } else if (event.type === "run.failed" && "agentId" in event) {
        // Issue #82: Trigger supervisor when an agent run fails
        const failedEvent = event as { agentId: AgentId; runId: string; error?: string; interactionMode?: InteractionMode };
        this.onAgentFailed(failedEvent.agentId, failedEvent.runId, failedEvent.error, failedEvent.interactionMode);
      }
    });
  }

  // Design note: this method lives on ChannelWatchService rather than RunManager
  // because it needs AgentRegistry to query per-agent run status — moving it to
  // RunManager would require expanding AgentRunner's interface with status query
  // methods, which would bloat that abstraction unnecessarily. The query is
  // read-only and does not introduce circular dependencies.
  isChannelTrulyIdle(supervisorId: AgentId): boolean {
    for (const agentId of this.agentRegistry.ids()) {
      if (agentId === supervisorId) continue;
      const session = this.agentRegistry.get(agentId);
      if (session.getStatus() !== "idle") return false;
    }
    return !this.runManager.hasQueuedRuns();
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    this.triggerContexts.clear();
  }

  private onMessageCreated(message: ChatMessage): void {
    if (message.kind === "user") {
      const hasAssignment = hasAssignmentMarker(message.content, this.knownNames);
      for (const ctx of this.triggerContexts.values()) {
        // 每条用户消息重置限流计数（无论模式），但只有复杂协作链的消息才触发监工。
        ctx.triggerCount = 0;
        if (!hasAssignment && ctx.triggers.onUnassignedMessage && isSupervisedSnapshot(message.interactionMode)) {
          // 通道非空闲（其他数字员工正在工作）时不触发监工：当前任务完成后
          // onAgentCompleted 会自动触发监工，监工通过 buildHistoryForAgent 看到
          // 用户消息并评估。通道空闲时仍传 relaxIdleCheck: true，以保留用户消息
          // 恢复 error 状态监工的语义（issue #82）。
          if (!this.isChannelTrulyIdle(ctx.agentId)) continue;
          this.tryTrigger(ctx, message, { relaxIdleCheck: true });
        }
      }
    }
  }

  private onMessageUpdated(message: ChatMessage): void {
    // Listen for routeState transitions to "blocked" (published via message.updated)
    if (message.routeState === "blocked") {
      // 只有复杂协作链的阻塞才需要监工介入；普通/简单协作的阻塞是面向用户的提示。
      if (!isSupervisedSnapshot(message.interactionMode)) return;
      for (const ctx of this.triggerContexts.values()) {
        if (ctx.triggers.onAgentBlocked) {
          this.tryTrigger(ctx, message);
        }
      }
    }
  }

  private onAgentCompleted(agentId: AgentId, resultMessageId: string): void {
    const message = this.messages.get(resultMessageId);
    if (!message) return;

    // 只有复杂协作链的完成才触发监工检查；链的模式快照不随全局模式切换改变。
    if (!isSupervisedSnapshot(message.interactionMode)) return;

    // Check for assignment markers, but exclude @user: for non-supervisor agents.
    // @user: is only a closure signal when the SUPERVISOR says it, not when other agents do.
    // Other agents might mention @user: in their responses (e.g., "I'll let @user: know"),
    // which should NOT suppress supervisor triggers.
    // The internal supervisor is identified by its reserved runtime ID.
    const hasAssignment = hasAssignmentMarkerExcludingUserForNonSupervisor(
      message.content,
      this.knownNames,
      agentId === "supervisor",
    );
    if (hasAssignment) return;

    for (const ctx of this.triggerContexts.values()) {
      if (ctx.agentId === agentId) continue;
      if (ctx.triggers.onUnassignedMessage) {
        this.tryTrigger(ctx, message);
      }
    }
  }

  /**
   * Issue #82: Handle agent run failure.
   * When an agent run fails, trigger supervisor if configured with onRunFailed.
   * 只有复杂协作链的失败才会触发监工做恢复。
   */
  private onAgentFailed(agentId: AgentId, runId: string, error?: string, interactionMode?: InteractionMode): void {
    // Find supervisors that have onRunFailed trigger configured
    for (const ctx of this.triggerContexts.values()) {
      if (ctx.agentId === agentId) continue; // Don't trigger the failed agent itself
      if (!ctx.triggers.onRunFailed) continue; // Only trigger if onRunFailed is configured

      const failedMessage = this.messages.list().find(
        (message) => message.kind === "agent" && message.agentId === agentId && message.runId === runId,
      );
      // 链模式快照优先取失败消息记录；事件负载作为兜底。
      const chainMode = failedMessage?.interactionMode ?? interactionMode;
      if (!isSupervisedSnapshot(chainMode)) continue;

      const triggerMessage: ChatMessage = failedMessage ?? {
        id: `failure_${agentId}_${runId}_${Date.now()}`,
        kind: "system",
        content: `[Agent ${agentId} failed]\nRun ${runId} encountered an error: ${error ?? "Unknown error"}`,
        createdAt: new Date().toISOString(),
        status: "error",
        interactionMode: "supervised",
      };

      // Trigger supervisor with relaxIdleCheck=true so it can run even when other agents are busy
      // (the failed agent might still be in error state)
      this.tryTrigger(ctx, triggerMessage, { relaxIdleCheck: true });
    }
  }

  private tryTrigger(ctx: TriggerContext, sourceMessage: ChatMessage, options?: { relaxIdleCheck?: boolean }): void {
    // Note: the completing message's route depth is deliberately NOT used to
    // gate this trigger. A supervisor run resets to a low route depth on enqueue
    // (see RunManager.enqueue) and is rate-limited by maxTriggers + debounce, so
    // gating on the source depth would only block the wrap-up check exactly when
    // a deepest-level delegation finishes and most needs concluding.

    if (!options?.relaxIdleCheck) {
      if (!this.isChannelTrulyIdle(ctx.agentId)) return;
    }

    if (!this.agentRegistry.has(ctx.agentId)) return;
    const supervisorSession = this.agentRegistry.get(ctx.agentId);

    if (options?.relaxIdleCheck) {
      // User-originated: allow queuing even when busy or recovering from a
      // previous runtime error. AgentSession.send() can move an error-state
      // session back to running as long as no process is active.
      const status = supervisorSession.getStatus();
      if (status === "stopped") return;
    } else {
      // Agent-completion triggered: supervisor must be idle
      if (supervisorSession.getStatus() !== "idle") return;
    }

    const now = Date.now();
    if (now - ctx.lastEnqueueTime < ctx.debounceMs) return;

    if (ctx.triggerCount >= ctx.maxTriggers) return;

    ctx.triggerCount += 1;
    ctx.lastEnqueueTime = now;

    const isLast = ctx.triggerCount >= ctx.maxTriggers;
    const prompt = buildSupervisorPrompt(ctx.agentId, ctx.triggerCount, isLast, ctx.maxTriggers);

    this.runManager.enqueue(ctx.agentId, prompt, sourceMessage, "supervisor");
  }
}

/** 只有模式快照为 supervised 的链才触发监工；其他模式（含缺失快照）一律不触发。 */
function isSupervisedSnapshot(mode: InteractionMode | undefined): boolean {
  return mode === "supervised";
}

function hasAssignmentMarker(content: string, knownNames: ReadonlySet<string>): boolean {
  const pattern = new RegExp(assignmentPattern.source, "g");
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(content)) !== null) {
    if (knownNames.has(m[1].toLocaleLowerCase())) return true;
  }
  return false;
}

/**
 * Check for assignment markers, but exclude @user: for non-supervisor agents.
 *
 * When a regular digital employee includes @user: in its response, that is not
 * a closure signal and must not suppress the supervisor follow-up.
 *
 * @param content - Message content to check
 * @param knownNames - Set of known employee names
 * @param fromSupervisor - Whether the sender is the internal supervisor
 * @returns true if there's an assignment marker that should suppress triggers
 */
function hasAssignmentMarkerExcludingUserForNonSupervisor(
  content: string,
  knownNames: ReadonlySet<string>,
  fromSupervisor: boolean,
): boolean {
  const pattern = new RegExp(assignmentPattern.source, "g");
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(content)) !== null) {
    const mentionedName = m[1];
    if (mentionedName.toLocaleLowerCase() === "user" && !fromSupervisor) {
      continue;
    }
    if (knownNames.has(mentionedName.toLocaleLowerCase())) return true;
  }
  return false;
}

function buildSupervisorPrompt(agentId: AgentId, count: number, isLast: boolean, maxTriggers: number): string {
  if (isLast) {
    return (
      `[Supervisor Check #${count}/${maxTriggers} — FINAL]\n\n` +
      `This is your last automatic check for this conversation. ` +
      `If work was already assigned and is in progress, acknowledge it. ` +
      `If the overall task is done, conclude with @user: and a final summary. ` +
      `Do NOT assign new work — this is the final check.`
    );
  }

  return (
    `[Supervisor Check #${count}/${maxTriggers}]\n\n` +
    `Evaluate the current state of the conversation. ` +
    `If the overall task needs more work, assign tasks using an exact name from the available employees, such as @employee-name: . ` +
    `If all work is complete, conclude with @user: and a final summary.`
  );
}

export { MAX_TRIGGERS_PER_CONVERSATION, DEBOUNCE_MS };
