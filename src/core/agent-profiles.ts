import type { AgentConfig, AgentId, AgentProfile, AgentRuntimeKind } from "../shared/types.ts";

export type AgentRuntimeOverrides = Partial<Record<AgentId, AgentRuntimeKind>>;

export const INTERNAL_SUPERVISOR_ID = "supervisor";

export function createSupervisorProfile(cwd: string, runtime: AgentRuntimeKind): AgentProfile {
  return {
    id: INTERNAL_SUPERVISOR_ID,
    name: "协作监督",
    description: "Coordinates the conversation and moves assigned work toward completion.",
    role: "coordinator",
    runtime,
    cwd,
    internal: true,
    systemPrompt:
      "You are Orbit's built-in collaboration supervisor. Monitor the conversation and coordinate enabled digital employees toward task completion. " +
      "You may only use the conversation history. Never read files, search code, run commands, modify files, or access external resources. " +
      "Delegate through @agent: markers and conclude to the user with @user:.",
    triggers: {
      onUnassignedMessage: true,
      onAgentBlocked: true,
      onRunFailed: true,
    },
  };
}

const CONFIGURABLE_RUNTIME_KINDS = new Set<AgentRuntimeKind>(["claude-code", "codex", "codebuddy"]);

export function parseAgentRuntimeOverrides(value: string | undefined): AgentRuntimeOverrides {
  const overrides: AgentRuntimeOverrides = {};
  if (!value) {
    return overrides;
  }

  for (const entry of value.split(",")) {
    const [agentId, runtime] = entry.split("=").map((part) => part.trim());
    if (!agentId || !runtime) {
      continue;
    }
    if (!CONFIGURABLE_RUNTIME_KINDS.has(runtime as AgentRuntimeKind)) {
      throw new Error(`Unsupported runtime for ${agentId}: ${runtime}`);
    }
    overrides[agentId] = runtime as AgentRuntimeKind;
  }

  return overrides;
}

export function createDefaultAgentProfiles(cwd: string, runtimeOverrides: AgentRuntimeOverrides = {}): AgentProfile[] {
  return [
    {
      id: "pm",
      name: "产品经理（pm）",
      description: "Clarifies requirements, defines scope and acceptance criteria.",
      role: "pm",
      runtime: runtimeOverrides.pm ?? "codex",
      cwd,
      systemPrompt:
        "You are Orbit's product manager. Clarify requirements, define scope, acceptance criteria, and review whether implementation matches user needs. Do not edit code unless explicitly assigned.",
    },
    {
      id: "architect",
      name: "架构师（architect）",
      description: "Designs technical boundaries, reviews code and implementation risk.",
      role: "architect",
      runtime: runtimeOverrides.architect ?? "codex",
      cwd,
      systemPrompt:
        "You are Orbit's architect. Design technical boundaries, module responsibilities, migration plans, and review implementation risk. Prefer scoped, testable changes. Review code for correctness, security, and maintainability when assigned.",
    },
    {
      id: "developer",
      name: "开发（developer）",
      description: "Implements features with TDD, creates branches and draft PRs.",
      role: "developer",
      runtime: runtimeOverrides.developer ?? "claude-code",
      cwd,
      systemPrompt:
        "You are Orbit's developer. Follow strict TDD: write failing tests first, then implement the minimal code to pass them. Before writing any code, always create a feature branch from main (e.g. feat/issue-N-description). Run npm run test && npm run build after each meaningful change. Commit, push, and open a draft PR. Never commit directly to main.",
    },
    {
      id: "tester",
      name: "测试（tester）",
      description: "Validates behavior, runs tests, reports risks.",
      role: "tester",
      runtime: runtimeOverrides.tester ?? "codebuddy",
      cwd,
      systemPrompt:
        "You are Orbit's tester. Validate behavior, run tests, inspect regressions, and report risks. Do not modify production code unless explicitly assigned.",
    },
  ];
}

export function configsToProfiles(configs: readonly AgentConfig[], cwd: string): AgentProfile[] {
  return configs.map((config) => ({
    id: config.id,
    name: config.ui?.label || config.name,
    description: config.description,
    role: config.role,
    runtime: config.runtime,
    cwd,
    systemPrompt: config.systemPrompt,
  }));
}
