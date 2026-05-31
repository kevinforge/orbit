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
import type { AgentId, AgentProfile } from "../shared/types.ts";

const MAX_ROUTE_DEPTH = 5;

export type ConversationContextOptions = {
  workspaceId: string;
  conversationId: string;
  profiles: readonly AgentProfile[];
  eventBus: EventBus;
  sessionStore: SessionStore;
  workspaceStore: WorkspaceStore;
};

export class ConversationContext {
  readonly messages: MessageStore;
  readonly transcripts: TerminalTranscriptStore;
  readonly agents: AgentRegistry;
  readonly runManager: RunManager;
  readonly messageRouter: MessageRouter;

  private _profiles: readonly AgentProfile[];
  private readonly eventBus: EventBus;
  private readonly unsubscribe: () => void;

  constructor(private readonly options: ConversationContextOptions) {
    const { workspaceId, conversationId, profiles, eventBus, sessionStore, workspaceStore } = options;
    this._profiles = profiles;
    this.eventBus = eventBus;

    const messagesPath = path.join(
      workspaceStore.channelsDir(workspaceId, conversationId),
      "messages.json",
    );
    const transcriptsDir = workspaceStore.transcriptsDir(workspaceId, conversationId);

    this.messages = new MessageStore(messagesPath);
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

    this.runManager = new RunManager({
      conversationId,
      agents: this.agents,
      messages: this.messages,
      eventBus,
      buildPrompt: (agentId: AgentId, prompt: string) => {
        const history = buildHistoryForAgent(agentId, this.messages.list());
        return buildAgentContext({ agentId, profiles, agentMessage: prompt, history });
      },
      onRunCompleted: (message) => {
        this.messageRouter.process(message);
      },
    });

    this.messageRouter = new MessageRouter({
      availableAgents: agentIds,
      maxRouteDepth: MAX_ROUTE_DEPTH,
      createSystemMessage: (content, parentMessageId) => {
        const msg = this.messages.add({ kind: "system", content, status: "done", parentMessageId });
        eventBus.publish({ type: "message.created", conversationId, message: msg });
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
      buildPrompt: (agentId: AgentId, prompt: string) => {
        const history = buildHistoryForAgent(agentId, self.messages.list());
        return buildAgentContext({ agentId, profiles, agentMessage: prompt, history });
      },
      onRunCompleted: (message) => {
        self.messageRouter.process(message);
      },
    });

    const newMessageRouter = new MessageRouter({
      availableAgents: agentIds,
      maxRouteDepth: MAX_ROUTE_DEPTH,
      createSystemMessage: (content, parentMessageId) => {
        const msg = self.messages.add({ kind: "system", content, status: "done", parentMessageId });
        eventBus.publish({ type: "message.created", conversationId, message: msg });
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
    Object.assign(this, { agents: newAgents, runManager: newRunManager, messageRouter: newMessageRouter });
  }

  dispose(): void {
    this.agents.stopAll();
    this.runManager.dispose();
    this.transcripts.dispose();
    this.unsubscribe();
  }
}
