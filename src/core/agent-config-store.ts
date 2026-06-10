import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hasActiveChannelWatchTriggers, type AgentConfig, type AgentId, type AgentRole, type AgentRuntimeKind } from "../shared/types.ts";
import { permissionProfile } from "./agent-profiles.ts";

export type { AgentConfig };

const VALID_ROLES = new Set<AgentRole>(["pm", "architect", "developer", "tester", "general", "coordinator"]);
const VALID_RUNTIMES = new Set<AgentRuntimeKind>(["claude-code", "codex", "codebuddy"]);
const RESERVED_IDS = new Set(["all"]);
const ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const CURRENT_MIGRATION_VERSION = 2;

export const DEFAULT_AGENT_CONFIGS: AgentConfig[] = [
  {
    id: "pm",
    name: "Product Manager",
    description: "产品负责人：定义产品方向、挑战不合理需求、将模糊想法转化为清晰可执行的产品需求",
    role: "pm",
    runtime: "codex",
    systemPrompt:
      "你是 Orbit 的产品负责人，拥有强烈的产品主人意识。你的角色不是迎合用户请求，而是创造最好的产品。\n\n" +
      "核心职责：\n" +
      "- 将模糊想法转化为清晰、可执行的产品需求\n" +
      "- 主动挑战会损害产品的不合理请求\n" +
      "- 从产品设计、用户体验和未来路线图角度思考\n" +
      "- 基于产品价值而非用户需求定义迭代方向\n\n" +
      "准则：\n" +
      "- 当请求有缺陷时，解释 WHY 并提出替代方案\n" +
      "- 关注用户价值而非用户请求——用户可能不知道他们真正需要什么\n" +
      "- 考虑边缘情况、可扩展性和长期产品健康\n" +
      "- 输出结构化需求：问题陈述、验收标准、边缘情况、考虑的替代方案\n\n" +
      "永远不要对所有事情说\"是\"。你的工作是产品判断，而非执行。Do not edit code unless explicitly assigned.",
    enabled: false,
    permissionProfile: permissionProfile("pm"),
  },
  {
    id: "architect",
    name: "Architect",
    description: "Designs technical boundaries, reviews code and implementation risk.",
    role: "architect",
    runtime: "codex",
    systemPrompt:
      "You are Orbit's architect. Design technical boundaries, module responsibilities, migration plans, and review implementation risk. Prefer scoped, testable changes. Review code for correctness, security, and maintainability when assigned.",
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
    role: "coordinator",
    runtime: "claude-code",
    systemPrompt:
      "You are Orbit's conversation supervisor. Your role is to monitor conversation " +
      "progress and coordinate agents toward task completion.\n\n" +
      "**CRITICAL CONSTRAINT: You are a coordinator ONLY — like a project foreman. " +
      "You must NEVER read files, search code, analyze the codebase, run commands, " +
      "or use ANY tool.** Your only source of information is the conversation history " +
      "messages from the user and other agents. Your only actions are delegating work " +
      "via @agent: markers and concluding to the user via @user: markers.\n\n" +
      "**Forbidden actions:** Read, Glob, Grep, Bash, Edit, Write, NotebookEdit, " +
      "WebSearch, WebFetch, Skill, Agent, Task — if you can see it in your tool list, " +
      "you must NOT use it.\n\n" +
      "When triggered, evaluate ONLY the conversation history and follow this protocol:\n" +
      "- If work is needed → @agent: assign tasks to specific agents\n" +
      "- If blocked → explain to the user what's missing\n" +
      "- If complete → @user: produce a final summary of accomplishments\n\n" +
      "Before assigning: check conversation history to avoid duplicating work " +
      "already in progress. Each message MUST have either @agent: or @user:.",
    enabled: false,
    permissionProfile: permissionProfile("coordinator"),
    triggers: {
      onUnassignedMessage: true,
      onAgentBlocked: true,
      onRunFailed: true, // Issue #82: Trigger supervisor when an agent run fails
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
      if (!Array.isArray(pp.allowedDirectories)) {
        errors.push(`Agent "${config.id}" permissionProfile.allowedDirectories must be an array.`);
      } else if (pp.allowedDirectories.length === 0 && (pp.canReadFiles || pp.canWriteFiles || pp.canRunCommands)) {
        errors.push(`Agent "${config.id}" permissionProfile.allowedDirectories must be non-empty when file or command access is enabled.`);
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
        if (t.onRunFailed !== undefined && typeof t.onRunFailed !== "boolean") {
          errors.push(`Agent "${configId}" triggers.onRunFailed must be a boolean.`);
        }
        if (t.maxTriggersPerConversation !== undefined) {
          if (typeof t.maxTriggersPerConversation !== "number" || t.maxTriggersPerConversation < 1 || t.maxTriggersPerConversation > 100) {
            errors.push(`Agent "${configId}" triggers.maxTriggersPerConversation must be an integer between 1 and 100.`);
          }
        }
        if (t.debounceMs !== undefined) {
          if (typeof t.debounceMs !== "number" || t.debounceMs < 0 || t.debounceMs > 60000) {
            errors.push(`Agent "${configId}" triggers.debounceMs must be a number between 0 and 60000.`);
          }
        }
      }
    }
  }

  // Cross-validation: only coordinator-role agents may have active channel-watch triggers
  const agentsWithActiveTriggers: AgentConfig[] = [];
  for (const c of configs) {
    if (c && hasActiveChannelWatchTriggers(c.triggers)) {
      agentsWithActiveTriggers.push(c);
      if (c.role !== "coordinator") {
        errors.push(
          `Agent "${c.id}" has active channel watch triggers but its role is "${c.role}". ` +
            "Only coordinator-role agents can act as supervisor. Change the role to coordinator or disable the triggers.",
        );
      }
    }
  }

  // Cross-validation: at most one supervisor (agent with active triggers) per conversation
  if (agentsWithActiveTriggers.length > 1) {
    errors.push(
      `Only one supervisor is allowed per conversation, but ${agentsWithActiveTriggers.length} agents have active channel watch triggers: ` +
        `${agentsWithActiveTriggers.map((c) => c.id).join(", ")}. ` +
        "Disable triggers on all but one agent.",
    );
  }

  // Issue #91: Cross-validation: only one coordinator-role agent is allowed
  const coordinators = configs.filter((c) => c && c.role === "coordinator");
  if (coordinators.length > 1) {
    errors.push(
      `Only one coordinator-role agent is allowed, but found ${coordinators.length}: ` +
        `${coordinators.map((c) => c.id).join(", ")}. ` +
        "Keep only one coordinator (supervisor) agent.",
    );
  }

  // Cross-validation: coordinator requires at least one other agent enabled
  const coordinator = configs.find((c) => c && c.role === "coordinator" && c.enabled);
  if (coordinator) {
    const othersEnabled = configs.some((c) => c && c.role !== "coordinator" && c.enabled);
    if (!othersEnabled) {
      errors.push(
        "Coordinator cannot be enabled when no other agents are enabled. " +
          "Enable at least one working agent (pm, architect, developer, tester) first.",
      );
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
      const parsed = JSON.parse(data) as AgentConfig[] | { configs: AgentConfig[]; _meta?: { migrationVersion?: number } };

      let configs: AgentConfig[];
      let storedVersion = 0;

      if (Array.isArray(parsed)) {
        // Legacy format: plain array
        configs = parsed;
      } else if (parsed && typeof parsed === "object" && Array.isArray((parsed as { configs: AgentConfig[] }).configs)) {
        configs = (parsed as { configs: AgentConfig[] }).configs;
        storedVersion = (parsed as { _meta?: { migrationVersion?: number } })._meta?.migrationVersion ?? 0;
      } else {
        return structuredClone(DEFAULT_AGENT_CONFIGS);
      }

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

      // Auto-add new default templates only when migration version is behind
      if (storedVersion < CURRENT_MIGRATION_VERSION) {
        const savedIds = new Set(configs.map((c) => c.id));
        for (const def of DEFAULT_AGENT_CONFIGS) {
          if (!savedIds.has(def.id)) {
            configs.push(structuredClone(def));
            migrated = true;
          }
        }
        for (const config of configs) {
          if (
            config.id === "supervisor" &&
            config.role === "coordinator" &&
            config.triggers &&
            config.triggers.onRunFailed === undefined
          ) {
            config.triggers.onRunFailed = true;
            migrated = true;
          }
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
    const payload = { configs, _meta: { migrationVersion: CURRENT_MIGRATION_VERSION } };
    fs.writeFileSync(tmpFile, JSON.stringify(payload, null, 2) + os.EOL);
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
