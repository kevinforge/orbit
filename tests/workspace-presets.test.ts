import assert from "node:assert/strict";
import test from "node:test";

import { getWorkspacePresets, PRESET_IDS } from "../src/core/workspace-presets.ts";

test("returns at least two presets", () => {
  const presets = getWorkspacePresets();
  assert.ok(presets.length >= 2, "should have at least empty and multi-agent-collaboration presets");
});

test("each preset has required fields", () => {
  const presets = getWorkspacePresets();
  for (const preset of presets) {
    assert.ok(preset.id, `preset should have an id, got: ${JSON.stringify(preset)}`);
    assert.ok(preset.name, `preset "${preset.id}" should have a name`);
    assert.ok(typeof preset.description === "string", `preset "${preset.id}" description should be a string`);
    assert.ok(typeof preset.systemPrompt === "string", `preset "${preset.id}" systemPrompt should be a string`);
    assert.ok(Array.isArray(preset.rules), `preset "${preset.id}" rules should be an array`);
  }
});

test("empty preset has no systemPrompt and no rules", () => {
  const presets = getWorkspacePresets();
  const empty = presets.find((p) => p.id === PRESET_IDS.empty);
  assert.ok(empty, "should have an 'empty' preset");
  assert.equal(empty.systemPrompt, "");
  assert.deepEqual(empty.rules, []);
});

test("multi-agent-collaboration preset has systemPrompt, rules, and is recommended", () => {
  const presets = getWorkspacePresets();
  const mac = presets.find((p) => p.id === PRESET_IDS.multiAgentCollaboration);
  assert.ok(mac, "should have a 'multi-agent-collaboration' preset");
  assert.ok(mac.systemPrompt.length > 0, "should have a non-empty systemPrompt");
  assert.ok(mac.rules.length > 0, "should have at least one rule");
  assert.equal(mac.recommended, true, "should be marked recommended");
  assert.ok(mac.systemPrompt.includes("多数字员工"), "systemPrompt should mention 多数字员工");
  assert.ok(mac.rules.some((r) => r.includes("中文")), "rules should mention 中文");
});

test("preset ids are unique", () => {
  const presets = getWorkspacePresets();
  const ids = presets.map((p) => p.id);
  assert.deepEqual(ids, [...new Set(ids)], "all preset ids should be unique");
});
