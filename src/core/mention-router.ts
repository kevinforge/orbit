import type { AgentId } from "../shared/types.ts";

export type MentionRouteResult =
  | { kind: "assignments"; agentIds: AgentId[]; prompt: string }
  | { kind: "empty_assignment"; agentId: AgentId; message: string }
  | { kind: "none"; message: string }
  | { kind: "self"; message: string };

type AssignmentMarker = {
  agentName: string;
  start: number;
  end: number;
};

export const assignmentPattern = /@([A-Za-z0-9_-]+)\s*(?::|：)/g;

export function routeMention(
  content: string,
  availableAgents: readonly AgentId[],
  senderAgentId?: AgentId,
): MentionRouteResult {
  const rawAssignments = Array.from(content.matchAll(assignmentPattern), (match): AssignmentMarker => {
    const start = match.index ?? 0;
    return {
      agentName: match[1],
      start,
      end: start + match[0].length,
    };
  });

  if (rawAssignments.length === 0) {
    return {
      kind: "none",
      message: `Use ${formatAssignmentList(availableAgents)} to assign work to an agent.`,
    };
  }

  // Check @all: markers for empty task content before expansion
  for (const assignment of rawAssignments) {
    if (assignment.agentName.toLowerCase() !== "all") continue;
    const nextRawEnd = findNextMarkerEnd(assignment.end, rawAssignments);
    const taskText = content.slice(assignment.end, nextRawEnd).trim();
    if (!taskText) {
      return {
        kind: "empty_assignment",
        agentId: "all" as AgentId,
        message: "Add task content after @all:.",
      };
    }
  }

  // Expand @all: into individual agent assignments
  const expandedAssignments: AssignmentMarker[] = [];
  let hasAllMarker = false;

  for (const assignment of rawAssignments) {
    if (assignment.agentName.toLowerCase() === "all") {
      hasAllMarker = true;
      for (const agentId of availableAgents) {
        expandedAssignments.push({
          agentName: agentId,
          start: assignment.start,
          end: assignment.end,
        });
      }
    } else {
      expandedAssignments.push(assignment);
    }
  }

  // Filter to known agents and exclude sender self-assignments
  const knownAssignments = expandedAssignments
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

  // Check for empty assignments on raw known markers before dedup.
  // This ensures duplicate markers like "@agent1: @agent1: task" correctly
  // block on the first empty marker, and "@all: review @agent1:" blocks
  // on the explicit empty @agent1:.
  for (const assignment of knownAssignments) {
    // Skip empty-check for markers that originated from @all: expansion
    // (they all share the same start/end from the @all marker)
    if (hasAllMarker && rawAssignments.some((raw) => raw.agentName.toLowerCase() === "all" && raw.start === assignment.start)) {
      continue;
    }

    const nextEnd = findNextMarkerEnd(assignment.end, knownAssignments);
    const taskText = content.slice(assignment.end, nextEnd).trim();
    if (!taskText) {
      return {
        kind: "empty_assignment",
        agentId: assignment.agentId,
        message: `Add task content after @${assignment.agentId}:.`,
      };
    }
  }

  // Deduplicate by agentId while preserving order
  const seen = new Set<AgentId>();
  const dedupedAssignments = knownAssignments.filter((assignment) => {
    if (seen.has(assignment.agentId)) return false;
    seen.add(assignment.agentId);
    return true;
  });

  return {
    kind: "assignments",
    agentIds: dedupedAssignments.map((assignment) => assignment.agentId),
    prompt: content.trim(),
  };
}

/**
 * Find the start position of the next assignment marker after the given position,
 * or return the content length if there is no next marker.
 */
function findNextMarkerEnd(afterEnd: number, assignments: Array<{ start: number }>): number {
  let next = Infinity;
  for (const assignment of assignments) {
    if (assignment.start > afterEnd && assignment.start < next) {
      next = assignment.start;
    }
  }
  return next === Infinity ? Infinity : next;
}

function isAgentId(value: string, availableAgents: readonly AgentId[]): value is AgentId {
  return availableAgents.includes(value as AgentId);
}

function formatAssignmentList(agentIds: readonly AgentId[], separator = " or "): string {
  return agentIds.map((agentId) => `@${agentId}:`).join(separator);
}
