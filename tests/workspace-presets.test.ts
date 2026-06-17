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

test("empty preset has readable Chinese copy and no prompt rules", () => {
  const presets = getWorkspacePresets();
  const empty = presets.find((p) => p.id === PRESET_IDS.empty);
  assert.ok(empty, "should have an 'empty' preset");
  assert.equal(empty.name, "空白工作区");
  assert.equal(empty.description, "不预设任何提示词和规则");
  assert.equal(empty.systemPrompt, "");
  assert.deepEqual(empty.rules, []);
});

test("multi-agent-collaboration preset has readable Chinese copy", () => {
  const presets = getWorkspacePresets();
  const mac = presets.find((p) => p.id === PRESET_IDS.multiAgentCollaboration);
  assert.ok(mac, "should have a 'multi-agent-collaboration' preset");
  assert.equal(mac.name, "多数字员工协作");
  assert.equal(
    mac.description,
    "适用于多数字员工协作开发场景，内置闭环协作流程和中文回复规则",
  );
  assert.ok(mac.systemPrompt.length > 0, "should have a non-empty systemPrompt");
  assert.ok(mac.rules.length > 0, "should have at least one rule");
  assert.equal(mac.recommended, true, "should be marked recommended");
  assert.ok(mac.systemPrompt.includes("多数字员工协作"), "systemPrompt should mention 多数字员工协作");
  assert.ok(mac.systemPrompt.includes("持续闭环"), "systemPrompt should mention 持续闭环");
  assert.ok(mac.systemPrompt.includes("架构师"), "systemPrompt should mention 架构师");
  assert.ok(mac.systemPrompt.includes("开发人员"), "systemPrompt should mention 开发人员");
  assert.ok(mac.systemPrompt.includes("测试人员"), "systemPrompt should mention 测试人员");
  assert.deepEqual(mac.rules, ["用户的语言是中文，请使用中文回答用户的问题。"]);
});

test("preset ids are unique", () => {
  const presets = getWorkspacePresets();
  const ids = presets.map((p) => p.id);
  assert.deepEqual(ids, [...new Set(ids)], "all preset ids should be unique");
});
