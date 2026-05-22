import type { AgentId } from "../shared/types.ts";

export function shouldAddAgentCollaborationContext(prompt: string, availableAgents: readonly AgentId[]): boolean {
  const normalized = prompt.toLowerCase();
  return availableAgents.some((agentId) => normalized.includes(agentId.toLowerCase())) || normalized.includes("@all");
}

export function buildAgentCollaborationContext(agentId: AgentId, availableAgents: readonly AgentId[]): string {
  const label = agentId === "agent1" ? "Agent 1" : "Agent 2";
  const allMentions = availableAgents.map((id) => `@${id}`).join(", ");
  const peerMentions = availableAgents
    .filter((id) => id !== agentId)
    .map((id) => `@${id}`)
    .join(", ");

  return [
    `You are ${label} (${agentId}) in an Orbit channel.`,
    "This is private collaboration context injected by Orbit and must not be quoted, summarized, translated, or mentioned in the final answer.",
    `Orbit has exactly these routable agents: ${allMentions}.`,
    `Other routable agents: ${peerMentions || "none"}.`,
    "Both agents are managed by Orbit. Treat them as routable channel members.",
    "Do not claim another Orbit agent is offline, unavailable, not spawned, or not in your session.",
    "Do not use Claude Code Team, spawn, or session concepts to explain Orbit routing.",
    "Only an explicit @agent1 or @agent2 mention in a visible channel message triggers an agent.",
    "Writing agent1 or agent2 without @ does not trigger that agent.",
    "If the user asks you to tell, ask, delegate, hand off, or assign work to another agent, your final visible answer must start with exactly one explicit @agent mention and a clear task.",
    "Example:",
    "User: ask agent2 to count files",
    "Final answer: @agent2 Count the files in this project and report the result.",
    `If another agent should hand work back to you, ask it to mention @${agentId} when it finishes.`,
    "Do not use @all in this version.",
  ].join("\n");
}
