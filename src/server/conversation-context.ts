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
  type AgentCommand,
  type AgentId,
  type AgentProfile,
  type GlobalRuntimeConfig,
  type InteractionMode,
  type MessageAttachment,
  type PendingElicitation,
  type PendingPermission,
  type PermissionDecision,
  type WorkspaceRuntimeConfig,
  type AgentRuntimeKind,
  type SupervisorConfig,
} from "../shared/types.ts";
import { DEFAULT_WORKSPACE_CONFIG, DEFAULT_GLOBAL_CONFIG } from "../shared/types.ts";
import { createSupervisorProfile, INTERNAL_SUPERVISOR_ID } from "../core/agent-profiles.ts";
import type { AgentModelStateBridge } from "../core/agent-session.ts";

const MAX_ROUTE_DEPTH = 10;

export type ConversationContextPatch = {
  interactionMode?: InteractionMode;
  supervisorConfig?: SupervisorConfig | null;
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
  /** 监工的运行时与模型偏好（issue #153）。旧字段 supervisionRuntime 由存储层映射而来。 */
  supervisorConfig?: SupervisorConfig;
  lastDirectAgentId?: AgentId;
  /** 会话记录变更回调（如普通对话目标员工变化），由服务层负责持久化。 */
  onConversationPatch?: (patch: ConversationContextPatch) => void;
  /** 模型快照桥（issue #142）：读写 workspace 级员工模型状态。 */
  modelState?: AgentModelStateBridge;
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
  private _supervisorConfig?: SupervisorConfig;
  private readonly eventBus: EventBus;
  private readonly unsubscribe: () => void;
  private messageMutationTail: Promise<void> = Promise.resolve();

  constructor(private options: ConversationContextOptions) {
    const { workspaceId, conversationId, profiles, eventBus, sessionStore, workspaceStore } = options;
    // Store workspace config as mutable instance field so updateWorkspaceConfig()
    // can update it at runtime without recreating the context.
    this._workspaceConfig = options.workspaceConfig ?? structuredClone(DEFAULT_WORKSPACE_CONFIG);
    this._globalConfig = options.globalConfig ?? structuredClone(DEFAULT_GLOBAL_CONFIG);
    this._interactionMode = options.interactionMode ?? "direct";
    this._lastDirectAgentId = options.lastDirectAgentId;
    this._supervisorConfig = options.supervisorConfig;
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
      if ("workspaceId" in event && event.workspaceId !== undefined && event.workspaceId !== workspaceId) return;
      if ("conversationId" in event && event.conversationId !== conversationId) return;
      if ((event as { type: string }).type === "terminal.chunk") {
        const e = event as { agentId: string; text: string };
        this.transcripts.append(e.agentId, e.text);
      }
    });

    const activeProfiles = this.buildActiveProfiles(this._profiles);
    this.agents = new AgentRegistry(activeProfiles, eventBus, sessionStore, conversationId, undefined, options.modelState, workspaceId);
    this.agents.startAll();

    const agentIds = this.agents.ids();

    const self = this;
    this.runManager = new RunManager({
      conversationId,
      workspaceId,
      agents: this.agents,
      messages: this.messages,
      eventBus,
      buildPrompt: (agentId, prompt, sourceMessageId, sourceAttachments, interactionMode) =>
        self.buildRuntimePrompt(agentId, prompt, sourceMessageId, sourceAttachments, interactionMode),
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
      workspaceId,
    );
  }

  hasRunningAgent(): boolean {
    return this.agents.hasRunningAgent();
  }

  /** Serialize message intake for this conversation, including async attachment commits. */
  async withMessageMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.messageMutationTail;
    let release!: () => void;
    this.messageMutationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  hasRunningOrQueued(): boolean {
    return this.hasRunningAgent() || this.runManager.hasQueuedRuns();
  }

  interrupt(): { cancelledQueuedRunIds: string[]; cancellingRunningRunIds: string[] } {
    return this.runManager.interruptAll();
  }

  pendingPermissions(): PendingPermission[] {
    return this.agents.pendingPermissions();
  }

  pendingElicitations(): PendingElicitation[] {
    return this.agents.pendingElicitations();
  }

  /** 各员工 runtime 会话当前通告的斜杠命令（issue #160）。 */
  availableCommands(): Record<AgentId, readonly AgentCommand[]> {
    return this.agents.availableCommands();
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
    const newAgents = new AgentRegistry(activeProfiles, eventBus, sessionStore, conversationId, undefined, this.options.modelState, this.options.workspaceId);
    newAgents.startAll();

    this._profiles = profiles.filter((profile) => !profile.internal);

    const agentIds = newAgents.ids();

    const self = this;

    const newRunManager = new RunManager({
      conversationId,
      workspaceId: this.options.workspaceId,
      agents: newAgents,
      messages: this.messages,
      eventBus,
      buildPrompt: (agentId, prompt, sourceMessageId, sourceAttachments, interactionMode) =>
        self.buildRuntimePrompt(agentId, prompt, sourceMessageId, sourceAttachments, interactionMode),
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
      this.options.workspaceId,
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

  supervisorConfig(): SupervisorConfig | undefined {
    return this._supervisorConfig;
  }

  /**
   * 切换会话交互模式。只影响下一条用户消息：运行中/排队任务及其后续链沿用
   * 各自的模式快照，不因切换而取消或改变行为。
   *
   * 监工策略：一旦配置过监工，其会话保持注册——切换到普通/简单协作不删除其
   * 持久化 session（再次开启复杂协作时原样恢复），且仍在执行复杂协作链完成时
   * 仍可触发监工收尾（由 ChannelWatch 按消息模式快照门控）。
   */
  setInteractionMode(mode: InteractionMode, runtime?: AgentRuntimeKind): void {
    if (mode === "supervised") {
      const selectedRuntime = runtime ?? this._supervisorConfig?.runtime;
      if (!selectedRuntime) throw new Error("A runtime is required to enable supervised collaboration.");
      if (!this.agents.has(INTERNAL_SUPERVISOR_ID) || this._supervisorConfig?.runtime !== selectedRuntime) {
        // 模型偏好按 runtime 归属，跨运行时即失效，重建时不保留。
        const model = this._supervisorConfig?.model?.runtimeKind === selectedRuntime
          ? this._supervisorConfig.model
          : undefined;
        this.applySupervisorConfig(model ? { runtime: selectedRuntime, model } : { runtime: selectedRuntime });
      }
    }
    // direct/collaborative：保留监工注册与配置（不取消其运行、不清 session）。
    this._interactionMode = mode;
    this.options.onConversationPatch?.({
      interactionMode: mode,
      ...(mode === "supervised" && this._supervisorConfig
        ? { supervisorConfig: this._supervisorConfig }
        : {}),
    });
    this.rebuildCoordinationLayer();
  }

  /**
   * 更新监工的运行时与模型偏好（issue #153）。
   *
   * - 运行时变化：这是对监工自身的重建操作——取消其排队/运行中的检查，移除并
   *   按新配置重建 session。普通员工与历史消息不受影响。
   * - 仅模型变化：既不取消任务也不重建会话，只更新会话内的首选模型，
   *   新偏好从监工的下一次运行开始生效。
   *
   * 开关复杂协作只影响下一条消息，因此本方法可在任意模式下调用。
   */
  setSupervisorConfig(config: SupervisorConfig): void {
    if (!this.agents.has(INTERNAL_SUPERVISOR_ID) || this._supervisorConfig?.runtime !== config.runtime) {
      this.applySupervisorConfig(config);
    } else {
      // 仅模型变化：偏好与当前 runtime 不匹配时不应用（value ID 不跨 runtime 通用）。
      this.agents.updatePreferredModel(
        INTERNAL_SUPERVISOR_ID,
        config.model?.runtimeKind === config.runtime ? config.model?.preferredModelId : undefined,
      );
      this._supervisorConfig = config;
    }
    this.options.onConversationPatch?.({ supervisorConfig: config });
    this.rebuildCoordinationLayer();
  }

  /** 重建监工会话：先取消其排队/运行中的检查，再按新配置注册。 */
  private applySupervisorConfig(config: SupervisorConfig): void {
    this.runManager.cancelAgentRuns(INTERNAL_SUPERVISOR_ID);
    this.agents.remove(INTERNAL_SUPERVISOR_ID);
    this.agents.add(createSupervisorProfile(this.cwd(), config));
    this._supervisorConfig = config;
  }

  private buildRuntimePrompt(
    agentId: AgentId,
    prompt: string,
    sourceMessageId?: string,
    sourceAttachments?: MessageAttachment[],
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
      attachments: sourceAttachments,
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
    // 监工注册条件是"配置过监工"而非当前模式：切换到普通/简单协作
    // 后，仍在执行的复杂协作链仍可能需要监工检查，且其 session 需要保持可恢复。
    if (!this._supervisorConfig) return [...normalProfiles];
    return [...normalProfiles, createSupervisorProfile(this.cwdFrom(profiles), this._supervisorConfig)];
  }

  private cwdFrom(profiles: readonly AgentProfile[]): string {
    return profiles.find((profile) => !profile.internal)?.cwd ?? process.cwd();
  }

  private channelProfiles(profiles = this._profiles): AgentProfile[] {
    if (!this._supervisorConfig) return [...profiles];
    return profiles.some((profile) => profile.id === INTERNAL_SUPERVISOR_ID)
      ? [...profiles]
      : [...profiles, createSupervisorProfile(this.cwdFrom(profiles), this._supervisorConfig)];
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
      this.options.workspaceId,
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
