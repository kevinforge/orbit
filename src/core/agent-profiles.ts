import type { AgentConfig, AgentId, AgentProfile, AgentRole, AgentRuntimeKind, PermissionProfile } from "../shared/types.ts";

export type AgentRuntimeOverrides = Partial<Record<AgentId, AgentRuntimeKind>>;

const CONFIGURABLE_RUNTIME_KINDS = new Set<AgentRuntimeKind>(["claude-code", "codex", "codebuddy"]);

export function permissionProfile(role: AgentRole): PermissionProfile {
  switch (role) {
    case "pm":
      return {
        canReadFiles: true,
        canWriteFiles: false,
        canRunCommands: false,
        canInstallDependencies: false,
        canGitCommit: false,
        allowedDirectories: ["."],
      };
    case "architect":
      return {
        canReadFiles: true,
        canWriteFiles: false,
        canRunCommands: true,
        canInstallDependencies: false,
        canGitCommit: false,
        allowedDirectories: ["."],
      };
    case "developer":
      return {
        canReadFiles: true,
        canWriteFiles: true,
        canRunCommands: true,
        canInstallDependencies: true,
        canGitCommit: false,
        allowedDirectories: ["."],
      };
    case "tester":
      return {
        canReadFiles: true,
        canWriteFiles: false,
        canRunCommands: true,
        canInstallDependencies: false,
        canGitCommit: false,
        allowedDirectories: ["."],
      };
    case "coordinator":
      return {
        canReadFiles: false,
        canWriteFiles: false,
        canRunCommands: false,
        canInstallDependencies: false,
        canGitCommit: false,
        allowedDirectories: [],
      };
    default:
      return {
        canReadFiles: true,
        canWriteFiles: true,
        canRunCommands: true,
        canInstallDependencies: false,
        canGitCommit: false,
        allowedDirectories: ["."],
      };
  }
}

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
      name: "Product Manager",
      description: "Clarifies requirements, defines scope and acceptance criteria.",
      role: "pm",
      runtime: runtimeOverrides.pm ?? "codex",
      cwd,
      systemPrompt:
        "You are Orbit's product manager. Clarify requirements, define scope, acceptance criteria, and review whether implementation matches user needs. Do not edit code unless explicitly assigned.",
      permissionProfile: permissionProfile("pm"),
    },
    {
      id: "architect",
      name: "Architect",
      description: "Designs technical boundaries, reviews implementation risk.",
      role: "architect",
      runtime: runtimeOverrides.architect ?? "codex",
      cwd,
      systemPrompt:
        "You are Orbit's architect. Design technical boundaries, module responsibilities, migration plans, and review implementation risk. Prefer scoped, testable changes.",
      permissionProfile: permissionProfile("architect"),
    },
    {
      id: "developer",
      name: "Developer",
      description: "Implements features with TDD, creates branches and draft PRs.",
      role: "developer",
      runtime: runtimeOverrides.developer ?? "claude-code",
      cwd,
      systemPrompt:
        "You are Orbit's developer. Follow strict TDD: write failing tests first, then implement the minimal code to pass them. Before writing any code, always create a feature branch from main (e.g. feat/issue-N-description). Run npm run test && npm run build after each meaningful change. Commit, push, and open a draft PR. Never commit directly to main.",
      permissionProfile: permissionProfile("developer"),
    },
    {
      id: "tester",
      name: "Tester",
      description: "Validates behavior, runs tests, reports risks.",
      role: "tester",
      runtime: runtimeOverrides.tester ?? "codebuddy",
      cwd,
      systemPrompt:
        "You are Orbit's tester. Validate behavior, run tests, inspect regressions, and report risks. Do not modify production code unless explicitly assigned.",
      permissionProfile: permissionProfile("tester"),
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
    permissionProfile: config.permissionProfile ?? permissionProfile(config.role),
  }));
}
