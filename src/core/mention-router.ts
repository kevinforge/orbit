import type { AgentId } from "../shared/types.ts";

export type MentionRouteResult =
  | { kind: "single"; agentId: AgentId; prompt: string }
  | { kind: "empty_prompt"; agentId: AgentId; message: string }
  | { kind: "none"; message: string }
  | { kind: "all_unsupported"; message: string }
  | { kind: "multiple"; message: string }
  | { kind: "unknown"; message: string }
  | { kind: "self"; message: string };

const mentionPattern = /(^|\s)@([A-Za-z0-9_-]+)/g;

export function routeMention(
  content: string,
  availableAgents: readonly AgentId[],
  senderAgentId?: AgentId,
): MentionRouteResult {
  const mentions = Array.from(content.matchAll(mentionPattern), (match) => match[2]);

  if (mentions.length === 0) {
    return {
      kind: "none",
      message: `Use ${formatAgentList(availableAgents)} to choose an agent.`,
    };
  }

  if (mentions.some((mention) => mention.toLowerCase() === "all")) {
    return {
      kind: "all_unsupported",
      message: "This version does not support @all. Choose @agent1 or @agent2.",
    };
  }

  const unknownMention = mentions.find((mention) => !isAgentId(mention, availableAgents));
  if (unknownMention) {
    return {
      kind: "unknown",
      message: `Unknown agent: @${unknownMention}. Available agents: ${formatAgentList(availableAgents, ", ")}.`,
    };
  }

  const knownMentions = mentions.filter((mention): mention is AgentId => isAgentId(mention, availableAgents));
  const targetMentions = senderAgentId ? knownMentions.filter((mention) => mention !== senderAgentId) : knownMentions;

  if (targetMentions.length === 0 && senderAgentId !== undefined) {
    return {
      kind: "self",
      message: "Agents cannot route work to themselves.",
    };
  }

  const uniqueTargets = Array.from(new Set(targetMentions));
  if (uniqueTargets.length > 1) {
    return {
      kind: "multiple",
      message: "This version supports routing to one agent at a time.",
    };
  }

  const [mentionedAgent] = uniqueTargets;
  if (senderAgentId !== undefined && mentionedAgent === senderAgentId) {
    return {
      kind: "self",
      message: "Agents cannot route work to themselves.",
    };
  }

  const prompt = content.replace(new RegExp(`(^|\\s)@${escapeRegExp(mentionedAgent)}\\b`), " ").trim();

  if (!prompt) {
    return {
      kind: "empty_prompt",
      agentId: mentionedAgent,
      message: "Add task content after the @agent mention.",
    };
  }

  return {
    kind: "single",
    agentId: mentionedAgent,
    prompt,
  };
}

function isAgentId(value: string, availableAgents: readonly AgentId[]): value is AgentId {
  return availableAgents.includes(value as AgentId);
}

function formatAgentList(agentIds: readonly AgentId[], separator = " or "): string {
  return agentIds.map((agentId) => `@${agentId}`).join(separator);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
