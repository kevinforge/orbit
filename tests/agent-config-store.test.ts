import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  AGENT_TEAM_TEMPLATES,
  AgentConfigStore,
  DEFAULT_AGENT_CONFIGS,
  validateAgentConfigs,
  type AgentConfig,
} from "../src/core/agent-config-store.ts";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "orbit-test-config-"));
}

function config(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "custom",
    name: "Custom Agent",
    runtime: "claude-code",
    systemPrompt: "You are a useful digital employee.",
    enabled: true,
    ...overrides,
  };
}

test("defaults provide a disabled software development team", () => {
  assert.deepEqual(DEFAULT_AGENT_CONFIGS.map((item) => item.id), [
    "requirements",
    "solution",
    "implementation",
    "verification",
  ]);
  assert.ok(DEFAULT_AGENT_CONFIGS.every((item) => !item.enabled));
  assert.ok(DEFAULT_AGENT_CONFIGS.every((item) => item.name.length > 0 && item.systemPrompt.length > 0));
  assert.ok(DEFAULT_AGENT_CONFIGS.every((item) => !("role" in item) && !("ui" in item)));
});

test("software development team template contains the default members", () => {
  const template = AGENT_TEAM_TEMPLATES.find((item) => item.id === "software-development");
  assert.ok(template);
  assert.equal(template.members.length, DEFAULT_AGENT_CONFIGS.length);
  assert.ok(template.members.every((member) => !("enabled" in member)));
});

test("valid custom names and runtimes pass validation", () => {
  assert.deepEqual(validateAgentConfigs([config({ name: "我的助手", runtime: "codebuddy" })]), []);
});

test("duplicate names, reserved ids, and assignment punctuation are rejected", () => {
  const errors = validateAgentConfigs([
    config({ id: "supervisor", name: "同名" }),
    config({ id: "second", name: "同名" }),
    config({ id: "third", name: "带 空格" }),
  ]);
  assert.ok(errors.some((error) => error.includes("reserved")));
  assert.ok(errors.some((error) => error.includes("Duplicate agent name")));
  assert.ok(errors.some((error) => error.includes("without spaces")));
});

test("save and load round-trip without a role model", () => {
  const dir = tempDir();
  try {
    const store = new AgentConfigStore(dir);
    const configs = [config({ id: "reviewer", name: "代码审阅" })];
    store.save("ws1", configs);
    assert.deepEqual(store.load("ws1"), configs);
    const raw = fs.readFileSync(path.join(dir, "workspaces", "ws1", "agents.json"), "utf8");
    assert.equal(raw.includes("role"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid or missing files fall back to the new defaults", () => {
  const dir = tempDir();
  try {
    const store = new AgentConfigStore(dir);
    assert.deepEqual(store.load("missing").map((item) => item.id), DEFAULT_AGENT_CONFIGS.map((item) => item.id));
    const filePath = path.join(dir, "workspaces", "ws1", "agents.json");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify([{ id: "old", name: "旧员工", role: "developer", runtime: "claude-code", systemPrompt: "x", enabled: true }]));
    assert.deepEqual(store.load("ws1").map((item) => item.id), DEFAULT_AGENT_CONFIGS.map((item) => item.id));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reset restores defaults and workspaces are independent", () => {
  const dir = tempDir();
  try {
    const store = new AgentConfigStore(dir);
    store.save("ws1", [config({ id: "one", name: "一号" })]);
    store.save("ws2", [config({ id: "two", name: "二号" })]);
    assert.equal(store.load("ws1")[0]?.id, "one");
    assert.equal(store.load("ws2")[0]?.id, "two");
    assert.deepEqual(store.reset("ws1").map((item) => item.id), DEFAULT_AGENT_CONFIGS.map((item) => item.id));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
