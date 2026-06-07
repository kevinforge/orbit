import path from "node:path";

import { AgentRegistry } from "../core/agent-registry.ts";
import { buildAgentContext } from "../core/agent-context-builder.ts";
import { buildHistoryForAgent } from "../core/agent-history-builder.ts";
import { EventBus } from "../core/event-bus.ts";
import { MessageStore } from "../core/message-store.ts";
import { RunManager } from "../core/run-manager.ts";
import { SessionStore } from "../core/session-store.ts";
import { TerminalTranscriptStore } from "../core/terminal-transcript-store.ts";
import { WorkspaceStore } from "../core/workspace-store.ts";
import { MessageRouter } from "../core/message-router.ts";
import { ChannelWatchService } from "../core/channel-watch.ts";
import { hasActiveChannelWatchTriggers, type AgentId, type AgentProfile, type WorkspaceRuntimeConfig } from "../shared/types.ts";
import { DEFAULT_WORKSPACE_CONFIG } from "../shared/types.ts";

const MAX_ROUTE_DEPTH = 10;

export type ConversationContextOptions = {
  workspaceId: string;
  conversationId: string;
  profiles: readonly AgentProfile[];
  eventBus: EventBus;
  sessionStore: SessionStore;
  workspaceStore: WorkspaceStore;
  workspaceConfig?: WorkspaceRuntimeConfig;
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
  private readonly eventBus: EventBus;
  private readonly unsubscribe: () => void;

  constructor(private options: ConversationContextOptions) {
    const { workspaceId, conversationId, profiles, eventBus, sessionStore, workspaceStore } = options;
    // Store workspace config as mutable instance field so updateWorkspaceConfig()
    // can update it at runtime without recreating the context.
    this._workspaceConfig = options.workspaceConfig ?? structuredClone(DEFAULT_WORKSPACE_CONFIG);
    this._profiles = profiles;
    this.eventBus = eventBus;

    const messagesPath = path.join(
      workspaceStore.channelsDir(workspaceId, conversationId),
      "messages.json",
    );

    this.messages = new MessageStore(messagesPath);

    // 运行日志开关：根据 workspace 配置决定是否记录 agent 运行日志。
    // 如果关闭，不传递 transcriptsDir，TerminalTranscriptStore 将不会持久化日志。
    const transcriptsDir = this._workspaceConfig.enableRunLogs
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

    this.agents = new AgentRegistry(profiles, eventBus, sessionStore, conversationId);
    this.agents.startAll();

    const agentIds = this.agents.ids();

    const self = this;
    this.runManager = new RunManager({
      conversationId,
      agents: this.agents,
      messages: this.messages,
      eventBus,
      buildPrompt: (agentId: AgentId, prompt: string, sourceMessageId?: string, imagePaths?: string[]) => {
        const history = buildHistoryForAgent(agentId, self.messages.list(), { excludeMessageId: sourceMessageId });
        // Only inject <current-attachments> for Claude CLI (which doesn't support --image flag)
        // Codex CLI uses native --image parameter, so no prompt injection needed
        const agentProfile = profiles.find((p) => p.id === agentId);
        const shouldInjectImagePaths = imagePaths?.length && agentProfile?.runtime !== "codex";
        return buildAgentContext({
          agentId,
          profiles,
          agentMessage: prompt,
          history,
          workspaceConfig: self._workspaceConfig,
          imagePaths: shouldInjectImagePaths ? imagePaths : undefined,
        });
      },
      onRunCompleted: (message) => {
        self.messageRouter.process(message);
      },
    });

    const hasActiveSupervisor = profiles.some(
      (p) => p.role === "coordinator" && hasActiveChannelWatchTriggers(p.triggers),
    );

    this.messageRouter = new MessageRouter({
      availableAgents: agentIds,
      maxRouteDepth: MAX_ROUTE_DEPTH,
      hasActiveSupervisor,
      createSystemMessage: (content, parentMessageId) => {
        const msg = self.messages.add({ kind: "system", content, status: "done", parentMessageId });
        eventBus.publish({ type: "message.created", conversationId, message: msg });
        return msg;
      },
      startAgentRun: (agentId, prompt, sourceMessage) => {
        self.runManager.enqueue(agentId, prompt, sourceMessage);
      },
      markMessageRouted: (messageId, routeState) => {
        const updated = self.messages.markRouteState(messageId, routeState);
        if (updated) {
          eventBus.publish({ type: "message.updated", conversationId, message: updated });
        }
      },
    });

    this.channelWatch = new ChannelWatchService(
      conversationId,
      this.agents,
      this.runManager,
      this.messages,
      eventBus,
      profiles,
    );
  }

  hasRunningAgent(): boolean {
    return this.agents.states().some((s) => s.status === "running");
  }

  hasRunningOrQueued(): boolean {
    return this.hasRunningAgent() || this.runManager.hasQueuedRuns();
  }

  interrupt(): { cancelledQueuedRunIds: string[]; suppressedRunningRunIds: string[] } {
    return this.runManager.interruptCurrentChain();
  }

  refreshProfiles(profiles: readonly AgentProfile[]): void {
    this.channelWatch.dispose();
    this.agents.stopAll();
    this.runManager.dispose();

    const { workspaceId, conversationId, eventBus, sessionStore } = this.options;
    const newAgents = new AgentRegistry(profiles, eventBus, sessionStore, conversationId);
    newAgents.startAll();

    this._profiles = profiles;

    const agentIds = newAgents.ids();

    const self = this;

    const newRunManager = new RunManager({
      conversationId,
      agents: newAgents,
      messages: this.messages,
      eventBus,
      buildPrompt: (agentId: AgentId, prompt: string, sourceMessageId?: string, imagePaths?: string[]) => {
        const history = buildHistoryForAgent(agentId, self.messages.list(), { excludeMessageId: sourceMessageId });
        // Only inject <current-attachments> for Claude CLI (which doesn't support --image flag)
        // Codex CLI uses native --image parameter, so no prompt injection needed
        const agentProfile = profiles.find((p) => p.id === agentId);
        const shouldInjectImagePaths = imagePaths?.length && agentProfile?.runtime !== "codex";
        return buildAgentContext({
          agentId,
          profiles,
          agentMessage: prompt,
          history,
          workspaceConfig: self._workspaceConfig,
          imagePaths: shouldInjectImagePaths ? imagePaths : undefined,
        });
      },
      onRunCompleted: (message) => {
        self.messageRouter.process(message);
      },
    });

    const newHasSupervisor = profiles.some(
      (p) => p.role === "coordinator" && hasActiveChannelWatchTriggers(p.triggers),
    );

    const newMessageRouter = new MessageRouter({
      availableAgents: agentIds,
      maxRouteDepth: MAX_ROUTE_DEPTH,
      hasActiveSupervisor: newHasSupervisor,
      createSystemMessage: (content, parentMessageId) => {
        const msg = self.messages.add({ kind: "system", content, status: "done", parentMessageId });
        eventBus.publish({ type: "message.created", conversationId, message: msg });
        return msg;
      },
      startAgentRun: (agentId, prompt, sourceMessage) => {
        newRunManager.enqueue(agentId, prompt, sourceMessage);
      },
      markMessageRouted: (messageId, routeState) => {
        const updated = self.messages.markRouteState(messageId, routeState);
        if (updated) {
          eventBus.publish({ type: "message.updated", conversationId, message: updated });
        }
      },
    });

    const newChannelWatch = new ChannelWatchService(
      conversationId,
      newAgents,
      newRunManager,
      this.messages,
      eventBus,
      profiles,
    );

    // Replace mutable fields via Object.assign (intentional hot-swap)
    Object.assign(this, {
      agents: newAgents,
      runManager: newRunManager,
      messageRouter: newMessageRouter,
      channelWatch: newChannelWatch,
    });
  }

  updateWorkspaceConfig(config: WorkspaceRuntimeConfig): void {
    this._workspaceConfig = config;
    this.options = { ...this.options, workspaceConfig: config };
  }

  dispose(): void {
    this.channelWatch.dispose();
    this.agents.stopAll();
    this.runManager.dispose();
    this.transcripts.dispose();
    this.unsubscribe();
  }
}
