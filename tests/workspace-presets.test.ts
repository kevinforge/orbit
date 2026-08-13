import assert from "node:assert/strict";
import test from "node:test";

import { getWorkspacePresets, PRESET_IDS } from "../src/core/workspace-presets.ts";

test("returns at least two presets", () => {
  const presets = getWorkspacePresets();
  assert.ok(presets.length >= 2, "should have at least empty and software-development presets");
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
  assert.equal(empty.name, "空白");
  assert.equal(empty.description, "不预置数字员工，创建后可按需添加");
  assert.equal(empty.systemPrompt, "");
  assert.deepEqual(empty.rules, []);
  assert.equal(empty.teamId, undefined, "empty preset should not pre-provision a team");
});

test("software-development preset is the digital-worker team preset", () => {
  const presets = getWorkspacePresets();
  const dev = presets.find((p) => p.id === PRESET_IDS.softwareDevelopment);
  assert.ok(dev, "should have a 'software-development' preset");
  assert.equal(dev.name, "软件开发团队");
  assert.equal(
    dev.description,
    "预置范同经（梳理需求）、甄架构（设计方案）、蔡一平（编码实现）、田小坑（验证质量）四个数字员工，内置闭环协作流程",
  );
  assert.equal(dev.teamId, "software-development", "preset id should align with the team template id");
  assert.ok(dev.systemPrompt.length > 0, "should have a non-empty systemPrompt");
  assert.ok(dev.rules.length > 0, "should have at least one rule");
  assert.equal(dev.recommended, true, "should be marked recommended");
  assert.ok(dev.systemPrompt.includes("多数字员工协作"), "systemPrompt should mention 多数字员工协作");
  assert.ok(dev.systemPrompt.includes("持续闭环"), "systemPrompt should mention 持续闭环");
  assert.ok(dev.systemPrompt.includes("甄架构"), "systemPrompt should mention 甄架构");
  assert.ok(dev.systemPrompt.includes("蔡一平"), "systemPrompt should mention 蔡一平");
  assert.ok(dev.systemPrompt.includes("田小坑"), "systemPrompt should mention 田小坑");
  assert.deepEqual(dev.rules, [
    "用户的语言是中文，请使用中文回答用户的问题。",
    "当多个数字员工的工作存在前后依赖时，必须按顺序指派：先仅 @前置数字员工，等待其完成并返回结果后，再在下一条消息中 @后续数字员工；不要在同一条消息中同时 @存在依赖关系的数字员工。无依赖、可并行的任务可以同时指派。",
  ]);
});

test("preset ids are unique", () => {
  const presets = getWorkspacePresets();
  const ids = presets.map((p) => p.id);
  assert.deepEqual(ids, [...new Set(ids)], "all preset ids should be unique");
});
