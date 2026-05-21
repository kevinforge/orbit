import type { AgentId } from "../shared/types.ts";

export type RouteResult =
  | { ok: true; agentId: AgentId; prompt: string }
  | {
      ok: false;
      reason: "missing_mention" | "unknown_agent" | "multiple_mentions";
      message: string;
    };

const mentionPattern = /(^|\s)@([A-Za-z0-9_-]+)/g;

export function routeMention(content: string, availableAgents: readonly AgentId[]): RouteResult {
  const mentions = Array.from(content.matchAll(mentionPattern), (match) => match[2]);

  if (mentions.length === 0) {
    return {
      ok: false,
      reason: "missing_mention",
      message: `请使用 ${formatAgentList(availableAgents)} 指定 Agent`,
    };
  }

  if (mentions.length > 1) {
    return {
      ok: false,
      reason: "multiple_mentions",
      message: "一次只支持投递给一个 Agent",
    };
  }

  const [mentionedAgent] = mentions;
  if (!isAgentId(mentionedAgent, availableAgents)) {
    return {
      ok: false,
      reason: "unknown_agent",
      message: `未知 Agent：${mentionedAgent}。可用 Agent：${formatAgentList(availableAgents, "、")}`,
    };
  }

  return {
    ok: true,
    agentId: mentionedAgent,
    prompt: content.replace(new RegExp(`(^|\\s)@${escapeRegExp(mentionedAgent)}\\b`), " ").trim(),
  };
}

function isAgentId(value: string, availableAgents: readonly AgentId[]): value is AgentId {
  return availableAgents.includes(value as AgentId);
}

function formatAgentList(agentIds: readonly AgentId[], separator = " 或 "): string {
  return agentIds.map((agentId) => `@${agentId}`).join(separator);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
