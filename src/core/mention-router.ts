import type { AgentId, AgentProfile } from "../shared/types.ts";

export type MentionRouteResult =
  | { kind: "assignments"; agentIds: AgentId[]; prompt: string }
  | { kind: "empty_assignment"; agentId: AgentId; message: string }
  | { kind: "none"; message: string }
  | { kind: "self"; message: string };

type AssignmentMarker = { name: string; start: number; end: number; agentId?: AgentId };

const assignmentMarkerSource = "@([^\\s@:]+)\\s*(?::|：)";

export const assignmentPattern = new RegExp(assignmentMarkerSource, "gu");

/** 消息开头的指派标记：与 assignmentPattern 同一套标记语义，含标记后的空格/制表符。 */
const assignmentPrefixPattern = new RegExp(`^${assignmentMarkerSource}[ \\t]*`, "u");

/**
 * 解析消息开头的 `@名称:` 指派前缀（issue #160 收尾）：半角/全角冒号等价、
 * 名称匹配由调用方 toLocaleLowerCase，输入框的斜杠命令目标解析与正式指派
 * 路由共用本语义。没有前缀时返回 null。
 */
export function matchAssignmentPrefix(content: string): { name: string; end: number } | null {
  const match = assignmentPrefixPattern.exec(content);
  if (!match) return null;
  return { name: match[1] ?? "", end: match[0].length };
}

export function routeMention(
  content: string,
  availableAgents: readonly AgentProfile[],
  senderAgentId?: AgentId,
  options?: { allowEmptyAssignment?: boolean },
): MentionRouteResult {
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
    if (!content.slice(assignment.end, findNextMarkerEnd(assignment.end, known)).trim()
      && !options?.allowEmptyAssignment) {
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
