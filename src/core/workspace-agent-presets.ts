import type { AgentConfig, AgentRuntimeKind, RuntimeAvailability } from "../shared/types.ts";
import { DEFAULT_AGENT_CONFIGS } from "./agent-config-store.ts";
import { runtimeKindToCliKey } from "./runtime-meta.ts";
import { PRESET_IDS } from "./workspace-presets.ts";

const MULTI_AGENT_ENABLED_IDS = new Set(["architect", "developer", "tester", "supervisor"]);
const RUNTIME_PRIORITY: AgentRuntimeKind[] = ["codex", "claude-code", "codebuddy"];
const FALLBACK_RUNTIME: AgentRuntimeKind = "codex";

export function preferredRuntimeFromAvailability(availability: readonly RuntimeAvailability[]): AgentRuntimeKind {
  // RuntimeAvailability.runtime holds CLI keys ("claude", "codex", "codebuddy"),
  // so we convert AgentRuntimeKind ("claude-code") to CLI key via runtimeKindToCliKey().
  const availableRuntimes = new Set(
    availability
      .filter((item) => item.available)
      .map((item) => item.runtime),
  );
  return RUNTIME_PRIORITY.find((runtime) => availableRuntimes.has(runtimeKindToCliKey(runtime))) ?? FALLBACK_RUNTIME;
}

export function initialAgentConfigsForWorkspacePreset(
  presetId: string,
  availability: readonly RuntimeAvailability[],
): AgentConfig[] {
  const configs = structuredClone(DEFAULT_AGENT_CONFIGS);
  if (presetId !== PRESET_IDS.multiAgentCollaboration) {
    return configs;
  }

  const runtime = preferredRuntimeFromAvailability(availability);
  return configs.map((config) => (
    MULTI_AGENT_ENABLED_IDS.has(config.id)
      ? { ...config, enabled: true, runtime }
      : config
  ));
}

