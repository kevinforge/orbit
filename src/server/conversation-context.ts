import path from "node:path";

import { AgentRegistry } from "../core/agent-registry.ts";
import { buildAgentContext } from "../core/agent-context-builder.ts";
import { buildHistoryForAgent, SUPERVISOR_HISTORY_TURNS } from "../core/agent-history-builder.ts";
import { EventBus } from "../core/event-bus.ts";
import { MessageStore } from "../core/message-store.ts";
import { RunManager } from "../core/run-manager.ts";
import { SessionStore } from "../core/session-store.ts";
import { TerminalTranscriptStore } from "../core/terminal-transcript-store.ts";
import { WorkspaceStore } from "../core/workspace-store.ts";
import { MessageRouter } from "../core/message-router.ts";
import { ChannelWatchService } from "../core/channel-watch.ts";
import {
  type ElicitationResponse,
  type AgentId,
  type AgentProfile,
  type GlobalRuntimeConfig,
  type InteractionMode,
  type PendingElicitation,
  type PendingPermission,
  type PermissionDecision,
  type WorkspaceRuntimeConfig,
  type AgentRuntimeKind,
} from "../shared/types.ts";
import { DEFAULT_WORKSPACE_CONFIG, DEFAULT_GLOBAL_CONFIG } from "../shared/types.ts";
import { createSupervisorProfile, INTERNAL_SUPERVISOR_ID } from "../core/agent-profiles.ts";

const MAX_ROUTE_DEPTH = 10;

export type ConversationContextPatch = {
  interactionMode?: InteractionMode;
  supervisionRuntime?: AgentRuntimeKind | null;
  lastDirectAgentId?: AgentId;
};

export type ConversationContextOptions = {
  workspaceId: string;
  conversationId: string;
  profiles: readonly AgentProfile[];
  eventBus: EventBus;
  sessionStore: SessionStore;
  workspaceStore: WorkspaceStore;
  workspaceConfig?: WorkspaceRuntimeConfig;
  globalConfig?: GlobalRuntimeConfig;
  interactionMode?: InteractionMode;
  supervisionRuntime?: AgentRuntimeKind;
  lastDirectAgentId?: AgentId;
  /** 会话记录变更回调（如普通对话目标员工变化），由服务层负责持久化。 */
  onConversationPatch?: (patch: ConversationContextPatch) => void;
};

export class ConversationContext {
  readonly messages: MessageStore;
  readonly transcripts: TerminalTranscriptStore;
  agents: AgentRegistry;
  runManager: RunManager;
  messageRouter: MessageRouter;
  channelWatch: ChannelWatchService;

  private _profiles: readonly AgentProfile[];
  private _workspaceConfig: WorkspaceRuntimeConfig;
  private _globalConfig: GlobalRuntimeConfig;
  private _interactionMode: InteractionMode;
  private _lastDirectAgentId?: AgentId;
  private _supervisionRuntime?: AgentRuntimeKind;
  private readonly eventBus: EventBus;
  private readonly unsubscribe: () => void;

  constructor(private options: ConversationContextOptions) {
    const { workspaceId, conversationId, profiles, eventBus, sessionStore, workspaceStore } = options;
    // Store workspace config as mutable instance field so updateWorkspaceConfig()
    // can update it at runtime without recreating the context.
    this._workspaceConfig = options.workspaceConfig ?? structuredClone(DEFAULT_WORKSPACE_CONFIG);
    this._globalConfig = options.globalConfig ?? structuredClone(DEFAULT_GLOBAL_CONFIG);
    this._interactionMode = options.interactionMode ?? "collaborative";
    this._lastDirectAgentId = options.lastDirectAgentId;
    this._supervisionRuntime = options.supervisionRuntime;
    this._profiles = profiles.filter((profile) => !profile.internal);
    this.eventBus = eventBus;

    const messagesPath = path.join(
      workspaceStore.channelsDir(workspaceId, conversationId),
      "messages.json",
    );

    this.messages = new MessageStore(messagesPath);
    const abandonedRuns = this.messages.markAbandonedActiveRuns();
    if (abandonedRuns.length > 0) {
      console.warn(`[orbit] marked ${abandonedRuns.length} abandoned run(s) as interrupted after restart`);
    }

    // 运行日志开关：根据全局配置决定是否记录数字员工运行日志。
    // 如果关闭，不传递 transcriptsDir，TerminalTranscriptStore 将不会持久化日志。
    const transcriptsDir = this._globalConfig.enableRunLogs
      ? workspaceStore.transcriptsDir(workspaceId, conversationId)
      : undefined;

    this.transcripts = new TerminalTranscriptStore(transcriptsDir);

    this.unsubscribe = eventBus.subscribe((event) => {
      // Only process events belonging to this conversation
      if ("conversationId" in event && event.conversationId !== conversationId) return;
      if ((event as { type: string }).type === "terminal.chunk") {
        const e = event as { agentId: string; text: string };
        this.transcripts.append(e.agentId, e.text);
      }
    });

    const activeProfiles = this.buildActiveProfiles(this._profiles);
    this.agents = new AgentRegistry(activeProfiles, eventBus, sessionStore, conversationId);
    this.agents.startAll();

    const agentIds = this.agents.ids();

    const self = this;
    this.runManager = new RunManager({
      conversationId,
      agents: this.agents,
      messages: this.messages,
      eventBus,
      buildPrompt: (agentId, prompt, sourceMessageId, imagePaths, interactionMode) =>
        self.buildRuntimePrompt(agentId, prompt, sourceMessageId, imagePaths, interactionMode),
      onRunCompleted: (message) => {
        self.messageRouter.process(message);
      },
      getAgentLabel: (agentId: AgentId) => self.channelProfiles().find((profile) => profile.id === agentId)?.name ?? agentId,
    });

    this.messageRouter = this.createMessageRouter(activeProfiles);

    this.channelWatch = new ChannelWatchService(
      conversationId,
      this.agents,
      this.runManager,
      this.messages,
      eventBus,
      this.channelProfiles(),
    );
  }

  hasRunningAgent(): boolean {
    return this.agents.hasRunningAgent();
  }

  hasRunningOrQueued(): boolean {
    return this.hasRunningAgent() || this.runManager.hasQueuedRuns();
  }

  interrupt(): { cancelledQueuedRunIds: string[]; killedRunningRunIds: string[] } {
    return this.runManager.interruptAll();
  }

  pendingPermissions(): PendingPermission[] {
    return this.agents.pendingPermissions();
  }

  pendingElicitations(): PendingElicitation[] {
    return this.agents.pendingElicitations();
  }

  resolvePermission(requestId: string, decision: PermissionDecision): boolean {
    return this.agents.resolvePermission(requestId, decision);
  }

  resolveElicitation(requestId: string, response: ElicitationResponse): boolean {
    return this.agents.resolveElicitation(requestId, response);
  }

  refreshProfiles(profiles: readonly AgentProfile[]): void {
    this.channelWatch.dispose();
    this.agents.stopAll();
    this.runManager.dispose();

    const { workspaceId, conversationId, eventBus, sessionStore } = this.options;
    const activeProfiles = this.buildActiveProfiles(profiles);
    const newAgents = new AgentRegistry(activeProfiles, eventBus, sessionStore, conversationId);
    newAgents.startAll();

    this._profiles = profiles.filter((profile) => !profile.internal);

    const agentIds = newAgents.ids();

    const self = this;

    const newRunManager = new RunManager({
      conversationId,
      agents: newAgents,
      messages: this.messages,
      eventBus,
      buildPrompt: (agentId, prompt, sourceMessageId, imagePaths, interactionMode) =>
        self.buildRuntimePrompt(agentId, prompt, sourceMessageId, imagePaths, interactionMode),
      onRunCompleted: (message) => {
        self.messageRouter.process(message);
      },
      getAgentLabel: (agentId: AgentId) => activeProfiles.find((profile) => profile.id === agentId)?.name ?? agentId,
    });

    const newMessageRouter = this.createMessageRouter(activeProfiles, newRunManager);

    const newChannelWatch = new ChannelWatchService(
      conversationId,
      newAgents,
      newRunManager,
      this.messages,
      eventBus,
      this.channelProfiles(activeProfiles),
    );

    // Replace mutable fields via Object.assign (intentional hot-swap)
    Object.assign(this, {
      agents: newAgents,
      runManager: newRunManager,
      messageRouter: newMessageRouter,
      channelWatch: newChannelWatch,
    });
  }

  interactionMode(): InteractionMode {
    return this._interactionMode;
  }

  lastDirectAgentId(): AgentId | undefined {
    return this._lastDirectAgentId;
  }

  supervisionRuntime(): AgentRuntimeKind | undefined {
    return this._supervisionRuntime;
  }

  /**
   * 切换会话交互模式。只影响下一条用户消息：运行中/排队任务及其后续链沿用
   * 各自的模式快照，不因切换而取消或改变行为。
   *
   * 监工策略：一旦设置过 supervisionRuntime，监工会话保持注册——切换到普通/
   * 简单协作不删除其持久化 session（再次开启复杂协作时原样恢复），且仍在执行
   * 的复杂协作链完成时仍可触发监工收尾（由 ChannelWatch 按消息模式快照门控）。
   */
  setInteractionMode(mode: InteractionMode, runtime?: AgentRuntimeKind): void {
    if (mode === "supervised") {
      const selectedRuntime = runtime ?? this._supervisionRuntime;
      if (!selectedRuntime) throw new Error("A runtime is required to enable supervised collaboration.");
      // 切换监工 runtime 是对监工自身的重建操作：取消其排队/运行中的检查。
      if (!this.agents.has(INTERNAL_SUPERVISOR_ID) || this._supervisionRuntime !== selectedRuntime) {
        this.runManager.cancelAgentRuns(INTERNAL_SUPERVISOR_ID);
        this.agents.remove(INTERNAL_SUPERVISOR_ID);
        this.agents.add(createSupervisorProfile(this.cwd(), selectedRuntime));
      }
      this._supervisionRuntime = selectedRuntime;
    }
    // direct/collaborative：保留监工注册与 runtime 记录（不取消其运行、不清 session）。
    this._interactionMode = mode;
    this.options.onConversationPatch?.({
      interactionMode: mode,
      ...(mode === "supervised" && this._supervisionRuntime
        ? { supervisionRuntime: this._supervisionRuntime }
        : {}),
    });
    this.rebuildCoordinationLayer();
  }

  private buildRuntimePrompt(
    agentId: AgentId,
    prompt: string,
    sourceMessageId?: string,
    imagePaths?: string[],
    interactionMode?: InteractionMode,
  ): string {
    const history = buildHistoryForAgent(agentId, this.messages.list(), {
      excludeMessageId: sourceMessageId,
      ...(agentId === INTERNAL_SUPERVISOR_ID ? { maxTurns: SUPERVISOR_HISTORY_TURNS } : {}),
    });
    return buildAgentContext({
      agentId,
      profiles: agentId === INTERNAL_SUPERVISOR_ID ? this.channelProfiles() : this._profiles,
      agentMessage: prompt,
      // 运行继承源消息的模式快照；缺失时回退当前模式。
      interactionMode: interactionMode ?? this._interactionMode,
      history,
      workspaceConfig: this._workspaceConfig,
    });
  }

  private handleLastDirectAgentChange(agentId: AgentId): void {
    if (this._lastDirectAgentId === agentId) return;
    this._lastDirectAgentId = agentId;
    this.options.onConversationPatch?.({ lastDirectAgentId: agentId });
  }

  private cwd(): string {
    return this._profiles.find((profile) => !profile.internal)?.cwd ?? process.cwd();
  }

  private buildActiveProfiles(profiles: readonly AgentProfile[]): AgentProfile[] {
    const normalProfiles = profiles.filter((profile) => !profile.internal);
    // 监工注册条件是"设置过 supervisionRuntime"而非当前模式：切换到普通/简单协作
    // 后，仍在执行的复杂协作链仍可能需要监工检查，且其 session 需要保持可恢复。
    if (!this._supervisionRuntime) return [...normalProfiles];
    return [...normalProfiles, createSupervisorProfile(this.cwdFrom(profiles), this._supervisionRuntime)];
  }

  private cwdFrom(profiles: readonly AgentProfile[]): string {
    return profiles.find((profile) => !profile.internal)?.cwd ?? process.cwd();
  }

  private channelProfiles(profiles = this._profiles): AgentProfile[] {
    if (!this._supervisionRuntime) return [...profiles];
    return profiles.some((profile) => profile.id === INTERNAL_SUPERVISOR_ID)
      ? [...profiles]
      : [...profiles, createSupervisorProfile(this.cwdFrom(profiles), this._supervisionRuntime)];
  }

  private rebuildCoordinationLayer(): void {
    this.channelWatch.dispose();
    const profiles = this.channelProfiles();
    this.messageRouter = this.createMessageRouter(profiles);
    this.channelWatch = new ChannelWatchService(
      this.options.conversationId,
      this.agents,
      this.runManager,
      this.messages,
      this.eventBus,
      profiles,
    );
  }

  private createMessageRouter(_profiles: readonly AgentProfile[], runManager = this.runManager): MessageRouter {
    const self = this;
    return new MessageRouter({
      availableAgents: _profiles.filter((profile) => !profile.internal),
      maxRouteDepth: MAX_ROUTE_DEPTH,
      getInteractionMode: () => this._interactionMode,
      getLastDirectAgentId: () => this._lastDirectAgentId,
      setLastDirectAgentId: (agentId) => this.handleLastDirectAgentChange(agentId),
      createSystemMessage: (content, parentMessageId) => {
        const msg = self.messages.add({ kind: "system", content, status: "done", parentMessageId });
        self.eventBus.publish({ type: "message.created", conversationId: self.options.conversationId, message: msg });
        return msg;
      },
      startAgentRun: (agentId, prompt, sourceMessage) => runManager.enqueue(agentId, prompt, sourceMessage),
      markMessageRouted: (messageId, routeState) => {
        const updated = self.messages.markRouteState(messageId, routeState);
        if (updated) self.eventBus.publish({ type: "message.updated", conversationId: self.options.conversationId, message: updated });
      },
    });
  }

  updateWorkspaceConfig(config: WorkspaceRuntimeConfig): void {
    this._workspaceConfig = config;
    this.options = { ...this.options, workspaceConfig: config };
  }

  updateGlobalConfig(config: GlobalRuntimeConfig): void {
    this._globalConfig = config;
    this.options = { ...this.options, globalConfig: config };
  }

  dispose(): void {
    this.channelWatch.dispose();
    this.agents.stopAll();
    this.runManager.dispose();
    this.transcripts.dispose();
    this.unsubscribe();
  }
}
