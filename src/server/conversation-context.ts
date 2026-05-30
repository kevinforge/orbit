import path from "node:path";

import { AgentRegistry } from "../core/agent-registry.ts";
import { buildChannelContext } from "../core/channel-context-builder.ts";
import { buildHistoryForAgent } from "../core/channel-history.ts";
import { EventBus } from "../core/event-bus.ts";
import { MessageStore } from "../core/message-store.ts";
import { RunManager } from "../core/run-manager.ts";
import { SessionStore } from "../core/session-store.ts";
import { TerminalTranscriptStore } from "../core/terminal-transcript-store.ts";
import { WorkspaceStore } from "../core/workspace-store.ts";
import { ChannelRouter } from "../core/channel-router.ts";
import type { AgentId, AgentProfile, RuntimeEvent } from "../shared/types.ts";

const MAX_ROUTE_DEPTH = 5;
const CHANNEL_ID = "default";

export type ConversationContextOptions = {
  workspaceId: string;
  conversationId: string;
  profiles: readonly AgentProfile[];
  eventBus: EventBus;
  sessionStore: SessionStore;
  workspaceStore: WorkspaceStore;
  sseHub: { publish: (event: RuntimeEvent) => void };
};

export class ConversationContext {
  readonly messages: MessageStore;
  readonly transcripts: TerminalTranscriptStore;
  readonly agents: AgentRegistry;
  readonly runManager: RunManager;
  readonly channelRouter: ChannelRouter;

  private _profiles: readonly AgentProfile[];
  private readonly eventBus: EventBus;
  private readonly sseHub: { publish: (event: RuntimeEvent) => void };
  private readonly unsubscribe: () => void;

  constructor(private readonly options: ConversationContextOptions) {
    const { workspaceId, conversationId, profiles, eventBus, sessionStore, workspaceStore, sseHub } = options;
    this._profiles = profiles;
    this.eventBus = eventBus;
    this.sseHub = sseHub;

    const messagesPath = path.join(
      workspaceStore.channelsDir(workspaceId, CHANNEL_ID, conversationId),
      "messages.json",
    );
    const transcriptsDir = workspaceStore.transcriptsDir(workspaceId, CHANNEL_ID, conversationId);

    this.messages = new MessageStore(messagesPath);
    this.transcripts = new TerminalTranscriptStore(transcriptsDir);

    this.unsubscribe = eventBus.subscribe((event) => {
      if ((event as { type: string }).type === "terminal.chunk") {
        const e = event as { agentId: string; text: string };
        this.transcripts.append(e.agentId, e.text);
      }
      sseHub.publish(event);
    });

    this.agents = new AgentRegistry(profiles, eventBus, sessionStore, CHANNEL_ID, conversationId);
    this.agents.startAll();

    const agentIds = this.agents.ids();

    this.runManager = new RunManager({
      agents: this.agents,
      messages: this.messages,
      eventBus,
      buildPrompt: (agentId: AgentId, prompt: string) => {
        const history = buildHistoryForAgent(agentId, this.messages.list());
        return buildChannelContext({ agentId, profiles, channelMessage: prompt, history });
      },
      onRunCompleted: (message) => {
        this.channelRouter.process(message);
      },
    });

    this.channelRouter = new ChannelRouter({
      availableAgents: agentIds,
      maxRouteDepth: MAX_ROUTE_DEPTH,
      createSystemMessage: (content, parentMessageId) => {
        const msg = this.messages.add({ kind: "system", content, status: "done", parentMessageId });
        eventBus.publish({ type: "message.created", message: msg });
        return msg;
      },
      startAgentRun: (agentId, prompt, sourceMessage) => {
        this.runManager.enqueue(agentId, prompt, sourceMessage);
      },
      markMessageRouted: (messageId, routeState) => {
        this.messages.markRouteState(messageId, routeState);
      },
    });
  }

  hasRunningAgent(): boolean {
    return this.agents.states().some((s) => s.status === "running");
  }

  refreshProfiles(profiles: readonly AgentProfile[]): void {
    this.agents.stopAll();
    this.runManager.dispose();

    const { workspaceId, conversationId, eventBus, sessionStore } = this.options;
    const newAgents = new AgentRegistry(profiles, eventBus, sessionStore, CHANNEL_ID, conversationId);
    newAgents.startAll();

    this._profiles = profiles;

    const agentIds = newAgents.ids();

    const self = this;

    const newRunManager = new RunManager({
      agents: newAgents,
      messages: this.messages,
      eventBus,
      buildPrompt: (agentId: AgentId, prompt: string) => {
        const history = buildHistoryForAgent(agentId, self.messages.list());
        return buildChannelContext({ agentId, profiles, channelMessage: prompt, history });
      },
      onRunCompleted: (message) => {
        self.channelRouter.process(message);
      },
    });

    const newChannelRouter = new ChannelRouter({
      availableAgents: agentIds,
      maxRouteDepth: MAX_ROUTE_DEPTH,
      createSystemMessage: (content, parentMessageId) => {
        const msg = self.messages.add({ kind: "system", content, status: "done", parentMessageId });
        eventBus.publish({ type: "message.created", message: msg });
        return msg;
      },
      startAgentRun: (agentId, prompt, sourceMessage) => {
        newRunManager.enqueue(agentId, prompt, sourceMessage);
      },
      markMessageRouted: (messageId, routeState) => {
        self.messages.markRouteState(messageId, routeState);
      },
    });

    // Replace readonly fields via Object.assign (intentional hot-swap)
    Object.assign(this, { agents: newAgents, runManager: newRunManager, channelRouter: newChannelRouter });
  }

  dispose(): void {
    this.agents.stopAll();
    this.runManager.dispose();
    this.transcripts.dispose();
    this.unsubscribe();
  }
}
