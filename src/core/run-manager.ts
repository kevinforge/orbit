import type {
  AgentActivityEvent,
  AgentId,
  ApprovalMode,
  ChatMessage,
  InteractionMode,
  MessageAttachment,
  AgentPlanSnapshot,
  PersistedProcessTimelineEntry,
  NewChatMessage,
  RunResult,
  RuntimeEvent,
} from "../shared/types.ts";
import { randomBytes } from "node:crypto";
import type { EventBus } from "./event-bus.ts";
import type { MessageStore } from "./message-store.ts";
import { parseJsonObjects } from "./json-stream-parser.ts";
import { isAgentRunCancelledError } from "./agent-runtime.ts";
import { appendTransientProcessActivity, buildPersistedProcessTimeline, withoutAnswerGroup } from "../shared/process-activity.ts";

const TERMINAL_RUN_RETENTION_MS = 5 * 60 * 1000;
const MAX_TERMINAL_RUN_INDEX_SIZE = 1024;

type AgentRunner = {
  get(agentId: AgentId): {
    send(runId: string, prompt: string, imagePaths?: string[], approvalMode?: ApprovalMode): Promise<RunResult>;
    /** Request runtime cancellation; the runtime may fall back to process termination. */
    interrupt(runId: string): boolean;
  };
};

export type ManagedRunStatus = "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled";

export type RunOrigin = "user" | "agent" | "supervisor";

export type ManagedRun = {
  id: string;
  agentId: AgentId;
  prompt: string;
  sourceMessage: ChatMessage;
  resultMessageId: string;
  status: ManagedRunStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  /** Ordered process text and tool/status activity. Live-only and never persisted. */
  activity: AgentActivityEvent[];
  /** 最新 Plan 快照（内存态）。结算时随消息持久化，实时经 run.activity 事件推送。 */
  plan?: AgentPlanSnapshot;
  /** When true, this run's completion will not trigger follow-up assignment routing or supervision. */
  suppressFollowupRouting?: boolean;
  /** Who initiated this run: a user message, an agent's @mention, or the supervisor. */
  origin?: RunOrigin;
  /** 模式快照：继承自源消息，决定提示词规则与完成后的路由/监工行为，不受执行中切换全局模式影响。 */
  interactionMode?: InteractionMode;
  /**
   * ACP 结算快照标记的最终回答分组（空字符串有效，表示未分组回答）。
   * 终态 message.updated 据此让客户端显式剔除最终回答分片，无需推断。
   */
  excludedAnswerGroup?: string;
  /** Attachments from the source message, passed to the runtime. */
  sourceAttachments?: MessageAttachment[];
};

export type RunManagerOptions = {
  conversationId: string;
  agents: AgentRunner;
  messages: MessageStore;
  eventBus: EventBus;
  buildPrompt: (agentId: AgentId, prompt: string, sourceMessageId?: string, sourceAttachments?: MessageAttachment[], interactionMode?: InteractionMode) => string;
  onRunCompleted: (message: ChatMessage) => void;
  /** Resolves a user-facing display name for an agent id (defaults to the raw id). */
  getAgentLabel?: (agentId: AgentId) => string;
};

export class RunManager {
  private readonly queues = new Map<AgentId, ManagedRun[]>();
  private readonly active = new Map<AgentId, ManagedRun>();
  private readonly runs = new Map<string, ManagedRun>();
  /** Bounded memory-only compatibility index for recent terminal run ids. */
  private readonly terminalRunIndex = new Map<string, number>();
  private readonly lastTerminalActivityAt = new Map<string, number>();
  private readonly chunkBuffers = new Map<string, string>();
  private readonly lastToolNames = new Map<string, string>();
  private readonly unsubscribe: () => void;

  constructor(private readonly options: RunManagerOptions) {
    this.unsubscribe = this.options.eventBus.subscribe((event) => this.handleRuntimeEvent(event));
  }

  dispose(): void {
    this.unsubscribe();
  }

  private resolveAgentLabel(agentId: AgentId): string {
    return this.options.getAgentLabel?.(agentId) ?? agentId;
  }

  hasQueuedRuns(): boolean {
    for (const queue of this.queues.values()) {
      if (queue.length > 0) return true;
    }
    return false;
  }

  /**
   * Overlay in-memory process state onto stored messages for a state refresh.
   * Activity remains transient but is projected while the owning process is alive.
   */
  projectLiveProcessState(messages: ChatMessage[]): ChatMessage[] {
    const activeByMessageId = new Map<string, ManagedRun>();
    for (const run of this.runs.values()) {
      if (run.status === "running" || run.status === "cancelling") {
        activeByMessageId.set(run.resultMessageId, run);
      }
    }
    if (activeByMessageId.size === 0) return messages;

    return messages.map((message) => {
      const run = activeByMessageId.get(message.id);
      if (!run) return message;
      return {
        ...message,
        ...(run.activity.length > 0 ? { activity: run.activity } : {}),
        ...(run.plan ? { plan: run.plan } : {}),
      };
    });
  }

  cancelAgentRuns(agentId: AgentId): string[] {
    const cancelledRunIds: string[] = [];
    const queue = this.getQueue(agentId);
    while (queue.length > 0) {
      const run = queue.shift()!;
      this.markCancelled(run, "before start");
      cancelledRunIds.push(run.id);
    }

    const activeRun = this.active.get(agentId);
    if (activeRun && this.cancel(activeRun.id).ok) {
      cancelledRunIds.push(activeRun.id);
    }
    return cancelledRunIds;
  }

  enqueue(agentId: AgentId, prompt: string, sourceMessage: ChatMessage, origin?: RunOrigin): ManagedRun {
    const runId = createRunId(agentId);
    const resolvedOrigin: RunOrigin = origin ?? (sourceMessage.kind === "system" ? "supervisor" : sourceMessage.kind === "agent" ? "agent" : "user");
    // Supervisor runs are triggered by ChannelWatchService (already rate-limited
    // via maxTriggers) and represent a fresh coordination check, so they start
    // from a low route-depth base instead of inheriting the triggering message's
    // depth. Otherwise a supervisor reply that assigns more work would
    // keep counting from an already-deep chain and could trip maxRouteDepth early.
    const routeDepth = resolvedOrigin === "supervisor" ? 1 : (sourceMessage.routeDepth ?? 0) + 1;
    const isBusy = this.active.has(agentId);
    const now = new Date().toISOString();

    const agentMessage = this.options.messages.add({
      kind: "agent",
      agentId,
      runId,
      runStatus: isBusy ? "queued" : "running",
      content: isBusy ? `${this.resolveAgentLabel(agentId)} queued...` : `${this.resolveAgentLabel(agentId)} is working...`,
      status: "running",
      parentMessageId: sourceMessage.id,
      routeDepth,
      interactionMode: sourceMessage.interactionMode,
      approvalMode: sourceMessage.approvalMode ?? "ask",
    } satisfies NewChatMessage);
    this.options.eventBus.publish({ type: "message.created", conversationId: this.options.conversationId, message: agentMessage });

    const run: ManagedRun = {
      id: runId,
      agentId,
      prompt,
      sourceMessage,
      resultMessageId: agentMessage.id,
      status: isBusy ? "queued" : "running",
      createdAt: now,
      startedAt: isBusy ? undefined : now,
      activity: [],
      origin: resolvedOrigin,
      interactionMode: sourceMessage.interactionMode,
      sourceAttachments: sourceMessage.attachments?.length ? sourceMessage.attachments : undefined,
    };
    this.runs.set(run.id, run);
    this.appendActivity(run, isBusy ? "排队等待执行。" : "已接收任务，开始执行。");

    if (isBusy) {
      this.getQueue(agentId).push(run);
      return run;
    }

    this.active.set(agentId, run);
    this.start(run);
    return run;
  }

  cancel(runId: string): { ok: boolean; reason?: "not_found" | "not_cancellable" } {
    this.pruneTerminalRunIndex();
    const run = this.runs.get(runId);
    if (!run) {
      return this.terminalRunIndex.has(runId)
        ? { ok: false, reason: "not_cancellable" }
        : { ok: false, reason: "not_found" };
    }

    if (run.status === "completed" || run.status === "failed" || run.status === "cancelling" || run.status === "cancelled") {
      return { ok: false, reason: "not_cancellable" };
    }

    // Handle queued run cancellation
    if (run.status === "queued") {
      const queue = this.getQueue(run.agentId);
      const idx = queue.findIndex((r) => r.id === runId);
      if (idx !== -1) {
        queue.splice(idx, 1);
      }
      this.markCancelled(run, "before start");
      return { ok: true };
    }

    // Keep the run active until the runtime settles so a late response cannot
    // race the next queued task.
    if (run.status === "running") {
      const interrupted = this.options.agents.get(run.agentId).interrupt(runId);
      if (!interrupted) {
        // Process may have already exited naturally
        return { ok: false, reason: "not_cancellable" };
      }
      this.markCancelling(run);
      return { ok: true };
    }

    return { ok: false, reason: "not_cancellable" };
  }

  private markCancelling(run: ManagedRun): void {
    run.status = "cancelling";
    this.chunkBuffers.delete(run.id);
    this.lastToolNames.delete(run.id);
    this.appendActivity(run, "正在请求取消运行。");

    const updated = this.options.messages.update(run.resultMessageId, {
      status: "cancelling",
      runStatus: "cancelling",
    });
    this.options.eventBus.publish({
      type: "message.updated",
      conversationId: this.options.conversationId,
      message: updated,
    });
  }

  private markCancelled(run: ManagedRun, phase: "before start" | "during execution", reason?: string): void {
    if (run.status === "cancelled") return;
    run.status = "cancelled";
    run.completedAt = new Date().toISOString();
    // Only remove from active if interrupting a running run
    if (phase === "during execution") {
      this.active.delete(run.agentId);
    }
    this.chunkBuffers.delete(run.id);
    this.lastToolNames.delete(run.id);

    const activityText = reason ?? (phase === "before start"
      ? "Cancelled by user before start."
      : "Interrupted by user during execution.");
    this.appendActivity(run, activityText);

    const contentText = reason
      ? `${this.resolveAgentLabel(run.agentId)} ${reason}`
      : phase === "before start"
        ? `${this.resolveAgentLabel(run.agentId)} 排队任务已取消。`
        : `${this.resolveAgentLabel(run.agentId)} 运行已中断。`;

    const updated = this.options.messages.update(run.resultMessageId, {
      content: contentText,
      status: "cancelled",
      runStatus: "cancelled",
      ...this.settleProcessFields(run),
      completedAt: run.completedAt,
      startedAt: run.startedAt,
    });
    this.options.eventBus.publish({
      type: "message.updated",
      conversationId: this.options.conversationId,
      message: updated,
      settleTransientActivity: true,
      // 无结算快照时不携带该字段，客户端保留实时活动、不剔除部分回答。
      ...(run.excludedAnswerGroup !== undefined ? { excludedAnswerGroup: run.excludedAnswerGroup } : {}),
    });
    this.options.eventBus.publish({
      type: "run.cancelled",
      conversationId: this.options.conversationId,
      agentId: run.agentId,
      runId: run.id,
      resultMessageId: updated.id,
    });

    // A running run was interrupted, freeing the agent's slot — start the next
    // queued run so the queue doesn't stall (and FIFO is preserved via shift).
    // Late settlement of the cancelled run is a no-op: complete()/fail() early-
    // return on status === "cancelled", so they won't touch the next run.
    if (phase === "during execution") {
      this.startNext(run.agentId);
    }
    this.releaseRun(run);
  }

  /** Discard a queued run without writing a visible "cancelled" message.
   *
   * Used by `interruptAll()` for queued tasks: the message is marked
   * `discarded: true` so the frontend filters it out, instead of leaving a
   * "排队任务已取消" row behind. Running runs are NOT handled here — they go
   * through `cancel()` so their partially-streamed content is preserved.
   */
  private markDiscarded(run: ManagedRun): void {
    run.status = "cancelled";
    run.completedAt = new Date().toISOString();
    this.chunkBuffers.delete(run.id);
    this.lastToolNames.delete(run.id);
    this.appendActivity(run, "Cancelled by user before start.");
    const updated = this.options.messages.update(run.resultMessageId, {
      discarded: true,
      status: "cancelled",
      runStatus: "cancelled",
      ...this.settleProcessFields(run),
      completedAt: run.completedAt,
    });
    this.options.eventBus.publish({
      type: "message.updated",
      conversationId: this.options.conversationId,
      message: updated,
      settleTransientActivity: true,
      // 无结算快照时不携带该字段，客户端保留实时活动、不剔除部分回答。
      ...(run.excludedAnswerGroup !== undefined ? { excludedAnswerGroup: run.excludedAnswerGroup } : {}),
    });
    this.options.eventBus.publish({
      type: "run.cancelled",
      conversationId: this.options.conversationId,
      agentId: run.agentId,
      runId: run.id,
      resultMessageId: updated.id,
    });
    this.releaseRun(run);
  }

  /** Interrupt the current auto-collaboration chain without killing running CLI processes.
   *
   * - All queued runs are cancelled immediately.
   * - All running runs are marked with `suppressFollowupRouting`, so their
   *   completions won't trigger further assignment routing or supervision checks.
   * - Running runs continue to stream output and complete normally.
   * - New messages sent after the interrupt route normally.
   */
  interruptCurrentChain(): {
    cancelledQueuedRunIds: string[];
    suppressedRunningRunIds: string[];
  } {
    const cancelledQueuedRunIds: string[] = [];
    const suppressedRunningRunIds: string[] = [];

    // Cancel all queued runs
    for (const [agentId, queue] of this.queues) {
      while (queue.length > 0) {
        const run = queue.shift()!;
        this.markCancelled(run, "before start");
        cancelledQueuedRunIds.push(run.id);
      }
    }

    // Suppress follow-up routing for all running runs
    for (const [agentId, run] of this.active) {
      run.suppressFollowupRouting = true;
      suppressedRunningRunIds.push(run.id);
    }

    return { cancelledQueuedRunIds, suppressedRunningRunIds };
  }

  /** Stop everything in this conversation: discard all queued runs and request
   * cancellation for all running runs. Used by the unified "停止所有任务" button.
   *
   * - Queued runs go through `markDiscarded()`: their messages are marked
   *   `discarded: true` so the frontend filters them out (no "已取消" row).
   * - Running runs go through `cancel()`: their messages first show
   *   "cancelling" and preserve the partially-streamed content.
   * - Does not call `fail()`, so `run.failed` subscribers (ChannelWatch) are
   *   not triggered. `run.cancelled` is published but ChannelWatch does not
   *   subscribe to it.
   * - `interruptCurrentChain()` is left intact for internal/test use.
   */
  interruptAll(): { cancelledQueuedRunIds: string[]; cancellingRunningRunIds: string[] } {
    const cancelledQueuedRunIds: string[] = [];
    const cancellingRunningRunIds: string[] = [];

    // 1. Discard all queued runs (messages marked discarded, frontend filters)
    for (const queue of this.queues.values()) {
      while (queue.length > 0) {
        const run = queue.shift()!;
        this.markDiscarded(run);
        cancelledQueuedRunIds.push(run.id);
      }
    }

    // 2. Request cancellation for all running runs. They remain active until
    //    their runtime promises settle, so the queue cannot advance early.
    for (const run of Array.from(this.active.values())) {
      if (this.cancel(run.id).ok) {
        cancellingRunningRunIds.push(run.id);
      }
    }

    return { cancelledQueuedRunIds, cancellingRunningRunIds };
  }

  private start(run: ManagedRun): void {
    run.status = "running";
    run.startedAt = new Date().toISOString();
    this.active.set(run.agentId, run);

    // Reflect runStatus transition on the UI message
    this.options.messages.update(run.resultMessageId, {
      content: `${this.resolveAgentLabel(run.agentId)} is working...`,
      runStatus: "running",
      startedAt: run.startedAt,
    });

    this.appendActivity(run, "运行已开始。");

    // Only images go to the runtime as native ACP image blocks; file
    // attachments (PDF/text/code) travel inside the prompt as local paths.
    const imagePaths = run.sourceAttachments
      ?.filter((attachment) => attachment.kind === "image")
      .map((attachment) => attachment.path);
    // Supervisor prompts describe coordination intent, not the triggering message itself.
    // Keep that source message in conversation history so the supervisor can see the
    // employee result or user request it is expected to coordinate.
    const excludedSourceMessageId = run.origin === "supervisor" ? undefined : run.sourceMessage.id;
    const runtimePrompt = this.options.buildPrompt(run.agentId, run.prompt, excludedSourceMessageId, run.sourceAttachments, run.interactionMode);
    let result: Promise<RunResult>;
    try {
      result = this.options.agents.get(run.agentId).send(
        run.id,
        runtimePrompt,
        imagePaths,
        run.sourceMessage.approvalMode ?? "ask",
      );
    } catch (error: unknown) {
      this.fail(run, error instanceof Error ? error.message : String(error));
      return;
    }

    void result
      .then((runResult) => this.complete(run, runResult))
      .catch((error: unknown) => {
        if (isAgentRunCancelledError(error)) {
          this.markCancelled(run, "during execution", error.userMessage);
          return;
        }
        this.fail(run, error instanceof Error ? error.message : String(error));
      });
  }

  private complete(run: ManagedRun, runResult: RunResult): void {
    if (run.status === "cancelled") {
      return;
    }
    if (run.status === "cancelling") {
      this.markCancelled(run, "during execution", "运行已取消。");
      return;
    }
    run.status = "completed";
    run.completedAt = new Date().toISOString();
    this.active.delete(run.agentId);
    this.chunkBuffers.delete(run.id);
    this.lastToolNames.delete(run.id);
    this.appendActivity(run, "运行已完成。");

    const updated = this.options.messages.update(run.resultMessageId, {
      content: runResult.content,
      status: "done",
      runStatus: "completed",
      ...this.settleProcessFields(run),
      completedAt: run.completedAt,
      startedAt: run.startedAt,
      sessionId: runResult.sessionId,
      runIndex: runResult.runIndex,
    });
    this.options.eventBus.publish({
      type: "message.updated",
      conversationId: this.options.conversationId,
      message: updated,
      settleTransientActivity: true,
      // 无结算快照时不携带该字段，客户端保留实时活动、不剔除部分回答。
      ...(run.excludedAnswerGroup !== undefined ? { excludedAnswerGroup: run.excludedAnswerGroup } : {}),
    });
    this.options.eventBus.publish({
      type: "run.completed",
      conversationId: this.options.conversationId,
      agentId: run.agentId,
      runId: run.id,
      resultMessageId: updated.id,
      suppressFollowupRouting: run.suppressFollowupRouting,
    });
    if (!run.suppressFollowupRouting) {
      this.options.onRunCompleted(updated);
    }
    this.startNext(run.agentId);
    this.releaseRun(run);
  }

  // Design note: fail() intentionally does NOT check suppressFollowupRouting.
  // Unlike complete(), fail() never calls onRunCompleted (error content should not
  // be auto-routed), and run.failed events are not subscribed to by
  // ChannelWatchService. If a future change adds routing subscribers to run.failed,
  // add the suppressFollowupRouting check here to match complete().
  private fail(run: ManagedRun, error: string): void {
    if (run.status === "cancelled") {
      return;
    }
    if (run.status === "cancelling") {
      this.markCancelled(run, "during execution", "运行已取消。");
      return;
    }
    const errorSummary = summarizeRunError(error);
    run.status = "failed";
    run.completedAt = new Date().toISOString();
    this.active.delete(run.agentId);
    this.chunkBuffers.delete(run.id);
    this.lastToolNames.delete(run.id);
    this.appendActivity(run, `运行失败：${errorSummary}`);

    const updated = this.options.messages.update(run.resultMessageId, {
      content: `${this.resolveAgentLabel(run.agentId)} 运行失败：${errorSummary}`,
      status: "error",
      runStatus: "failed",
      ...this.settleProcessFields(run),
      completedAt: run.completedAt,
      startedAt: run.startedAt,
    });
    this.options.eventBus.publish({
      type: "message.updated",
      conversationId: this.options.conversationId,
      message: updated,
      settleTransientActivity: true,
      // 无结算快照时不携带该字段，客户端保留实时活动、不剔除部分回答。
      ...(run.excludedAnswerGroup !== undefined ? { excludedAnswerGroup: run.excludedAnswerGroup } : {}),
    });
    this.options.eventBus.publish({ type: "run.failed", conversationId: this.options.conversationId, agentId: run.agentId, runId: run.id, error: errorSummary, interactionMode: run.interactionMode });
    this.startNext(run.agentId);
    this.releaseRun(run);
  }

  private startNext(agentId: AgentId): void {
    const next = this.getQueue(agentId).shift();
    if (!next) {
      return;
    }

    const startedAt = new Date().toISOString();
    const updated = this.options.messages.update(next.resultMessageId, {
      content: `${this.resolveAgentLabel(agentId)} is working...`,
      status: "running",
      runStatus: "running",
      startedAt,
    });
    this.options.eventBus.publish({ type: "message.updated", conversationId: this.options.conversationId, message: updated });
    this.start(next);
  }

  private appendActivity(run: ManagedRun, text: string): void {
    const activity = createActivity(text);
    this.appendActivityEvent(run, activity);
  }

  private appendActivityEvent(run: ManagedRun, activity: AgentActivityEvent): void {
    const boundedActivity = truncateActivity(activity);
    if (boundedActivity.type === "process.text" && boundedActivity.snapshot) {
      // 结算快照是服务端内部信号：只记录最终回答分组（含空字符串），不改写
      // live activity、不发布 run.activity。终态 message.updated 一次完成正文
      // 替换与过程清理，避免"过程区先清空、正文后出现"的二次渲染。
      if (boundedActivity.excludedAnswerGroup !== undefined) {
        run.excludedAnswerGroup = boundedActivity.excludedAnswerGroup;
      }
      return;
    }
    if (boundedActivity.type === "plan.updated") {
      run.plan = boundedActivity.plan;
    } else if (boundedActivity.type === "plan.removed") {
      if (run.plan?.id === undefined || run.plan.id === boundedActivity.planId) {
        run.plan = undefined;
      }
    } else {
      run.activity = appendTransientProcessActivity(run.activity, boundedActivity);
    }
    this.options.eventBus.publish({ type: "run.activity", conversationId: this.options.conversationId, agentId: run.agentId, runId: run.id, activity: boundedActivity });
  }

  /** 运行结算时随消息持久化的过程字段。工具/状态活动不落盘，仅在内存与实时流中。 */
  private settleProcessFields(run: ManagedRun): {
    processTimeline: PersistedProcessTimelineEntry[] | null;
    plan: AgentPlanSnapshot | null;
  } {
    // live activity 保留最终回答直到终态；持久化时间线基于副本剔除结算分组，
    // 运行中的投影因此不会提前清空，刷新后过程区也不含最终正文。
    const settledActivity = run.excludedAnswerGroup !== undefined
      ? withoutAnswerGroup(run.activity, run.excludedAnswerGroup)
      : run.activity;
    const processTimeline = buildPersistedProcessTimeline(settledActivity, MAX_PROCESS_TEXT_CHARS);
    return {
      processTimeline: processTimeline.length > 0 ? processTimeline : null,
      plan: run.plan ?? null,
    };
  }

  private releaseRun(run: ManagedRun): void {
    this.rememberTerminalRun(run.id);
    this.runs.delete(run.id);
    this.lastTerminalActivityAt.delete(run.id);
    this.chunkBuffers.delete(run.id);
    this.lastToolNames.delete(run.id);
  }

  private rememberTerminalRun(runId: string): void {
    const expiresAt = Date.now() + TERMINAL_RUN_RETENTION_MS;
    this.pruneTerminalRunIndex(Date.now());
    this.terminalRunIndex.delete(runId);
    this.terminalRunIndex.set(runId, expiresAt);

    while (this.terminalRunIndex.size > MAX_TERMINAL_RUN_INDEX_SIZE) {
      const oldest = this.terminalRunIndex.keys().next().value as string | undefined;
      if (!oldest) break;
      this.terminalRunIndex.delete(oldest);
    }
  }

  private pruneTerminalRunIndex(now = Date.now()): void {
    for (const [runId, expiresAt] of this.terminalRunIndex) {
      if (expiresAt <= now) {
        this.terminalRunIndex.delete(runId);
      }
    }
  }

  private handleRuntimeEvent(event: RuntimeEvent): void {
    // Only process events for our own conversation
    if ("conversationId" in event && event.conversationId !== this.options.conversationId) return;

    if (event.type === "run.sessionId" && event.runId) {
      const run = this.runs.get(event.runId);
      if (run && run.status === "running") {
        const updated = this.options.messages.update(run.resultMessageId, {
          sessionId: event.sessionId,
        });
        this.options.eventBus.publish({ type: "message.updated", conversationId: this.options.conversationId, message: updated });
      }
      return;
    }

    if (event.type === "runtime.activity" && event.runId) {
      const run = this.runs.get(event.runId);
      if (run && run.status === "running") {
        this.appendActivityEvent(run, event.activity);
      }
      return;
    }

    if (event.type !== "terminal.chunk" || !event.runId) {
      return;
    }

    const run = this.runs.get(event.runId);
    if (!run || run.status !== "running") {
      return;
    }

    const { complete, nonJson } = this.flushChunkBuffer(run.id, event.text);
    const allActivities: AgentActivityEvent[] = [];

    if (nonJson) {
      allActivities.push(...classifyTerminalActivities(nonJson));
    }
    if (complete) {
      allActivities.push(...classifyTerminalActivities(complete));
    }

    for (const activity of allActivities) {
      if (activity.type === "tool.started") {
        this.lastToolNames.set(run.id, activity.name);
      }
      if ((activity.type === "tool.completed" || activity.type === "tool.failed") && activity.name === "tool") {
        const lastName = this.lastToolNames.get(run.id);
        if (lastName) {
          (activity as { name: string }).name = lastName;
        }
      }
    }

    const activities = allActivities;
    if (activities.length === 0) {
      return;
    }

    for (const activity of activities) {
      const now = Date.now();
      const previous = this.lastTerminalActivityAt.get(run.id) ?? 0;
      if (activity.type === "status" && now - previous < 10_000) {
        continue;
      }

      if (activity.type === "status") {
        this.lastTerminalActivityAt.set(run.id, now);
      }
      this.appendActivityEvent(run, activity);
    }
  }

  private getQueue(agentId: AgentId): ManagedRun[] {
    const queue = this.queues.get(agentId);
    if (queue) {
      return queue;
    }

    const nextQueue: ManagedRun[] = [];
    this.queues.set(agentId, nextQueue);
    return nextQueue;
  }

  private flushChunkBuffer(runId: string, incoming: string): { complete: string; nonJson: string } {
    const prev = this.chunkBuffers.get(runId) ?? "";

    if (!prev) {
      const lastBrace = findLastTopLevelClose(incoming);
      if (lastBrace === -1) {
        const startsLikeJson = /^\s*\{/.test(incoming);
        if (startsLikeJson) {
          this.chunkBuffers.set(runId, incoming);
          return { complete: "", nonJson: "" };
        }
        return { complete: "", nonJson: incoming };
      }
      const complete = incoming.slice(0, lastBrace + 1);
      const tail = incoming.slice(lastBrace + 1).replace(/^\s+/, "");
      if (tail) {
        this.chunkBuffers.set(runId, tail);
      } else {
        this.chunkBuffers.delete(runId);
      }
      return { complete, nonJson: "" };
    }

    const combined = prev + incoming;
    const lastBrace = findLastTopLevelClose(combined);
    if (lastBrace === -1) {
      this.chunkBuffers.set(runId, combined);
      return { complete: "", nonJson: "" };
    }

    const complete = combined.slice(0, lastBrace + 1);
    const tail = combined.slice(lastBrace + 1).replace(/^\s+/, "");
    if (tail) {
      this.chunkBuffers.set(runId, tail);
    } else {
      this.chunkBuffers.delete(runId);
    }
    return { complete, nonJson: "" };
  }
}

function createRunId(agentId: AgentId): string {
  return `run_${agentId}_${Date.now()}_${randomBytes(8).toString("hex")}`;
}

function createActivity(text: string): AgentActivityEvent {
  return { type: "status", text, timestamp: new Date().toISOString() };
}

function findLastTopLevelClose(text: string): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let lastClose = -1;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        lastClose = i;
      }
    }
  }

  return lastClose;
}

export function classifyTerminalActivity(text: string): AgentActivityEvent | null {
  return classifyTerminalActivities(text)[0] ?? null;
}

export function classifyTerminalActivities(text: string): AgentActivityEvent[] {
  const jsonActivities = extractStreamJsonActivities(text);
  if (jsonActivities.length > 0) {
    return jsonActivities;
  }

  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return [];
  }

  if (/api error|hook error|failed with/i.test(normalized)) {
    const upstreamBusy = summarizeUpstreamBusyError(normalized);
    return [{
      type: "error",
      message: upstreamBusy ?? "Runtime reported an error. Waiting for final result.",
      timestamp: new Date().toISOString(),
    }];
  }

  const toolMatch = /\b(Bash|Edit|Write|Read|Grep|Glob|LS|TodoWrite|MultiEdit|NotebookEdit)\b/i.exec(normalized);
  if (toolMatch) {
    return [{ type: "tool.started", name: toolMatch[1], timestamp: new Date().toISOString() }];
  }

  if (/running|thinking|synthesizing|brewing|twisting|fiddl/i.test(normalized)) {
    return [{ type: "status", text: "Claude Code is still working.", timestamp: new Date().toISOString() }];
  }

  return [{ type: "status", text: "Runtime produced output.", timestamp: new Date().toISOString() }];
}

function extractStreamJsonActivities(text: string): AgentActivityEvent[] {
  const activities: AgentActivityEvent[] = [];
  for (const event of parseJsonObjects(text)) {
    try {
      const record = event as {
        type?: string;
        message?: string | { content?: unknown };
        item?: unknown;
        result?: unknown;
        text?: unknown;
        error?: unknown;
        data?: unknown;
        tool_use_result?: { stdout?: unknown; stderr?: unknown; is_error?: unknown };
      };

      const codexActivity = activityFromCodexItem(record.item, record.type);
      if (codexActivity) {
        activities.push(codexActivity);
      }

      if (record.type === "error") {
        const message = typeof record.message === "string" ? record.message : typeof record.error === "string" ? record.error : "";
        if (message) {
          activities.push({
            type: "error",
            message: truncateText(message, MAX_ACTIVITY_TEXT_CHARS),
            timestamp: new Date().toISOString(),
          });
        }
      }

      const message = typeof record.message === "object" && record.message ? record.message as { content?: unknown } : null;
      if (record.type === "assistant" && Array.isArray(message?.content)) {
        for (const part of message.content as Array<{ type?: unknown; name?: unknown; input?: unknown }>) {
          if (part.type === "tool_use" && typeof part.name === "string") {
            activities.push({
              type: "tool.started",
              name: part.name,
              input: summarizeToolInput(part.input),
              timestamp: new Date().toISOString(),
            });
          }
        }
      }

      if (record.type === "user" && record.tool_use_result) {
        const isError = !!record.tool_use_result.is_error;
        const lastToolName = findLastToolName(activities);
        if (isError) {
          const summary = summarizeFailedToolResult(record.tool_use_result);
          activities.push({
            type: "tool.failed",
            name: lastToolName,
            summary,
            timestamp: new Date().toISOString(),
          });
        } else {
          activities.push({
            type: "tool.completed",
            name: lastToolName,
            timestamp: new Date().toISOString(),
          });
        }
      }
    } catch {
      continue;
    }
  }

  return activities;
}

const MAX_RUN_ERROR_CHARS = 2_000;
const MAX_ACTIVITY_TEXT_CHARS = 2_000;
const MAX_TOOL_SUMMARY_CHARS = 120;
const MAX_PROCESS_TEXT_CHARS = 20_000;

function activityFromCodexItem(item: unknown, eventType: unknown): AgentActivityEvent | null {
  if (!item || typeof item !== "object") {
    return null;
  }

  const record = item as {
    type?: unknown;
    command?: unknown;
    aggregated_output?: unknown;
    exit_code?: unknown;
    status?: unknown;
  };

  if (record.type !== "command_execution") {
    return null;
  }

  const name = commandToolName(record.command);
  if (eventType === "item.started") {
    return {
      type: "tool.started",
      name,
      input: typeof record.command === "string" ? truncateText(record.command, MAX_TOOL_SUMMARY_CHARS) : undefined,
      timestamp: new Date().toISOString(),
    };
  }

  if (eventType !== "item.completed") {
    return null;
  }

  if (typeof record.exit_code === "number" && record.exit_code !== 0) {
    const summary = summarizeCodexCommandOutput(record.aggregated_output);
    return {
      type: "tool.failed",
      name,
      summary: summary || `exit ${record.exit_code}`,
      timestamp: new Date().toISOString(),
    };
  }

  if (record.status === "failed") {
    const summary = summarizeCodexCommandOutput(record.aggregated_output);
    return {
      type: "tool.failed",
      name,
      summary: summary || "failed",
      timestamp: new Date().toISOString(),
    };
  }

  return {
    type: "tool.completed",
    name,
    timestamp: new Date().toISOString(),
  };
}

function commandToolName(command: unknown): string {
  if (typeof command !== "string") {
    return "Command";
  }

  if (/powershell|pwsh/i.test(command)) return "PowerShell";
  if (/\b(cmd\.exe|cmd)\b/i.test(command)) return "Command";
  if (/\b(bash|sh|zsh)\b/i.test(command)) return "Bash";
  return "Command";
}

function summarizeCodexCommandOutput(output: unknown): string | undefined {
  if (typeof output !== "string") {
    return undefined;
  }

  const summary = output.replace(/\s+/g, " ").trim();
  if (!summary) {
    return undefined;
  }

  return truncateText(summary, MAX_TOOL_SUMMARY_CHARS);
}

function truncateActivity(activity: AgentActivityEvent): AgentActivityEvent {
  if (activity.type === "status") {
    return { ...activity, text: truncateText(activity.text, MAX_ACTIVITY_TEXT_CHARS) };
  }
  if (activity.type === "process.text") {
    return { ...activity, text: truncateText(activity.text, MAX_PROCESS_TEXT_CHARS) };
  }
  if (activity.type === "error") {
    return { ...activity, message: truncateText(activity.message, MAX_ACTIVITY_TEXT_CHARS) };
  }
  if (activity.type === "tool.started") {
    return { ...activity, input: activity.input ? truncateText(activity.input, MAX_TOOL_SUMMARY_CHARS) : undefined };
  }
  if (activity.type === "tool.completed" || activity.type === "tool.failed") {
    return { ...activity, summary: activity.summary ? truncateText(activity.summary, MAX_TOOL_SUMMARY_CHARS) : undefined };
  }
  if (activity.type === "plan.updated") {
    if (activity.plan.format === "items") {
      return {
        ...activity,
        plan: {
          ...activity.plan,
          entries: activity.plan.entries.slice(0, 100).map((entry) => ({
            ...entry,
            content: truncateText(entry.content, MAX_ACTIVITY_TEXT_CHARS),
          })),
        },
      };
    }
    if (activity.plan.format === "markdown") {
      return {
        ...activity,
        plan: { ...activity.plan, content: truncateText(activity.plan.content, 10_000) },
      };
    }
    return {
      ...activity,
      plan: { ...activity.plan, uri: truncateText(activity.plan.uri, MAX_ACTIVITY_TEXT_CHARS) },
    };
  }
  return activity;
}

function summarizeRunError(error: string): string {
  const normalized = error.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "Runtime failed without an error message. Check the transcript for details.";
  }

  const upstreamBusy = summarizeUpstreamBusyError(normalized);
  if (upstreamBusy) {
    return upstreamBusy;
  }

  return truncateText(stripRawJsonNoise(normalized), MAX_RUN_ERROR_CHARS);
}

function summarizeUpstreamBusyError(value: string): string | null {
  if (!/\b(529|overloaded|server_error)\b/i.test(value)) {
    return null;
  }

  if (!/api error|server_error|overloaded/i.test(value)) {
    return null;
  }

  return "上游模型服务繁忙（529 overloaded）。请稍后重试，或切换到其他可用运行时。";
}

function stripRawJsonNoise(value: string): string {
  if (!value.includes("{\"type\":")) {
    return value;
  }

  const structured: string[] = [];
  const assistantText: string[] = [];

  for (const event of parseJsonObjects(value)) {
    const record = event as {
      type?: unknown;
      message?: unknown;
      error?: unknown;
      result?: unknown;
      item?: { type?: unknown; exit_code?: unknown; status?: unknown; aggregated_output?: unknown };
    };

    if (typeof record.error === "string" && record.error.trim()) {
      structured.push(record.error);
    }
    if (typeof record.message === "string" && record.message.trim()) {
      structured.push(record.message);
    }
    if (typeof record.result === "string" && record.result.trim()) {
      structured.push(record.result);
    }
    if (record.item?.type === "command_execution" && record.item.status === "failed") {
      const output = typeof record.item.aggregated_output === "string" ? record.item.aggregated_output : "";
      structured.push(output || `Command failed${typeof record.item.exit_code === "number" ? ` with exit ${record.item.exit_code}` : ""}`);
    }

    // Surface assistant text the CLI streamed before crashing. When a run dies
    // mid-flight there is often no result/error event — this partial answer is
    // usually the most useful clue, and must not be silently discarded.
    if (record.type === "assistant" && typeof record.message === "object" && record.message !== null) {
      const content = (record.message as { content?: unknown }).content;
      if (Array.isArray(content)) {
        for (const part of content as Array<{ type?: unknown; text?: unknown }>) {
          if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
            assistantText.push(part.text);
          }
        }
      }
    }
  }

  if (structured.length > 0) {
    return structured.join(" ");
  }
  if (assistantText.length > 0) {
    return assistantText.join(" ");
  }

  // Nothing extractable: be specific that the CLI produced no final result
  // rather than showing a bare generic apology that hides the failure.
  return "运行异常终止：未收到数字员工的最终结果，请查看运行日志了解详情。";
}

function findLastToolName(activities: AgentActivityEvent[]): string {
  for (let i = activities.length - 1; i >= 0; i--) {
    const activity = activities[i];
    if (activity?.type === "tool.started") {
      return activity.name;
    }
  }
  return "tool";
}

function summarizeToolInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }

  const value = input as Record<string, unknown>;
  const command = typeof value.command === "string" ? value.command : undefined;
  const filePath = typeof value.file_path === "string" ? value.file_path : undefined;
  const pattern = typeof value.pattern === "string" ? value.pattern : undefined;
  return command ?? filePath ?? pattern;
}

function summarizeFailedToolResult(result: { stdout?: unknown; stderr?: unknown }): string {
  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
  const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
  const summary = stderr || stdout;
  if (!summary) {
    return "failed";
  }

  return truncateText(summary, MAX_TOOL_SUMMARY_CHARS);
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}
