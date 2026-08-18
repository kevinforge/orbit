import type { AgentId, AgentProfile, ChatMessage, InteractionMode, MessageRouteState } from "../shared/types.ts";
import { routeMention } from "./mention-router.ts";

export type MessageRouterOptions = {
  availableAgents: readonly AgentProfile[];
  maxRouteDepth: number;
  /** 当前会话的 interaction mode（只影响新消息；进行中的链使用消息自身的模式快照）。 */
  getInteractionMode: () => InteractionMode;
  /** 普通对话模式下最近一位直接对话员工（无）。 */
  getLastDirectAgentId?: () => AgentId | undefined;
  /** 普通对话路由成功后记录目标员工。 */
  setLastDirectAgentId?: (agentId: AgentId) => void;
  createSystemMessage: (content: string, parentMessageId?: string) => ChatMessage;
  startAgentRun: (agentId: AgentId, prompt: string, sourceMessage: ChatMessage) => void;
  markMessageRouted: (messageId: string, routeState: MessageRouteState) => void;
};

const DIRECT_MULTI_ASSIGNMENT_HINT = "普通对话一次只能指派一位数字员工。请只保留一位 @数字员工名:，或切换到简单协作/复杂协作模式。";
const DIRECT_NO_TARGET_HINT = "请先 @一位数字员工开始对话。";
const COLLABORATIVE_UNASSIGNED_HINT = "请先 @一位数字员工发起协作。";

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

    // 模式取值：用户消息使用发送时的模式快照（缺失时回退当前模式）；
    // 员工回复继承其源链的模式快照，执行中切换全局模式不影响原链。
    const mode: InteractionMode = message.interactionMode ?? this.options.getInteractionMode();

    // 普通对话：员工回复中的指派标记只作为普通文本展示，绝不触发后续路由。
    if (mode === "direct" && message.kind === "agent") {
      this.options.markMessageRouted(message.id, "ignored");
      return;
    }

    const senderAgentId = message.kind === "agent" ? message.agentId : undefined;
    const result = routeMention(message.content, this.options.availableAgents, senderAgentId);

    switch (result.kind) {
      case "none": {
        if (message.kind === "user") {
          if (mode === "direct") {
            // 普通对话：无 @ 的用户消息继续路由给上一位直接对话员工
            const lastAgentId = this.options.getLastDirectAgentId?.();
            const lastProfile = lastAgentId
              ? this.options.availableAgents.find((profile) => profile.id === lastAgentId)
              : undefined;
            if (lastProfile) {
              this.routeAssignments(message, [lastProfile.id], mode);
              return;
            }
            this.options.createSystemMessage(DIRECT_NO_TARGET_HINT, message.id);
            this.options.markMessageRouted(message.id, "blocked");
            return;
          }
          if (mode === "collaborative") {
            this.options.createSystemMessage(COLLABORATIVE_UNASSIGNED_HINT, message.id);
          }
          // 复杂协作：无 @ 的用户消息由 ChannelWatchService 触发监工处理，这里不再提示。
        }
        this.options.markMessageRouted(message.id, "ignored");
        break;
      }

      case "self":
      case "empty_assignment":
        this.options.createSystemMessage(result.message, message.id);
        this.options.markMessageRouted(message.id, "blocked");
        break;

      case "assignments": {
        // 普通对话：一条消息只能指定一位员工
        if (mode === "direct" && message.kind === "user" && result.agentIds.length > 1) {
          this.options.createSystemMessage(DIRECT_MULTI_ASSIGNMENT_HINT, message.id);
          this.options.markMessageRouted(message.id, "blocked");
          return;
        }

        const nextDepth = (message.routeDepth ?? 0) + 1;
        if (nextDepth > this.options.maxRouteDepth) {
          this.options.createSystemMessage(
            `This collaboration chain has reached the maximum routing depth (${nextDepth}/${this.options.maxRouteDepth}). Please decide the next step manually.`,
            message.id,
          );
          this.options.markMessageRouted(message.id, "blocked");
          break;
        }

        this.routeAssignments(message, result.agentIds, mode);
        break;
      }
    }
  }

  private routeAssignments(message: ChatMessage, agentIds: readonly AgentId[], mode: InteractionMode): void {
    this.options.markMessageRouted(message.id, "routed");
    for (const agentId of agentIds) {
      if (mode === "direct" && message.kind === "user") {
        this.options.setLastDirectAgentId?.(agentId);
      }
      this.options.startAgentRun(agentId, message.content.trim(), message);
    }
  }
}
