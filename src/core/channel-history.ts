import type { AgentId, ChatMessage } from "../shared/types.ts";
import type { ChannelHistoryEntry } from "./channel-context-builder.ts";

const MAX_HISTORY_CHARS = 2000;
const MAX_ENTRY_CHARS = 500;

export { MAX_HISTORY_CHARS, MAX_ENTRY_CHARS };

export function buildHistoryForAgent(agentId: AgentId, allMessages: ChatMessage[]): ChannelHistoryEntry[] {
  let cutoffIndex = -1;
  for (let i = allMessages.length - 1; i >= 0; i--) {
    const msg = allMessages[i];
    if (msg.kind === "agent" && msg.agentId === agentId && msg.status === "done") {
      cutoffIndex = i;
      break;
    }
  }

  const entries: ChannelHistoryEntry[] = [];
  let totalChars = 0;

  for (let i = allMessages.length - 1; i >= cutoffIndex + 1; i--) {
    const msg = allMessages[i];
    if (msg.kind === "system") continue;
    if (msg.status === "running") continue;
    if (msg.kind === "agent" && msg.routeState === "routed") continue;

    const sender = msg.kind === "user" ? "user" : (msg.agentId ?? "agent");
    const text = msg.content.slice(0, MAX_ENTRY_CHARS);
    if (totalChars + text.length > MAX_HISTORY_CHARS) break;

    entries.unshift({ sender, content: text });
    totalChars += text.length;
  }

  return entries;
}
