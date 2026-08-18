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

  // @all 已移除：不再展开，也没有对应的员工，因此 @all: 会被当作未知名称忽略。
  const byName = new Map(availableAgents.map((agent) => [agent.name.toLocaleLowerCase(), agent]));
  const known = rawAssignments
    .map((assignment) => {
      const agent = byName.get(assignment.name.toLocaleLowerCase());
      return agent && agent.id !== senderAgentId
        ? { ...assignment, agentId: agent.id }
        : null;
    })
    .filter((assignment): assignment is AssignmentMarker & { agentId: AgentId } => assignment !== null);
  if (known.length === 0) return { kind: "none", message: `Use ${formatAssignmentList(availableAgents)} to assign work to an employee.` };

  for (const assignment of known) {
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
