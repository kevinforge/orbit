import type { AgentId, AgentProfile } from "../shared/types.ts";

export type MentionRouteResult =
  | { kind: "assignments"; agentIds: AgentId[]; prompt: string }
  | { kind: "empty_assignment"; agentId: AgentId; message: string }
  | { kind: "none"; message: string }
  | { kind: "self"; message: string };

type AssignmentMarker = { name: string; start: number; end: number; agentId?: AgentId };

export const assignmentPattern = /@([^\s@:]+)\s*(?::|：)/gu;

export function routeMention(content: string, availableAgents: readonly AgentProfile[], senderAgentId?: AgentId): MentionRouteResult {
  const rawAssignments = Array.from(content.matchAll(assignmentPattern), (match): AssignmentMarker => {
    const start = match.index ?? 0;
    return { name: match[1] ?? "", start, end: start + match[0].length };
  });
  if (rawAssignments.length === 0) return { kind: "none", message: `Use ${formatAssignmentList(availableAgents)} to assign work to an employee.` };

  for (const assignment of rawAssignments) {
    if (assignment.name.toLocaleLowerCase() === "all" && !content.slice(assignment.end, findNextMarkerEnd(assignment.end, rawAssignments)).trim()) {
      return { kind: "empty_assignment", agentId: "all", message: "Add task content after @all:." };
    }
  }

  const byName = new Map(availableAgents.map((agent) => [agent.name.toLocaleLowerCase(), agent]));
  const expanded: AssignmentMarker[] = [];
  for (const assignment of rawAssignments) {
    if (assignment.name.toLocaleLowerCase() === "all") {
      for (const agent of availableAgents) expanded.push({ ...assignment, name: agent.name, agentId: agent.id });
    } else {
      const agent = byName.get(assignment.name.toLocaleLowerCase());
      if (agent) expanded.push({ ...assignment, agentId: agent.id });
    }
  }
  const known = expanded.filter((assignment) => assignment.agentId && assignment.agentId !== senderAgentId) as Array<AssignmentMarker & { agentId: AgentId }>;
  if (known.length === 0) return { kind: "none", message: `Use ${formatAssignmentList(availableAgents)} to assign work to an employee.` };

  for (const assignment of known) {
    if (rawAssignments.some((raw) => raw.name.toLocaleLowerCase() === "all" && raw.start === assignment.start)) continue;
    if (!content.slice(assignment.end, findNextMarkerEnd(assignment.end, known)).trim()) {
      return { kind: "empty_assignment", agentId: assignment.agentId, message: `Add task content after @${assignment.name}:.` };
    }
  }

  const seen = new Set<AgentId>();
  return { kind: "assignments", agentIds: known.filter((assignment) => !seen.has(assignment.agentId) && seen.add(assignment.agentId)).map((assignment) => assignment.agentId), prompt: content.trim() };
}

function findNextMarkerEnd(afterEnd: number, assignments: Array<{ start: number }>): number {
  return assignments.find((assignment) => assignment.start > afterEnd)?.start ?? Infinity;
}

function formatAssignmentList(agents: readonly AgentProfile[]): string {
  return agents.map((agent) => `@${agent.name}:`).join(" or ");
}
