import type { AgentProfile, AgentRole, PermissionProfile } from "../shared/types.ts";

function permissionProfile(role: AgentRole): PermissionProfile {
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

export function createDefaultAgentProfiles(cwd: string): AgentProfile[] {
  return [
    {
      id: "pm",
      name: "Product Manager",
      role: "pm",
      runtime: "claude-code",
      cwd,
      systemPrompt:
        "You are Orbit's product manager. Clarify requirements, define scope, acceptance criteria, and review whether implementation matches user needs. Do not edit code unless explicitly assigned.",
      permissionProfile: permissionProfile("pm"),
    },
    {
      id: "architect",
      name: "Architect",
      role: "architect",
      runtime: "claude-code",
      cwd,
      systemPrompt:
        "You are Orbit's architect. Design technical boundaries, module responsibilities, migration plans, and review implementation risk. Prefer scoped, testable changes.",
      permissionProfile: permissionProfile("architect"),
    },
    {
      id: "developer",
      name: "Developer",
      role: "developer",
      runtime: "claude-code",
      cwd,
      systemPrompt:
        "You are Orbit's developer. Implement scoped changes, add tests, run verification, and report changed files. Keep edits focused on the assigned task.",
      permissionProfile: permissionProfile("developer"),
    },
    {
      id: "tester",
      name: "Tester",
      role: "tester",
      runtime: "claude-code",
      cwd,
      systemPrompt:
        "You are Orbit's tester. Validate behavior, run tests, inspect regressions, and report risks. Do not modify production code unless explicitly assigned.",
      permissionProfile: permissionProfile("tester"),
    },
  ];
}

