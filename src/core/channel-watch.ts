import type { AgentId, AgentProfile, ChatMessage, ChannelWatchTriggers } from "../shared/types.ts";
import type { EventBus } from "./event-bus.ts";
import type { AgentRegistry } from "./agent-registry.ts";
import type { RunManager } from "./run-manager.ts";
import type { MessageStore } from "./message-store.ts";

const ASSIGNMENT_PATTERN = /@([A-Za-z0-9_-]+)\s*(?::|：)/g;
const MAX_TRIGGERS_PER_CONVERSATION = 5;
const DEBOUNCE_MS = 2_000;

type TriggerContext = {
  agentId: AgentId;
  triggers: ChannelWatchTriggers;
  triggerCount: number;
  lastEnqueueTime: number;
};

export class ChannelWatchService {
  private readonly triggerContexts: Map<AgentId, TriggerContext> = new Map();
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
    for (const profile of profiles) {
      if (profile.triggers && hasAnyTrigger(profile.triggers)) {
        this.triggerContexts.set(profile.id, {
          agentId: profile.id,
          triggers: profile.triggers,
          triggerCount: 0,
          lastEnqueueTime: 0,
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
      } else if (event.type === "run.completed" && "agentId" in event) {
        this.onAgentCompleted(event.agentId as AgentId, (event as { resultMessageId: string }).resultMessageId);
      }
    });
  }

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
      for (const ctx of this.triggerContexts.values()) {
        ctx.triggerCount = 0;
      }
    }

    if (message.routeState === "blocked") {
      for (const ctx of this.triggerContexts.values()) {
        if (ctx.triggers.onAgentBlocked) {
          this.tryTrigger(ctx, "blocked", message);
        }
      }
      return;
    }

    if (message.kind === "user" && !hasAssignmentMarker(message.content)) {
      for (const ctx of this.triggerContexts.values()) {
        if (ctx.triggers.onUnassignedMessage) {
          this.tryTrigger(ctx, "unassigned_message", message);
        }
      }
    }
  }

  private onAgentCompleted(agentId: AgentId, resultMessageId: string): void {
    const message = this.messages.get(resultMessageId);
    if (!message) return;

    if (hasAssignmentMarker(message.content)) return;

    for (const ctx of this.triggerContexts.values()) {
      if (ctx.agentId === agentId) continue;
      if (ctx.triggers.onUnassignedMessage) {
        this.tryTrigger(ctx, "agent_completed", message);
      }
    }
  }

  private tryTrigger(ctx: TriggerContext, _reason: string, sourceMessage: ChatMessage): void {
    if (!this.isChannelTrulyIdle(ctx.agentId)) return;

    let supervisorSession;
    try {
      supervisorSession = this.agentRegistry.get(ctx.agentId);
    } catch {
      return;
    }
    if (supervisorSession.getStatus() !== "idle") return;

    const now = Date.now();
    if (now - ctx.lastEnqueueTime < DEBOUNCE_MS) return;

    if (ctx.triggerCount >= MAX_TRIGGERS_PER_CONVERSATION) return;

    ctx.triggerCount += 1;
    ctx.lastEnqueueTime = now;

    const isLast = ctx.triggerCount >= MAX_TRIGGERS_PER_CONVERSATION;
    const prompt = buildSupervisorPrompt(ctx.agentId, ctx.triggerCount, isLast);

    const syntheticSource: ChatMessage = {
      id: `trigger_${ctx.agentId}_${Date.now()}_${ctx.triggerCount}`,
      kind: "system",
      content: prompt,
      createdAt: new Date().toISOString(),
    };

    this.runManager.enqueue(ctx.agentId, prompt, syntheticSource);
  }
}

function hasAnyTrigger(triggers: ChannelWatchTriggers): boolean {
  return triggers.onUnassignedMessage === true || triggers.onAgentBlocked === true;
}

function hasAssignmentMarker(content: string): boolean {
  ASSIGNMENT_PATTERN.lastIndex = 0;
  return ASSIGNMENT_PATTERN.test(content);
}

function buildSupervisorPrompt(agentId: AgentId, count: number, isLast: boolean): string {
  if (isLast) {
    return (
      `[Supervisor Check #${count}/${MAX_TRIGGERS_PER_CONVERSATION} — FINAL]\n\n` +
      `This is your last automatic check for this conversation. ` +
      `If work was already assigned and is in progress, acknowledge it. ` +
      `If the overall task is done, conclude with @user: and a final summary. ` +
      `Do NOT assign new work — this is the final check.`
    );
  }

  return (
    `[Supervisor Check #${count}/${MAX_TRIGGERS_PER_CONVERSATION}]\n\n` +
    `Evaluate the current state of the conversation. ` +
    `If the overall task needs more work, assign tasks using @agent: markers. ` +
    `If all work is complete, conclude with @user: and a final summary.`
  );
}

export { MAX_TRIGGERS_PER_CONVERSATION, DEBOUNCE_MS };
