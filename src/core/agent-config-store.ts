import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type AgentConfig, type AgentId, type AgentRuntimeKind, type AgentTeamTemplate } from "../shared/types.ts";

export type { AgentConfig };

const VALID_RUNTIMES = new Set<AgentRuntimeKind>(["claude-code", "codex", "codebuddy"]);
const RESERVED_IDS = new Set(["all", "user", "supervisor"]);
const ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const NAME_PATTERN = /^[^\s@:]+$/u;

export const DEFAULT_AGENT_CONFIGS: AgentConfig[] = [
  {
    id: "requirements",
    name: "需求分析",
    description: "澄清目标、拆分范围并定义可验证的完成标准。",
    runtime: "codex",
    systemPrompt: "你负责理解目标并把模糊需求整理成清晰、可执行、可验证的任务。主动识别遗漏、边界条件和风险，输出范围、验收标准与待确认问题。除非明确分配，否则不要直接修改交付物。",
    enabled: false,
  },
  {
    id: "solution",
    name: "方案设计",
    description: "设计实现方案、拆分协作步骤并评估关键风险。",
    runtime: "codex",
    systemPrompt: "你负责把已确认的目标转化为可靠方案。分析现状、约束、模块边界、依赖关系和风险，给出分阶段、可验证的执行计划。除非明确分配，否则不要直接修改交付物。",
    enabled: false,
  },
  {
    id: "implementation",
    name: "开发实现",
    description: "执行已确认的方案，修改交付物并完成必要验证。",
    runtime: "claude-code",
    systemPrompt: "你负责执行已确认的任务。先理解上下文和验收标准，再以最小、可回滚的改动完成工作，并运行合适的检查验证结果。清楚报告改动、验证结果和遗留风险。",
    enabled: false,
  },
  {
    id: "verification",
    name: "质量验证",
    description: "验证结果、发现回归并反馈剩余风险。",
    runtime: "codebuddy",
    systemPrompt: "你负责验证交付结果。根据目标和验收标准检查行为、边界情况和回归风险，优先复现问题并给出清晰证据。除非明确分配，否则不要修改交付物。",
    enabled: false,
  },
];

export const AGENT_TEAM_TEMPLATES: AgentTeamTemplate[] = [
  {
    id: "software-development",
    name: "软件开发团队",
    description: "需求分析、方案设计、开发实现与质量验证的完整协作团队。",
    members: DEFAULT_AGENT_CONFIGS.map(({ enabled: _enabled, ...member }) => member),
  },
];

export function validateAgentConfigs(configs: AgentConfig[]): string[] {
  const errors: string[] = [];
  if (configs.length === 0) return ["At least one agent config is required."];

  const seenIds = new Set<AgentId>();
  const seenNames = new Set<string>();
  for (let i = 0; i < configs.length; i += 1) {
    const config = configs[i];
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      errors.push(`Agent config at index ${i} must be an object.`);
      continue;
    }
    if ("role" in config || "ui" in config) {
      errors.push(`Agent config at index ${i} uses removed role or ui fields.`);
    }
    const configId = typeof config.id === "string" ? config.id : String(config.id ?? "");
    const normalizedName = typeof config.name === "string" ? config.name.trim().toLocaleLowerCase() : "";
    if (typeof config.id !== "string" || !config.id.trim()) errors.push("Agent id is required.");
    else if (RESERVED_IDS.has(config.id)) errors.push(`Agent id "${config.id}" is reserved.`);
    else if (!ID_PATTERN.test(config.id)) errors.push(`Agent id "${config.id}" has invalid format.`);
    else if (seenIds.has(config.id)) errors.push(`Duplicate agent id "${config.id}".`);
    seenIds.add(configId as AgentId);

    if (typeof config.name !== "string" || !config.name.trim()) errors.push(`Agent "${configId}" name is required.`);
    else if (config.name.length > 32 || !NAME_PATTERN.test(config.name.trim())) errors.push(`Agent "${configId}" name must be 1-32 characters without spaces, @, or colons.`);
    else if (seenNames.has(normalizedName)) errors.push(`Duplicate agent name "${config.name}".`);
    seenNames.add(normalizedName);

    if (typeof config.enabled !== "boolean") errors.push(`Agent "${configId}" enabled must be a boolean.`);
    if (!VALID_RUNTIMES.has(config.runtime)) errors.push(`Agent "${configId}" has invalid runtime "${config.runtime}".`);
    if (typeof config.systemPrompt !== "string" || !config.systemPrompt.trim()) errors.push(`Agent "${configId}" systemPrompt is required.`);

    if (config.triggers !== undefined) {
      if (typeof config.triggers !== "object" || Array.isArray(config.triggers)) errors.push(`Agent "${configId}" triggers must be an object.`);
      else {
        const t = config.triggers;
        if (t.onUnassignedMessage !== undefined && typeof t.onUnassignedMessage !== "boolean") errors.push(`Agent "${configId}" triggers.onUnassignedMessage must be a boolean.`);
        if (t.onAgentBlocked !== undefined && typeof t.onAgentBlocked !== "boolean") errors.push(`Agent "${configId}" triggers.onAgentBlocked must be a boolean.`);
        if (t.onRunFailed !== undefined && typeof t.onRunFailed !== "boolean") errors.push(`Agent "${configId}" triggers.onRunFailed must be a boolean.`);
        if (t.maxTriggersPerConversation !== undefined && (typeof t.maxTriggersPerConversation !== "number" || t.maxTriggersPerConversation < 1 || t.maxTriggersPerConversation > 100)) errors.push(`Agent "${configId}" triggers.maxTriggersPerConversation must be an integer between 1 and 100.`);
        if (t.debounceMs !== undefined && (typeof t.debounceMs !== "number" || t.debounceMs < 0 || t.debounceMs > 60000)) errors.push(`Agent "${configId}" triggers.debounceMs must be a number between 0 and 60000.`);
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
    try {
      const parsed = JSON.parse(fs.readFileSync(this.configPath(workspaceId), "utf8")) as AgentConfig[] | { configs: AgentConfig[] };
      const configs = Array.isArray(parsed) ? parsed : parsed?.configs;
      if (!Array.isArray(configs) || validateAgentConfigs(configs).length > 0) return structuredClone(DEFAULT_AGENT_CONFIGS);
      return configs;
    } catch {
      return structuredClone(DEFAULT_AGENT_CONFIGS);
    }
  }

  save(workspaceId: string, configs: AgentConfig[]): void {
    const filePath = this.configPath(workspaceId);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpFile = `${filePath}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify({ configs }, null, 2) + os.EOL);
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
