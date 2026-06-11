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

test("multi-agent collaboration preset enables architect developer tester and supervisor", () => {
  const configs = initialAgentConfigsForWorkspacePreset(PRESET_IDS.multiAgentCollaboration, [runtime("codex", true)]);
  const enabledIds = configs.filter((config) => config.enabled).map((config) => config.id).sort();

  assert.deepEqual(enabledIds, ["architect", "developer", "supervisor", "tester"]);
});

test("multi-agent collaboration preset assigns the preferred available runtime to enabled defaults", () => {
  const configs = initialAgentConfigsForWorkspacePreset(PRESET_IDS.multiAgentCollaboration, [
    runtime("codex", false),
    runtime("claude", true),
    runtime("codebuddy", true),
  ]);

  for (const config of configs.filter((item) => item.enabled)) {
    assert.equal(config.runtime, "claude-code");
  }
});

test("preferred runtime uses claude-code before codex when both are available", () => {
  assert.equal(preferredRuntimeFromAvailability([
    runtime("claude", true),
    runtime("codex", true),
    runtime("codebuddy", true),
  ]), "claude-code");
});

test("empty preset leaves all default agents disabled", () => {
  const configs = initialAgentConfigsForWorkspacePreset(PRESET_IDS.empty, [runtime("codex", true)]);

  assert.equal(configs.some((config) => config.enabled), false);
});

test("preferred runtime falls back to claude-code when no runtime is available", () => {
  assert.equal(preferredRuntimeFromAvailability([
    runtime("codex", false),
    runtime("claude", false),
    runtime("codebuddy", false),
  ]), "claude-code");
});
