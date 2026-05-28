import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentConfig, AgentId, AgentRuntimeKind } from "../shared/types.ts";

export type { AgentConfig };

const VALID_RUNTIMES = new Set<AgentRuntimeKind>(["claude-code", "codex", "codebuddy"]);
const RESERVED_IDS = new Set(["all"]);
const ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

export const DEFAULT_AGENT_CONFIGS: AgentConfig[] = [
  {
    id: "pm",
    name: "Product Manager",
    role: "pm",
    runtime: "codex",
    systemPrompt:
      "You are Orbit's product manager. Clarify requirements, define scope, acceptance criteria, and review whether implementation matches user needs. Do not edit code unless explicitly assigned.",
    enabled: true,
  },
  {
    id: "architect",
    name: "Architect",
    role: "architect",
    runtime: "codex",
    systemPrompt:
      "You are Orbit's architect. Design technical boundaries, module responsibilities, migration plans, and review implementation risk. Prefer scoped, testable changes.",
    enabled: true,
  },
  {
    id: "developer",
    name: "Developer",
    role: "developer",
    runtime: "claude-code",
    systemPrompt:
      "You are Orbit's developer. Follow strict TDD: write failing tests first, then implement the minimal code to pass them. Before writing any code, always create a feature branch from main (e.g. feat/issue-N-description). Run npm run test && npm run build after each meaningful change. Commit, push, and open a draft PR. Never commit directly to main.",
    enabled: true,
  },
  {
    id: "tester",
    name: "Tester",
    role: "tester",
    runtime: "codebuddy",
    systemPrompt:
      "You are Orbit's tester. Validate behavior, run tests, inspect regressions, and report risks. Do not modify production code unless explicitly assigned.",
    enabled: true,
  },
];

export function validateAgentConfigs(configs: AgentConfig[]): string[] {
  const errors: string[] = [];

  if (configs.length === 0) {
    errors.push("At least one agent config is required.");
    return errors;
  }

  const seen = new Set<AgentId>();
  for (const config of configs) {
    if (!config.id || !config.id.trim()) {
      errors.push(`Agent id is required.`);
    } else if (RESERVED_IDS.has(config.id)) {
      errors.push(`Agent id "${config.id}" is reserved.`);
    } else if (!ID_PATTERN.test(config.id)) {
      errors.push(`Agent id "${config.id}" has invalid format. Use letters, digits, hyphens, and underscores.`);
    } else if (seen.has(config.id)) {
      errors.push(`Duplicate agent id "${config.id}".`);
    }
    seen.add(config.id);

    if (!config.name || !config.name.trim()) {
      errors.push(`Agent "${config.id}" name is required.`);
    }

    if (!VALID_RUNTIMES.has(config.runtime)) {
      errors.push(`Agent "${config.id}" has invalid runtime "${config.runtime}".`);
    }

    if (!config.systemPrompt || !config.systemPrompt.trim()) {
      errors.push(`Agent "${config.id}" systemPrompt is required.`);
    }
  }

  if (!configs.some((c) => c.enabled)) {
    errors.push("At least one agent must be enabled.");
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
