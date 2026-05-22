import type { AgentId, ChatMessage, MessageRouteState } from "../shared/types.ts";
import { routeMention } from "./mention-router.ts";

export type ChannelRouterOptions = {
  availableAgents: readonly AgentId[];
  maxRouteDepth: number;
  createSystemMessage: (content: string, parentMessageId?: string) => ChatMessage;
  startAgentRun: (agentId: AgentId, prompt: string, sourceMessage: ChatMessage) => void;
  markMessageRouted: (messageId: string, routeState: MessageRouteState) => void;
};

export class ChannelRouter {
  private processedIds = new Set<string>();

  constructor(private options: ChannelRouterOptions) {}

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
          this.options.createSystemMessage(result.message);
        }
        this.options.markMessageRouted(message.id, "ignored");
        break;

      case "all_unsupported":
      case "multiple":
      case "unknown":
      case "self":
      case "empty_prompt":
        this.options.createSystemMessage(result.message, message.id);
        this.options.markMessageRouted(message.id, "blocked");
        break;

      case "single": {
        const nextDepth = (message.routeDepth ?? 0) + 1;
        if (nextDepth > this.options.maxRouteDepth) {
          this.options.createSystemMessage(
            "This collaboration chain has reached the maximum routing depth. Please decide the next step manually.",
            message.id,
          );
          this.options.markMessageRouted(message.id, "blocked");
          break;
        }
        this.options.markMessageRouted(message.id, "routed");
        this.options.startAgentRun(result.agentId, result.prompt, message);
        break;
      }
    }
  }
}
