import assert from "node:assert/strict";
import test from "node:test";

import { matchPreset, getWorkspacePresets, PRESET_IDS } from "../src/core/workspace-presets.ts";

test("empty prompt + empty rules matches 'empty' preset", () => {
  const presets = getWorkspacePresets();
  const result = matchPreset("", [], presets);
  assert.equal(result, PRESET_IDS.empty);
});

test("software-development content matches its preset", () => {
  const presets = getWorkspacePresets();
  const dev = presets.find((p) => p.id === PRESET_IDS.softwareDevelopment);
  assert.ok(dev);
  const result = matchPreset(dev.systemPrompt, [...dev.rules], presets);
  assert.equal(result, PRESET_IDS.softwareDevelopment);
});

test("whitespace-only prompt and rules normalize to match 'empty'", () => {
  const presets = getWorkspacePresets();
  const result = matchPreset("   ", ["  ", "\t"], presets);
  assert.equal(result, PRESET_IDS.empty);
});

test("custom content does not match any preset", () => {
  const presets = getWorkspacePresets();
  const result = matchPreset("自定义提示词", ["规则一"], presets);
  assert.equal(result, null);
});

test("partial match (same prompt, different rules) returns null", () => {
  const presets = getWorkspacePresets();
  const dev = presets.find((p) => p.id === PRESET_IDS.softwareDevelopment);
  assert.ok(dev);
  const result = matchPreset(dev.systemPrompt, [], presets);
  assert.equal(result, null);
});
