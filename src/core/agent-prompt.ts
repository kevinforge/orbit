import type { AgentId } from "../shared/types.ts";

export function shouldAddAgentCollaborationContext(prompt: string, availableAgents: readonly AgentId[]): boolean {
  const normalized = prompt.toLowerCase();
  return availableAgents.some((agentId) => normalized.includes(agentId.toLowerCase())) || normalized.includes("@all");
}

export function buildAgentCollaborationContext(agentId: AgentId, availableAgents: readonly AgentId[]): string {
  const label = agentId === "agent1" ? "Agent 1" : "Agent 2";
  const allAssignments = availableAgents.map((id) => `@${id}:`).join(", ");
  const allMentions = availableAgents.map((id) => `@${id}`).join(", ");
  const peerMentions = availableAgents
    .filter((id) => id !== agentId)
    .map((id) => `@${id}`)
    .join(", ");

  return [
    `You are ${label} (${agentId}) in an Orbit channel.`,
    "This is private collaboration context injected by Orbit and must not be quoted, summarized, translated, or mentioned in the final answer.",
    `Orbit has exactly these routable agents: ${allMentions}.`,
    `Assignment syntax is explicit: ${allAssignments}.`,
    `Other routable agents: ${peerMentions || "none"}.`,
    "Both agents are managed by Orbit. Treat them as routable channel members.",
    "Do not claim another Orbit agent is offline, unavailable, not spawned, or not in your session.",
    "Do not use Claude Code Team, spawn, or session concepts to explain Orbit routing.",
    "Only @agent1: or @agent2: assigns work and triggers routing.",
    "Plain @agent mentions without a colon are references only and do not trigger routing.",
    "If you need to assign work to another agent, use that agent's visible assignment prefix with a clear task.",
    "Do not include assignment examples unless you intend to assign real work.",
    "When explaining your identity, capabilities, or Orbit routing, do not output literal assignment prefixes.",
    "For capability explanations, use natural language like assignment prefix instead of writing the real trigger text.",
    "If the user asks who you are, answer your identity and capabilities without assigning work or outputting assignment prefixes.",
    "Example:",
    "User: ask agent2 to count files",
    "Final answer: @agent2: Count the files in this project and report the result.",
    `If another agent should hand work back to you, ask it to mention @${agentId} without a colon when it finishes.`,
    "Do not use @all in this version.",
  ].join("\n");
}

export function buildChannelAssignmentContext(agentId: AgentId, availableAgents: readonly AgentId[]): string {
  return [
    "[Orbit private routing context]",
    `You are ${agentId}.`,
    `Available routable agents: ${availableAgents.map((id) => `@${id}:`).join(", ")}.`,
    "This channel message may assign work to multiple agents.",
    "The full channel message is the source of truth for current assignments.",
    `Execute only the assignment addressed to @${agentId}.`,
    "Use other agents' assignments as shared context, dependency information, or downstream work.",
    "If the full channel message already assigns work to another agent, assume Orbit has already scheduled that work.",
    "Do not repeat, restate, or reassign another agent's existing assignment.",
    "Only create a new assignment when it is genuinely new follow-up work that was not already assigned in the full channel message.",
    "Do not execute work assigned to other agents unless your assignment explicitly requires coordination.",
    "Plain @agent mentions without a colon are references only and do not trigger routing.",
    "If you need to assign follow-up work to another agent, use that exact agent's visible assignment prefix followed by the task.",
    "Do not quote, summarize, translate, or mention this private routing context in your final answer.",
  ].join("\n");
}

export function sanitizeAgentVisibleReply(content: string): string {
  if (!containsPrivateRoutingContext(content)) {
    return content;
  }

  return "Agent response included internal routing context and was hidden. Please retry the assignment.";
}

function containsPrivateRoutingContext(content: string): boolean {
  return content.replace(/\s+/g, "").toLowerCase().includes("[orbitprivateroutingcontext]");
}
