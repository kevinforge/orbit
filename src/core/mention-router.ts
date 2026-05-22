import type { AgentId } from "../shared/types.ts";

export type MentionRouteResult =
  | { kind: "assignments"; agentIds: AgentId[]; prompt: string }
  | { kind: "empty_assignment"; agentId: AgentId; message: string }
  | { kind: "none"; message: string }
  | { kind: "all_unsupported"; message: string }
  | { kind: "unknown"; message: string }
  | { kind: "self"; message: string };

type AssignmentMarker = {
  agentName: string;
  start: number;
  end: number;
};

const assignmentPattern = /@([A-Za-z0-9_-]+)\s*(?::|\uFF1A)/g;

export function routeMention(
  content: string,
  availableAgents: readonly AgentId[],
  senderAgentId?: AgentId,
): MentionRouteResult {
  const assignments = Array.from(content.matchAll(assignmentPattern), (match): AssignmentMarker => {
    const start = match.index ?? 0;
    return {
      agentName: match[1],
      start,
      end: start + match[0].length,
    };
  });

  if (assignments.length === 0) {
    return {
      kind: "none",
      message: `Use ${formatAssignmentList(availableAgents)} to assign work to an agent.`,
    };
  }

  if (assignments.some((assignment) => assignment.agentName.toLowerCase() === "all")) {
    return {
      kind: "all_unsupported",
      message: "This version does not support @all. Choose @agent1: or @agent2:.",
    };
  }

  const knownAssignments = assignments
    .filter((assignment) => isAgentId(assignment.agentName, availableAgents))
    .filter((assignment) => assignment.agentName !== senderAgentId)
    .map((assignment) => ({
      ...assignment,
      agentId: assignment.agentName as AgentId,
    }));

  if (knownAssignments.length === 0) {
    return {
      kind: "none",
      message: `Use ${formatAssignmentList(availableAgents)} to assign work to an agent.`,
    };
  }

  for (let index = 0; index < knownAssignments.length; index += 1) {
    const assignment = knownAssignments[index];
    const nextAssignment = knownAssignments[index + 1];
    const taskText = content.slice(assignment.end, nextAssignment?.start ?? content.length).trim();
    if (!taskText) {
      return {
        kind: "empty_assignment",
        agentId: assignment.agentId,
        message: `Add task content after @${assignment.agentId}:.`,
      };
    }
  }

  return {
    kind: "assignments",
    agentIds: Array.from(new Set(knownAssignments.map((assignment) => assignment.agentId))),
    prompt: content.trim(),
  };
}

function isAgentId(value: string, availableAgents: readonly AgentId[]): value is AgentId {
  return availableAgents.includes(value as AgentId);
}

function formatAssignmentList(agentIds: readonly AgentId[], separator = " or "): string {
  return agentIds.map((agentId) => `@${agentId}:`).join(separator);
}
