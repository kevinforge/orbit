import type { AgentId, ChatMessage, MessageRouteState } from "../shared/types.ts";
import { routeMention } from "./mention-router.ts";

export type MessageRouterOptions = {
  availableAgents: readonly AgentId[];
  maxRouteDepth: number;
  hasActiveSupervisor?: boolean;
  createSystemMessage: (content: string, parentMessageId?: string) => ChatMessage;
  startAgentRun: (agentId: AgentId, prompt: string, sourceMessage: ChatMessage) => void;
  markMessageRouted: (messageId: string, routeState: MessageRouteState) => void;
};

export class MessageRouter {
  private processedIds = new Set<string>();

  constructor(private options: MessageRouterOptions) {}

  setMaxRouteDepth(value: number): void {
    this.options = { ...this.options, maxRouteDepth: value };
  }

  get maxRouteDepth(): number {
    return this.options.maxRouteDepth;
  }

  process(message: ChatMessage): void {
    if (this.processedIds.has(message.id)) {
      return;
    }
    this.processedIds.add(message.id);

    if (message.routeState !== undefined && message.routeState !== "unprocessed") {
      return;
    }

    const senderAgentId = message.kind === "agent" ? message.agentId : undefined;
    const result = routeMention(message.content, this.options.availableAgents, senderAgentId);

    switch (result.kind) {
      case "none":
        if (message.kind === "user") {
          if (!this.options.hasActiveSupervisor) {
            this.options.createSystemMessage(result.message);
          }
        }
        this.options.markMessageRouted(message.id, "ignored");
        break;

      case "self":
      case "empty_assignment":
        this.options.createSystemMessage(result.message, message.id);
        this.options.markMessageRouted(message.id, "blocked");
        break;

      case "assignments": {
        const nextDepth = (message.routeDepth ?? 0) + 1;
        if (nextDepth > this.options.maxRouteDepth) {
          this.options.createSystemMessage(
            `This collaboration chain has reached the maximum routing depth (${nextDepth}/${this.options.maxRouteDepth}). Please decide the next step manually.`,
            message.id,
          );
          this.options.markMessageRouted(message.id, "blocked");
          break;
        }

        this.options.markMessageRouted(message.id, "routed");
        for (const agentId of result.agentIds) {
          this.options.startAgentRun(agentId, result.prompt, message);
        }
        break;
      }
    }
  }
}
