import assert from "node:assert/strict";
import test from "node:test";

import { initialAgentConfigsForWorkspacePreset, preferredRuntimeFromAvailability } from "../src/core/workspace-agent-presets.ts";
import { PRESET_IDS } from "../src/core/workspace-presets.ts";
import type { RuntimeAvailability } from "../src/shared/types.ts";

function runtime(runtime: string, available: boolean): RuntimeAvailability {
  return {
    runtime,
    available,
    path: available ? `${runtime}-path` : null,
    checkedAt: new Date(0).toISOString(),
  };
}

test("software-development preset pre-provisions the full team enabled", () => {
  const configs = initialAgentConfigsForWorkspacePreset(PRESET_IDS.softwareDevelopment);
  assert.ok(configs, "software-development preset should pre-provision agents");
  const enabledIds = configs.filter((config) => config.enabled).map((config) => config.id).sort();

  assert.deepEqual(enabledIds, ["implementation", "requirements", "solution", "verification"]);
});

test("software-development preset keeps each member's template runtime", () => {
  const configs = initialAgentConfigsForWorkspacePreset(PRESET_IDS.softwareDevelopment);
  assert.ok(configs);
  const byId = new Map(configs.map((config) => [config.id, config]));

  assert.equal(byId.get("requirements")?.runtime, "codex");
  assert.equal(byId.get("solution")?.runtime, "codex");
  assert.equal(byId.get("implementation")?.runtime, "claude-code");
  assert.equal(byId.get("verification")?.runtime, "codebuddy");
});

test("software-development preset uses the single locally available runtime for all members", () => {
  const configs = initialAgentConfigsForWorkspacePreset(PRESET_IDS.softwareDevelopment, [
    runtime("claude-agent-acp", false),
    runtime("codex-acp", true),
    runtime("codebuddy", false),
  ]);
  assert.ok(configs);
  const byId = new Map(configs.map((config) => [config.id, config]));

  assert.equal(byId.get("requirements")?.runtime, "codex");
  assert.equal(byId.get("implementation")?.runtime, "codex");
  assert.equal(byId.get("verification")?.runtime, "codex");
});

test("software-development preset spreads members across locally available runtimes", () => {
  const configs = initialAgentConfigsForWorkspacePreset(PRESET_IDS.softwareDevelopment, [
    runtime("claude-agent-acp", true),
    runtime("codex-acp", true),
    runtime("codebuddy", true),
  ]);
  assert.ok(configs);
  const byId = new Map(configs.map((config) => [config.id, config]));

  assert.equal(byId.get("requirements")?.runtime, "claude-code");
  assert.equal(byId.get("solution")?.runtime, "codex");
  assert.equal(byId.get("implementation")?.runtime, "codebuddy");
  assert.equal(byId.get("verification")?.runtime, "claude-code");
});

test("software-development preset cycles through a subset of available runtimes", () => {
  const configs = initialAgentConfigsForWorkspacePreset(PRESET_IDS.softwareDevelopment, [
    runtime("claude-agent-acp", true),
    runtime("codex-acp", true),
    runtime("codebuddy", false),
  ]);
  assert.ok(configs);
  const byId = new Map(configs.map((config) => [config.id, config]));

  assert.equal(byId.get("requirements")?.runtime, "claude-code");
  assert.equal(byId.get("solution")?.runtime, "codex");
  assert.equal(byId.get("implementation")?.runtime, "claude-code");
  assert.equal(byId.get("verification")?.runtime, "codex");
});

test("software-development preset falls back to claude-code when no availability is provided at all", () => {
  const configs = initialAgentConfigsForWorkspacePreset(PRESET_IDS.softwareDevelopment, [
    runtime("claude-agent-acp", false),
    runtime("codex-acp", false),
    runtime("codebuddy", false),
  ]);
  assert.ok(configs);
  const byId = new Map(configs.map((config) => [config.id, config]));

  assert.equal(byId.get("requirements")?.runtime, "claude-code");
  assert.equal(byId.get("implementation")?.runtime, "claude-code");
});

test("empty preset pre-provisions no agents", () => {
  const configs = initialAgentConfigsForWorkspacePreset(PRESET_IDS.empty);

  assert.equal(configs, null);
});

test("unknown preset id pre-provisions no agents", () => {
  const configs = initialAgentConfigsForWorkspacePreset("no-such-team");

  assert.equal(configs, null);
});

test("preferred runtime uses claude-code before codex when both are available", () => {
  assert.equal(preferredRuntimeFromAvailability([
    runtime("claude-agent-acp", true),
    runtime("codex-acp", true),
    runtime("codebuddy", true),
  ]), "claude-code");
});

test("preferred runtime falls back to claude-code when no runtime is available", () => {
  assert.equal(preferredRuntimeFromAvailability([
    runtime("codex-acp", false),
    runtime("claude-agent-acp", false),
    runtime("codebuddy", false),
  ]), "claude-code");
});
