import type { AgentId, ChatMessage } from "../shared/types.ts";
import type { AgentHistoryEntry } from "./agent-context-builder.ts";

const MAX_HISTORY_CHARS = 12000;
const RECENT_UNTRUNCATED_COUNT = 6;
const OLDER_ENTRY_MAX_CHARS = 500;

export { MAX_HISTORY_CHARS, OLDER_ENTRY_MAX_CHARS, RECENT_UNTRUNCATED_COUNT };

export type BuildHistoryOptions = {
  /** Exclude this specific message (typically the current run's source message) */
  excludeMessageId?: string;
};

export function buildHistoryForAgent(agentId: AgentId, allMessages: ChatMessage[], options?: BuildHistoryOptions): AgentHistoryEntry[] {
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
    // Exclude only the specific source message (already injected as <current-task>),
    // rather than all routed agent messages which may contain valuable context.
    if (options?.excludeMessageId && msg.id === options.excludeMessageId) continue;
    eligible.push(msg);
  }

  // Split into older and recent groups.
  // Recent = last N entries, kept untruncated, processed FIRST for budget priority.
  // Older = everything before, truncated with marker, fills remaining budget.
  const recentStart = Math.max(0, eligible.length - RECENT_UNTRUNCATED_COUNT);
  const older = eligible.slice(0, recentStart);
  const recent = eligible.slice(recentStart);

  // Phase 1: Reserve budget for recent entries (newest → oldest within recent)
  // These are the most critical — user assignments, latest agent feedback.
  const recentEntries: AgentHistoryEntry[] = [];
  let recentChars = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const msg = recent[i];
    const sender = msg.kind === "user" ? "user" : (msg.agentId ?? "agent");
    if (recentChars + msg.content.length > MAX_HISTORY_CHARS) break;
    recentEntries.unshift({ sender, content: msg.content });
    recentChars += msg.content.length;
  }

  // Phase 2: Fill remaining budget with older entries (newest → oldest)
  const remainingBudget = MAX_HISTORY_CHARS - recentChars;
  const olderEntries: AgentHistoryEntry[] = [];
  let olderChars = 0;
  for (let i = older.length - 1; i >= 0; i--) {
    const msg = older[i];
    const sender = msg.kind === "user" ? "user" : (msg.agentId ?? "agent");
    let text: string;
    if (msg.content.length <= OLDER_ENTRY_MAX_CHARS) {
      text = msg.content;
    } else {
      text = msg.content.slice(0, OLDER_ENTRY_MAX_CHARS) + `\n[truncated: original message was ${msg.content.length} chars]`;
    }

    if (olderChars + text.length > remainingBudget) break;
    olderEntries.unshift({ sender, content: text });
    olderChars += text.length;
  }

  return [...olderEntries, ...recentEntries];
}
