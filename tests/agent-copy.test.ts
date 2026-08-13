import assert from "node:assert/strict";
import test from "node:test";

import type { AgentConfig, ChannelWatchTriggers } from "../src/shared/types.ts";

function generateUniqueId(sourceId: string, existingConfigs: AgentConfig[]): string {
  const existingIds = new Set(existingConfigs.map((config) => config.id));
  let newId = `${sourceId}-copy`;
  let counter = 1;
  while (existingIds.has(newId)) newId = `${sourceId}-copy-${counter++}`;
  return newId;
}

function copyAgentConfig(source: AgentConfig, existingConfigs: AgentConfig[]): AgentConfig {
  const copy: AgentConfig = { ...structuredClone(source), id: generateUniqueId(source.id, existingConfigs), name: `${source.name} (副本)`, enabled: false };
  copy.triggers = undefined;
  return copy;
}

const source: AgentConfig = {
  id: "implementation",
  name: "开发实现",
  runtime: "claude-code",
  systemPrompt: "You implement work.",
  enabled: true,
  description: "Builds the requested change.",
};

test("generates an unused copy id", () => {
  assert.equal(generateUniqueId("implementation", [source]), "implementation-copy");
  assert.equal(generateUniqueId("implementation", [source, { ...source, id: "implementation-copy", name: "副本" }]), "implementation-copy-1");
});

test("copies names and fields without role or ui metadata", () => {
  const copy = copyAgentConfig(source, [source]);
  assert.equal(copy.name, "开发实现 (副本)");
  assert.equal(copy.enabled, false);
  assert.equal(copy.description, source.description);
  assert.equal("role" in copy, false);
  assert.equal("ui" in copy, false);
});

test("deep copies triggers and clears them for the new employee", () => {
  const triggers: ChannelWatchTriggers = { onRunFailed: true };
  const copy = copyAgentConfig({ ...source, triggers }, [source]);
  assert.equal(copy.triggers, undefined);
  assert.notEqual(copy, source);
});
