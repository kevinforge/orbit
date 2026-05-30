import type { AgentId, ChatMessage } from "../shared/types.ts";
import type { ChannelHistoryEntry } from "./channel-context-builder.ts";

const MAX_HISTORY_CHARS = 12000;
const RECENT_UNTRUNCATED_COUNT = 6;
const OLDER_ENTRY_MAX_CHARS = 500;

export { MAX_HISTORY_CHARS, OLDER_ENTRY_MAX_CHARS, RECENT_UNTRUNCATED_COUNT };

export function buildHistoryForAgent(agentId: AgentId, allMessages: ChatMessage[]): ChannelHistoryEntry[] {
  let cutoffIndex = -1;
  for (let i = allMessages.length - 1; i >= 0; i--) {
    const msg = allMessages[i];
    if (msg.kind === "agent" && msg.agentId === agentId && msg.status === "done") {
      cutoffIndex = i;
      break;
    }
  }

  // Collect eligible messages in chronological order (oldest → newest)
  const eligible: ChatMessage[] = [];
  for (let i = cutoffIndex + 1; i < allMessages.length; i++) {
    const msg = allMessages[i];
    if (msg.kind === "system") continue;
    if (msg.status === "running") continue;
    if (msg.kind === "agent" && msg.routeState === "routed") continue;
    eligible.push(msg);
  }

  // Split into older and recent groups.
  // Recent = last N entries, kept untruncated.
  // Older = everything before, truncated with marker if needed.
  const recentStart = Math.max(0, eligible.length - RECENT_UNTRUNCATED_COUNT);
  const older = eligible.slice(0, recentStart);
  const recent = eligible.slice(recentStart);

  const entries: ChannelHistoryEntry[] = [];
  let totalChars = 0;

  // Process older entries with truncation
  for (const msg of older) {
    const sender = msg.kind === "user" ? "user" : (msg.agentId ?? "agent");
    let text: string;
    if (msg.content.length <= OLDER_ENTRY_MAX_CHARS) {
      text = msg.content;
    } else {
      text = msg.content.slice(0, OLDER_ENTRY_MAX_CHARS) + `\n[truncated: original message was ${msg.content.length} chars]`;
    }

    if (totalChars + text.length > MAX_HISTORY_CHARS) break;
    entries.push({ sender, content: text });
    totalChars += text.length;
  }

  // Process recent entries — kept in full, but still respect total budget
  for (const msg of recent) {
    const sender = msg.kind === "user" ? "user" : (msg.agentId ?? "agent");
    const text = msg.content;

    if (totalChars + text.length > MAX_HISTORY_CHARS) break;
    entries.push({ sender, content: text });
    totalChars += text.length;
  }

  return entries;
}
