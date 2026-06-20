import path from "node:path";

import type { AgentConfigStore } from "../core/agent-config-store.ts";
import type { ConversationStore } from "../core/conversation-store.ts";
import { MessageStore } from "../core/message-store.ts";
import type { WorkspaceStore } from "../core/workspace-store.ts";
import { buildWorkAnalysis } from "../core/work-analysis.ts";
import type { ChatMessage, WorkAnalysis } from "../shared/types.ts";

export function buildWorkspaceWorkAnalysis(options: {
  workspaceId: string;
  days: number;
  workspaceStore: WorkspaceStore;
  conversationStore: ConversationStore;
  agentConfigStore: AgentConfigStore;
  now?: Date;
}): WorkAnalysis {
  const conversations = options.conversationStore.list(options.workspaceId).map((conversation) => {
    const messagesPath = path.join(
      options.workspaceStore.channelsDir(options.workspaceId, conversation.id),
      "messages.json",
    );
    return {
      conversation,
      messages: readAllMessages(new MessageStore(messagesPath)),
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
    now: options.now,
  });
}

function readAllMessages(store: MessageStore): ChatMessage[] {
  const pages: ChatMessage[][] = [];
  let cursor: string | null = null;
  const seenCursors = new Set<string>();

  while (true) {
    const page = store.listBefore(cursor, 500);
    pages.unshift(page.messages);
    if (!page.hasOlderMessages || !page.olderCursor || seenCursors.has(page.olderCursor)) break;
    seenCursors.add(page.olderCursor);
    cursor = page.olderCursor;
  }

  return pages.flat();
}
