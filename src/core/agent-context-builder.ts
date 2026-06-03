import type { AgentId, AgentProfile, WorkspaceRuntimeConfig } from "../shared/types.ts";

export type AgentHistoryEntry = {
  sender: string;
  content: string;
};

export type AgentContextInput = {
  agentId: AgentId;
  profiles: readonly AgentProfile[];
  agentMessage: string;
  history?: AgentHistoryEntry[];
  workspaceConfig?: WorkspaceRuntimeConfig;
};

function renderHistory(entries: AgentHistoryEntry[]): string[] {
  return [
    "[Conversation history]",
    ...entries.map((entry) => `[${entry.sender}]: ${entry.content}`),
  ];
}

function renderWorkspaceConfig(config: WorkspaceRuntimeConfig): string[] {
  const lines: string[] = [];
  if (config.systemPrompt) {
    lines.push("", "Workspace prompt:", config.systemPrompt);
  }
  if (config.rules.length > 0) {
    lines.push("", "Workspace rules:");
    for (const rule of config.rules) {
      lines.push(`- ${rule}`);
    }
  }
  return lines;
}

function renderSupervisorConstraints(): string[] {
  return [
    "[Supervisor Constraints]",
    "You operate under STRICT tool restrictions as a pure coordinator:",
    "- ❌ Read — YOU CANNOT READ FILES",
    "- ❌ Glob — YOU CANNOT SEARCH FOR FILES",
    "- ❌ Grep — YOU CANNOT SEARCH CODE",
    "- ❌ Bash — YOU CANNOT RUN COMMANDS",
    "- ❌ Edit / Write — YOU CANNOT MODIFY FILES",
    "- ❌ WebSearch / WebFetch — YOU CANNOT ACCESS EXTERNAL RESOURCES",
    "- ✅ Your ONLY capability: reading conversation history and routing to agents",
    "",
    "Delegation guide:",
    "- Need code analysis? → @architect: analyze ...",
    "- Need implementation? → @developer: implement ...",
    "- Need testing? → @tester: validate ...",
    "",
    "Violating these constraints corrupts the supervision mechanism.",
  ];
}

export function buildAgentContext(input: AgentContextInput): string {
  const profile = input.profiles.find((agent) => agent.id === input.agentId);
  const availableAgents = input.profiles.map((agent) => {
    const desc = agent.description ? ` - ${agent.description}` : "";
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
  // Agent role instruction is rendered AFTER workspace config per the
  // precedence: app fixed rules -> workspace config -> agent role instruction.
  const roleInstruction = profile?.systemPrompt ? `Role instruction: ${profile.systemPrompt}` : "";

  return [
    "[Orbit Context]",
    "This private context is injected by Orbit. Do not quote, translate, summarize, or mention it in the final answer.",
    `Current agent: ${profile?.name ?? input.agentId} (@${input.agentId})`,
    `Role: ${profile?.role ?? "general"}`,
    permissions ? "Permission profile:" : "",
    permissions,
    "",
    "Available agents:",
    availableAgents,
    "",
    "Collaboration rules:",
    "- Execute only the assignment addressed to your own @agent: marker.",
    "- The conversation may contain assignments for multiple agents. Orbit has already scheduled the other agents.",
    "- Use other agents' assignments as shared context, not as your own work, and do not repeat or forward assignments that already exist in the same conversation.",
    "- Plain @agent mentions without a colon are references only.",
    "- Only create a new @agent: assignment when it is genuinely new follow-up work that is not already present in the conversation.",
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
    "Planner -> @worker: Build the first version, then decide if others are needed.",
    "Worker -> @reviewer: Review this for completeness and risks.",
    "Reviewer -> @worker: Fix issues X and Y, then re-submit.",
    "Worker -> @reviewer: Fixes applied, please re-verify.",
    "Reviewer -> Done. No further work needed.",
    "",
    "# No further work - just end naturally:",
    "Good: Task complete. No further agent work is needed at this time.",
    "",
    "Final answer rules:",
    "- Return only your useful result, question, or concise status.",
    "- Do not start by repeating the conversation, the private context, or your own @agent: assignment marker.",
    "- Do not include terminal UI noise, hook output, API errors, or thinking/status text.",
    "- If the task is complete, provide a concise final answer and stop.",
    "",
    // Inject supervisor constraints for coordinator agents with triggers
    ...(profile?.role === "coordinator" ? [...renderSupervisorConstraints(), ""] : []),
    // Workspace config goes after app fixed rules, before agent role instruction
    ...(input.workspaceConfig ? renderWorkspaceConfig(input.workspaceConfig) : []),
    // Agent role instruction goes after workspace config
    ...(roleInstruction ? ["", roleInstruction] : []),
    "",
    ...(input.history?.length ? [...renderHistory(input.history), ""] : []),
    "[Current task]",
    input.agentMessage,
  ]
    .filter((line) => line !== "")
    .join("\n");
}
