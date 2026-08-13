import type { AgentConfig, AgentId, AgentProfile, AgentRuntimeKind } from "../shared/types.ts";

export type AgentRuntimeOverrides = Partial<Record<AgentId, AgentRuntimeKind>>;

export const INTERNAL_SUPERVISOR_ID = "supervisor";

export function createSupervisorProfile(cwd: string, runtime: AgentRuntimeKind): AgentProfile {
  return {
    id: INTERNAL_SUPERVISOR_ID,
    name: "协作监督",
    description: "Coordinates the conversation and moves assigned work toward completion.",
    runtime,
    cwd,
    internal: true,
    systemPrompt: "You are Orbit's built-in collaboration supervisor. Monitor the conversation and coordinate enabled digital employees toward task completion. You may only use the conversation history. Never read files, search code, run commands, modify files, or access external resources. Delegate through the exact @employee-name: markers listed in the available employees section and conclude to the user with @user:.",
    triggers: { onUnassignedMessage: true, onAgentBlocked: true, onRunFailed: true },
  };
}

const CONFIGURABLE_RUNTIME_KINDS = new Set<AgentRuntimeKind>(["claude-code", "codex", "codebuddy"]);

export function parseAgentRuntimeOverrides(value: string | undefined): AgentRuntimeOverrides {
  const overrides: AgentRuntimeOverrides = {};
  if (!value) return overrides;
  for (const entry of value.split(",")) {
    const [agentId, runtime] = entry.split("=").map((part) => part.trim());
    if (!agentId || !runtime) continue;
    if (!CONFIGURABLE_RUNTIME_KINDS.has(runtime as AgentRuntimeKind)) throw new Error(`Unsupported runtime for ${agentId}: ${runtime}`);
    overrides[agentId] = runtime as AgentRuntimeKind;
  }
  return overrides;
}

export function createDefaultAgentProfiles(cwd: string, runtimeOverrides: AgentRuntimeOverrides = {}): AgentProfile[] {
  return [
    { id: "requirements", name: "需求分析", description: "Clarifies goals, scope, and acceptance criteria.", runtime: runtimeOverrides.requirements ?? "codex", cwd, systemPrompt: "You clarify goals, scope, acceptance criteria, open questions, and risks. Do not modify deliverables unless explicitly assigned." },
    { id: "solution", name: "方案设计", description: "Designs solutions and evaluates implementation risk.", runtime: runtimeOverrides.solution ?? "codex", cwd, systemPrompt: "You design reliable solutions, boundaries, dependencies, execution steps, and risk controls. Do not modify deliverables unless explicitly assigned." },
    { id: "implementation", name: "开发实现", description: "Executes approved plans and verifies the result.", runtime: runtimeOverrides.implementation ?? "claude-code", cwd, systemPrompt: "You implement assigned work with focused, reversible changes and appropriate verification. Report changes, checks, and remaining risks clearly." },
    { id: "verification", name: "质量验证", description: "Validates behavior and reports regressions and risks.", runtime: runtimeOverrides.verification ?? "codebuddy", cwd, systemPrompt: "You validate behavior against goals and acceptance criteria, reproduce issues, and report evidence and risks. Do not modify deliverables unless explicitly assigned." },
  ];
}

export function configsToProfiles(configs: readonly AgentConfig[], cwd: string): AgentProfile[] {
  return configs.map((config) => ({
    id: config.id,
    name: config.name,
    description: config.description,
    runtime: config.runtime,
    cwd,
    systemPrompt: config.systemPrompt,
  }));
}
