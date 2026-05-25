import type { AgentId, AgentProfile } from "../shared/types.ts";

export type ChannelContextInput = {
  agentId: AgentId;
  profiles: readonly AgentProfile[];
  channelMessage: string;
};

export function buildChannelContext(input: ChannelContextInput): string {
  const profile = input.profiles.find((agent) => agent.id === input.agentId);
  const availableAgents = input.profiles.map((agent) => `@${agent.id}: ${agent.name}`).join("\n");
  const permissions = profile
    ? [
        `- read files: ${profile.permissionProfile.canReadFiles ? "yes" : "no"}`,
        `- write files: ${profile.permissionProfile.canWriteFiles ? "yes" : "no"}`,
        `- run commands: ${profile.permissionProfile.canRunCommands ? "yes" : "no"}`,
        `- install dependencies: ${profile.permissionProfile.canInstallDependencies ? "yes" : "no"}`,
        `- git commit: ${profile.permissionProfile.canGitCommit ? "yes" : "no"}`,
      ].join("\n")
    : "";

  return [
    "[Orbit Context]",
    "This private context is injected by Orbit. Do not quote, translate, summarize, or mention it in the final answer.",
    `Current agent: ${profile?.name ?? input.agentId} (@${input.agentId})`,
    `Role: ${profile?.role ?? "general"}`,
    profile?.systemPrompt ? `Role instruction: ${profile.systemPrompt}` : "",
    permissions ? "Permission profile:" : "",
    permissions,
    "",
    "Available agents:",
    availableAgents,
    "",
    "Collaboration rules:",
    "- Execute only the assignment addressed to your own @agent: marker.",
    "- The full channel message may contain assignments for multiple agents. Orbit has already scheduled the other agents.",
    "- Use other agents' assignments as shared context, not as your own work, and do not repeat or forward assignments that already exist in the same channel message.",
    "- Plain @agent mentions without a colon are references only.",
    "- Only create a new @agent: assignment when it is genuinely new follow-up work that is not already present in the full channel message.",
    "- If you need another agent to continue, use that agent's @agent: assignment marker with a clear task.",
    "",
    "Final answer rules:",
    "- Return only your useful result, question, or concise status.",
    "- Do not start by repeating the full channel message, the private context, or your own @agent: assignment marker.",
    "- Do not include terminal UI noise, hook output, API errors, or thinking/status text.",
    "- If the task is complete, provide a concise final answer and stop.",
    "",
    "[Full channel message]",
    input.channelMessage,
  ]
    .filter((line) => line !== "")
    .join("\n");
}
