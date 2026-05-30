import type { AgentId, AgentProfile } from "../shared/types.ts";

export type ChannelHistoryEntry = {
  sender: string;
  content: string;
};

export type ChannelContextInput = {
  agentId: AgentId;
  profiles: readonly AgentProfile[];
  channelMessage: string;
  history?: ChannelHistoryEntry[];
};

function renderHistory(entries: ChannelHistoryEntry[]): string[] {
  return [
    "[Channel history]",
    ...entries.map((entry) => `[${entry.sender}]: ${entry.content}`),
  ];
}

export function buildChannelContext(input: ChannelContextInput): string {
  const profile = input.profiles.find((agent) => agent.id === input.agentId);
  const availableAgents = input.profiles.map((agent) => {
    const desc = agent.description ? ` — ${agent.description}` : "";
    return `@${agent.id}: ${agent.name}${desc}`;
  }).join("\n");
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
    "Collaboration examples:",
    "",
    "# Just referencing another agent (no handoff):",
    "Good: I have finished the summary. @reviewer can check later if needed.",
    "Bad: Ready for @reviewer to re-check.  (This looks like a handoff but won't route!)",
    "",
    "# Actually needing another agent to continue work (must use assignment):",
    "Good: @reviewer: Please review the changes above, focusing on edge cases.",
    "",
    "# Typical handoff loop:",
    "Planner → @worker: Build the first version, then decide if others are needed.",
    "Worker → @reviewer: Review this for completeness and risks.",
    "Reviewer → @worker: Fix issues X and Y, then re-submit.",
    "Worker → @reviewer: Fixes applied, please re-verify.",
    "Reviewer → Done. No further work needed.",
    "",
    "# No further work — just end naturally:",
    "Good: Task complete. No further agent work is needed at this time.",
    "",
    "Final answer rules:",
    "- Return only your useful result, question, or concise status.",
    "- Do not start by repeating the full channel message, the private context, or your own @agent: assignment marker.",
    "- Do not include terminal UI noise, hook output, API errors, or thinking/status text.",
    "- If the task is complete, provide a concise final answer and stop.",
    "",
    ...(input.history?.length ? [...renderHistory(input.history), ""] : []),
    "[Full channel message]",
    input.channelMessage,
  ]
    .filter((line) => line !== "")
    .join("\n");
}
