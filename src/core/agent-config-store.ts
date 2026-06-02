import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentConfig, AgentId, AgentRole, AgentRuntimeKind } from "../shared/types.ts";
import { permissionProfile } from "./agent-profiles.ts";

export type { AgentConfig };

const VALID_ROLES = new Set<AgentRole>(["pm", "architect", "developer", "tester", "general"]);
const VALID_RUNTIMES = new Set<AgentRuntimeKind>(["claude-code", "codex", "codebuddy"]);
const RESERVED_IDS = new Set(["all"]);
const ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

export const DEFAULT_AGENT_CONFIGS: AgentConfig[] = [
  {
    id: "pm",
    name: "Product Manager",
    description: "Clarifies requirements, defines scope and acceptance criteria.",
    role: "pm",
    runtime: "codex",
    systemPrompt:
      "You are Orbit's product manager. Clarify requirements, define scope, acceptance criteria, and review whether implementation matches user needs. Do not edit code unless explicitly assigned.",
    enabled: false,
    permissionProfile: permissionProfile("pm"),
  },
  {
    id: "architect",
    name: "Architect",
    description: "Designs technical boundaries, reviews implementation risk.",
    role: "architect",
    runtime: "codex",
    systemPrompt:
      "You are Orbit's architect. Design technical boundaries, module responsibilities, migration plans, and review implementation risk. Prefer scoped, testable changes.",
    enabled: false,
    permissionProfile: permissionProfile("architect"),
  },
  {
    id: "developer",
    name: "Developer",
    description: "Implements features with TDD, creates branches and draft PRs.",
    role: "developer",
    runtime: "claude-code",
    systemPrompt:
      "You are Orbit's developer. Follow strict TDD: write failing tests first, then implement the minimal code to pass them. Before writing any code, always create a feature branch from main (e.g. feat/issue-N-description). Run npm run test && npm run build after each meaningful change. Commit, push, and open a draft PR. Never commit directly to main.",
    enabled: false,
    permissionProfile: permissionProfile("developer"),
  },
  {
    id: "tester",
    name: "Tester",
    description: "Validates behavior, runs tests, reports risks.",
    role: "tester",
    runtime: "codebuddy",
    systemPrompt:
      "You are Orbit's tester. Validate behavior, run tests, inspect regressions, and report risks. Do not modify production code unless explicitly assigned.",
    enabled: false,
    permissionProfile: permissionProfile("tester"),
  },
  {
    id: "supervisor",
    name: "Supervisor",
    description: "Monitors conversation progress and coordinates agents toward task completion.",
    role: "general",
    runtime: "claude-code",
    systemPrompt:
      "You are Orbit's conversation supervisor. Your role is to track the user's original " +
      "request and determine if the overall task is complete. " +
      "When triggered, evaluate the conversation state:\n" +
      "- If work is still needed, assign tasks using @agent: markers.\n" +
      "- If blocked, explain what's missing to the user.\n" +
      "- If complete, summarize what was accomplished and conclude.\n" +
      "Before assigning work, check if any agents are already running or have queued tasks — do not duplicate.",
    enabled: false,
    permissionProfile: permissionProfile("architect"),
    triggers: {
      onUnassignedMessage: true,
      onAgentBlocked: true,
    },
  },
];

export function validateAgentConfigs(configs: AgentConfig[]): string[] {
  const errors: string[] = [];

  if (configs.length === 0) {
    errors.push("At least one agent config is required.");
    return errors;
  }

  const seen = new Set<AgentId>();
  for (let i = 0; i < configs.length; i++) {
    const config = configs[i];
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      errors.push(`Agent config at index ${i} must be an object.`);
      continue;
    }
    const configId = typeof config.id === "string" ? config.id : String(config.id ?? "");

    if (typeof config.id !== "string" || !config.id.trim()) {
      errors.push(`Agent id is required.`);
    } else if (RESERVED_IDS.has(config.id)) {
      errors.push(`Agent id "${config.id}" is reserved.`);
    } else if (!ID_PATTERN.test(config.id)) {
      errors.push(`Agent id "${config.id}" has invalid format. Use letters, digits, hyphens, and underscores.`);
    } else if (seen.has(config.id as AgentId)) {
      errors.push(`Duplicate agent id "${config.id}".`);
    }
    seen.add(configId as AgentId);

    if (typeof config.name !== "string" || !config.name.trim()) {
      errors.push(`Agent "${configId}" name is required.`);
    }

    if (!VALID_ROLES.has(config.role)) {
      errors.push(`Agent "${configId}" has invalid role "${config.role}".`);
    }

    if (typeof config.enabled !== "boolean") {
      errors.push(`Agent "${configId}" enabled must be a boolean.`);
    }

    if (!VALID_RUNTIMES.has(config.runtime)) {
      errors.push(`Agent "${configId}" has invalid runtime "${config.runtime}".`);
    }

    if (typeof config.systemPrompt !== "string" || !config.systemPrompt.trim()) {
      errors.push(`Agent "${configId}" systemPrompt is required.`);
    }

    if (config.permissionProfile) {
      const pp = config.permissionProfile;
      const boolFlags: (keyof Pick<typeof pp, "canReadFiles" | "canWriteFiles" | "canRunCommands" | "canInstallDependencies" | "canGitCommit">)[] =
        ["canReadFiles", "canWriteFiles", "canRunCommands", "canInstallDependencies", "canGitCommit"];
      for (const flag of boolFlags) {
        if (typeof pp[flag] !== "boolean") {
          errors.push(`Agent "${config.id}" permissionProfile.${flag} must be a boolean.`);
        }
      }
      if (!Array.isArray(pp.allowedDirectories) || pp.allowedDirectories.length === 0) {
        errors.push(`Agent "${config.id}" permissionProfile.allowedDirectories must be non-empty.`);
      }
    }

    if (config.triggers !== undefined) {
      if (typeof config.triggers !== "object" || Array.isArray(config.triggers)) {
        errors.push(`Agent "${configId}" triggers must be an object.`);
      } else {
        const t = config.triggers;
        if (t.onUnassignedMessage !== undefined && typeof t.onUnassignedMessage !== "boolean") {
          errors.push(`Agent "${configId}" triggers.onUnassignedMessage must be a boolean.`);
        }
        if (t.onAgentBlocked !== undefined && typeof t.onAgentBlocked !== "boolean") {
          errors.push(`Agent "${configId}" triggers.onAgentBlocked must be a boolean.`);
        }
      }
    }
  }

  return errors;
}

export class AgentConfigStore {
  private readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? path.join(os.homedir(), ".orbit");
  }

  load(workspaceId: string): AgentConfig[] {
    const filePath = this.configPath(workspaceId);
    try {
      const data = fs.readFileSync(filePath, "utf8");
      const configs = JSON.parse(data) as AgentConfig[];
      if (!Array.isArray(configs) || configs.length === 0) {
        return structuredClone(DEFAULT_AGENT_CONFIGS);
      }
      const errors = validateAgentConfigs(configs);
      if (errors.length > 0) {
        console.error(`[orbit] Invalid agents.json, using defaults: ${errors.join("; ")}`);
        return structuredClone(DEFAULT_AGENT_CONFIGS);
      }
      // Migrate old configs missing permissionProfile
      let migrated = false;
      for (const config of configs) {
        if (!config.permissionProfile) {
          config.permissionProfile = permissionProfile(config.role);
          migrated = true;
        }
      }

      // Auto-add new default templates not present in saved configs
      const savedIds = new Set(configs.map((c) => c.id));
      for (const def of DEFAULT_AGENT_CONFIGS) {
        if (!savedIds.has(def.id)) {
          configs.push(structuredClone(def));
          migrated = true;
        }
      }

      if (migrated) {
        try {
          this.save(workspaceId, configs);
        } catch (err) {
          // Don't lose the user's configs just because we couldn't persist
          // the migration — warn and return the in-memory fix anyway.
          console.warn("[orbit] Failed to persist config migration:", (err as Error).message ?? String(err));
        }
      }
      return configs;
    } catch {
      return structuredClone(DEFAULT_AGENT_CONFIGS);
    }
  }

  save(workspaceId: string, configs: AgentConfig[]): void {
    const filePath = this.configPath(workspaceId);
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpFile = filePath + ".tmp";
    fs.writeFileSync(tmpFile, JSON.stringify(configs, null, 2) + os.EOL);
    fs.renameSync(tmpFile, filePath);
  }

  reset(workspaceId: string): AgentConfig[] {
    const defaults = structuredClone(DEFAULT_AGENT_CONFIGS);
    this.save(workspaceId, defaults);
    return defaults;
  }

  private configPath(workspaceId: string): string {
    return path.join(this.baseDir, "workspaces", workspaceId, "agents.json");
  }
}
