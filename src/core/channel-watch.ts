import { hasActiveChannelWatchTriggers, type AgentId, type AgentProfile, type ChatMessage, type ChannelWatchTriggers } from "../shared/types.ts";
import { assignmentPattern } from "./mention-router.ts";
import type { EventBus } from "./event-bus.ts";
import type { AgentRegistry } from "./agent-registry.ts";
import type { RunManager } from "./run-manager.ts";
import type { MessageStore } from "./message-store.ts";

const MAX_TRIGGERS_PER_CONVERSATION = 5;
const DEBOUNCE_MS = 2_000;
const MAX_ROUTE_DEPTH = 10;

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
  private readonly knownIds: Set<string>;
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
    this.knownIds = new Set(profiles.map((p) => p.id));
    this.knownIds.add("user"); // @user: is the task-closure signal
    this.knownIds.add("all");  // @all: is the broadcast signal

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
        this.onAgentCompleted(event.agentId as AgentId, (event as { resultMessageId: string }).resultMessageId);
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
      const hasAssignment = hasAssignmentMarker(message.content, this.knownIds);
      for (const ctx of this.triggerContexts.values()) {
        ctx.triggerCount = 0;
        if (!hasAssignment && ctx.triggers.onUnassignedMessage) {
          this.tryTrigger(ctx, message);
        }
      }
    }
  }

  private onMessageUpdated(message: ChatMessage): void {
    // Listen for routeState transitions to "blocked" (published via message.updated)
    if (message.routeState === "blocked") {
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

    if (hasAssignmentMarker(message.content, this.knownIds)) return;

    for (const ctx of this.triggerContexts.values()) {
      if (ctx.agentId === agentId) continue;
      if (ctx.triggers.onUnassignedMessage) {
        this.tryTrigger(ctx, message);
      }
    }
  }

  private tryTrigger(ctx: TriggerContext, sourceMessage: ChatMessage): void {
    // Honour the same route-depth limit as MessageRouter
    const nextDepth = (sourceMessage.routeDepth ?? 0) + 1;
    if (nextDepth > MAX_ROUTE_DEPTH) return;

    if (!this.isChannelTrulyIdle(ctx.agentId)) return;

    if (!this.agentRegistry.has(ctx.agentId)) return;
    const supervisorSession = this.agentRegistry.get(ctx.agentId);
    if (supervisorSession.getStatus() !== "idle") return;

    const now = Date.now();
    if (now - ctx.lastEnqueueTime < ctx.debounceMs) return;

    if (ctx.triggerCount >= ctx.maxTriggers) return;

    ctx.triggerCount += 1;
    ctx.lastEnqueueTime = now;

    const isLast = ctx.triggerCount >= ctx.maxTriggers;
    const prompt = buildSupervisorPrompt(ctx.agentId, ctx.triggerCount, isLast, ctx.maxTriggers);

    const syntheticSource: ChatMessage = {
      id: `trigger_${ctx.agentId}_${Date.now()}_${ctx.triggerCount}`,
      kind: "system",
      content: prompt,
      createdAt: new Date().toISOString(),
    };

    this.runManager.enqueue(ctx.agentId, prompt, syntheticSource);
  }
}

function hasAssignmentMarker(content: string, knownIds: ReadonlySet<string>): boolean {
  const pattern = new RegExp(assignmentPattern.source, "g");
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(content)) !== null) {
    if (knownIds.has(m[1])) return true;
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
    `If the overall task needs more work, assign tasks using @agent: markers. ` +
    `If all work is complete, conclude with @user: and a final summary.`
  );
}

export { MAX_TRIGGERS_PER_CONVERSATION, DEBOUNCE_MS };
