import path from "node:path";

import type { AgentConfigStore } from "../core/agent-config-store.ts";
import type { ConversationStore } from "../core/conversation-store.ts";
import { MessageStore } from "../core/message-store.ts";
import type { WorkspaceStore } from "../core/workspace-store.ts";
import { buildWorkAnalysis, workAnalysisSinceMs } from "../core/work-analysis.ts";
import type { WorkAnalysis } from "../shared/types.ts";

export function buildWorkspaceWorkAnalysis(options: {
  workspaceId: string;
  days: number;
  workspaceStore: WorkspaceStore;
  conversationStore: ConversationStore;
  agentConfigStore: AgentConfigStore;
  now?: Date;
}): WorkAnalysis {
  const now = options.now ?? new Date();
  // Read only shards overlapping the analysis window per conversation, instead of
  // paging through every conversation's full history. Inactive conversations
  // (no shard in the window) read zero message shards — only their manifest.
  const sinceMs = workAnalysisSinceMs(now, options.days);
  const conversations = options.conversationStore.list(options.workspaceId).map((conversation) => {
    const messagesPath = path.join(
      options.workspaceStore.channelsDir(options.workspaceId, conversation.id),
      "messages.json",
    );
    return {
      conversation,
      messages: new MessageStore(messagesPath, { historyRead: true }).historySince(sinceMs),
    };
  });
  const agentLabels = new Map(
    options.agentConfigStore.load(options.workspaceId).map((config) => [config.id, config.name]),
  );

  return buildWorkAnalysis({
    workspaceId: options.workspaceId,
    conversations,
    agentLabels,
    days: options.days,
    now,
  });
}
