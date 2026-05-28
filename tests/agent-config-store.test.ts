import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentConfigStore, DEFAULT_AGENT_CONFIGS, validateAgentConfigs, type AgentConfig } from "../src/core/agent-config-store.ts";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "orbit-test-config-"));
}

test("DEFAULT_AGENT_CONFIGS seeds four built-in agents", () => {
  assert.equal(DEFAULT_AGENT_CONFIGS.length, 4);
  const ids = DEFAULT_AGENT_CONFIGS.map((c) => c.id);
  assert.ok(ids.includes("pm"));
  assert.ok(ids.includes("architect"));
  assert.ok(ids.includes("developer"));
  assert.ok(ids.includes("tester"));
  for (const config of DEFAULT_AGENT_CONFIGS) {
    assert.ok(config.enabled, `${config.id} should be enabled by default`);
    assert.ok(config.systemPrompt.length > 0, `${config.id} should have a systemPrompt`);
  }
});

test("load returns seed configs when no file exists", () => {
  const dir = tempDir();
  try {
    const store = new AgentConfigStore(dir);
    const configs = store.load("ws1");
    assert.equal(configs.length, 4);
    assert.equal(configs[0].id, "pm");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("save then load round-trips configs", () => {
  const dir = tempDir();
  try {
    const store = new AgentConfigStore(dir);
    const configs: AgentConfig[] = [
      { id: "custom", name: "Custom Agent", role: "general", runtime: "claude-code", systemPrompt: "You are custom.", enabled: true },
    ];
    store.save("ws1", configs);
    const loaded = store.load("ws1");
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].id, "custom");
    assert.equal(loaded[0].name, "Custom Agent");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("save creates parent directories", () => {
  const dir = path.join(tempDir(), "nested", "deep");
  try {
    const store = new AgentConfigStore(dir);
    store.save("ws1", DEFAULT_AGENT_CONFIGS);
    assert.ok(fs.existsSync(path.join(dir, "workspaces", "ws1", "agents.json")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reset restores seed configs", () => {
  const dir = tempDir();
  try {
    const store = new AgentConfigStore(dir);
    store.save("ws1", [{ id: "x", name: "X", role: "general", runtime: "claude-code", systemPrompt: "x", enabled: true }]);
    const reset = store.reset("ws1");
    assert.equal(reset.length, 4);
    assert.equal(reset[0].id, "pm");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("different workspaces have independent configs", () => {
  const dir = tempDir();
  try {
    const store = new AgentConfigStore(dir);
    store.save("ws1", [{ id: "a", name: "A", role: "general", runtime: "claude-code", systemPrompt: "a", enabled: true }]);
    store.save("ws2", [{ id: "b", name: "B", role: "general", runtime: "codex", systemPrompt: "b", enabled: true }]);
    assert.equal(store.load("ws1")[0].id, "a");
    assert.equal(store.load("ws2")[0].id, "b");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("load handles corrupted file gracefully", () => {
  const dir = tempDir();
  try {
    const store = new AgentConfigStore(dir);
    const filePath = path.join(dir, "workspaces", "ws1", "agents.json");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "not valid json{{{");
    const configs = store.load("ws1");
    assert.equal(configs.length, 4);
    assert.equal(configs[0].id, "pm");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- Validation tests ---

test("validates ok for seed configs", () => {
  const errors = validateAgentConfigs(DEFAULT_AGENT_CONFIGS);
  assert.deepEqual(errors, []);
});

test("rejects duplicate ids", () => {
  const configs: AgentConfig[] = [
    { id: "a", name: "A", role: "general", runtime: "claude-code", systemPrompt: "x", enabled: true },
    { id: "a", name: "A2", role: "general", runtime: "codex", systemPrompt: "y", enabled: true },
  ];
  const errors = validateAgentConfigs(configs);
  assert.ok(errors.some((e) => e.toLowerCase().includes("duplicate")));
});

test("rejects id 'all'", () => {
  const configs: AgentConfig[] = [
    { id: "all", name: "All", role: "general", runtime: "claude-code", systemPrompt: "x", enabled: true },
  ];
  const errors = validateAgentConfigs(configs);
  assert.ok(errors.some((e) => e.includes("reserved")));
});

test("rejects invalid id format", () => {
  const configs: AgentConfig[] = [
    { id: "bad id!", name: "Bad", role: "general", runtime: "claude-code", systemPrompt: "x", enabled: true },
  ];
  const errors = validateAgentConfigs(configs);
  assert.ok(errors.some((e) => e.includes("format")));
});

test("rejects invalid runtime", () => {
  const configs: AgentConfig[] = [
    { id: "agent1", name: "A", role: "general", runtime: "invalid-runtime" as AgentConfig["runtime"], systemPrompt: "x", enabled: true },
  ];
  const errors = validateAgentConfigs(configs);
  assert.ok(errors.some((e) => e.includes("runtime")));
});

test("rejects empty systemPrompt", () => {
  const configs: AgentConfig[] = [
    { id: "agent1", name: "A", role: "general", runtime: "claude-code", systemPrompt: "  ", enabled: true },
  ];
  const errors = validateAgentConfigs(configs);
  assert.ok(errors.some((e) => e.includes("systemPrompt")));
});

test("rejects empty name", () => {
  const configs: AgentConfig[] = [
    { id: "agent1", name: "  ", role: "general", runtime: "claude-code", systemPrompt: "do stuff", enabled: true },
  ];
  const errors = validateAgentConfigs(configs);
  assert.ok(errors.some((e) => e.includes("name")));
});

test("rejects permissionProfile with empty allowedDirectories", () => {
  const configs: AgentConfig[] = [
    {
      id: "agent1", name: "A", role: "general", runtime: "claude-code",
      systemPrompt: "do stuff", enabled: true,
      permissionProfile: {
        canReadFiles: true, canWriteFiles: false, canRunCommands: false,
        canInstallDependencies: false, canGitCommit: false, allowedDirectories: [],
      },
    },
  ];
  const errors = validateAgentConfigs(configs);
  assert.ok(errors.some((e) => e.includes("allowedDirectories")));
});

test("accepts config with valid permissionProfile", () => {
  const configs: AgentConfig[] = [
    {
      id: "agent1", name: "A", role: "general", runtime: "claude-code",
      systemPrompt: "do stuff", enabled: true,
      permissionProfile: {
        canReadFiles: true, canWriteFiles: true, canRunCommands: true,
        canInstallDependencies: false, canGitCommit: false, allowedDirectories: ["."],
      },
    },
  ];
  const errors = validateAgentConfigs(configs);
  assert.deepEqual(errors, []);
});

test("rejects config with no enabled agents", () => {
  const configs: AgentConfig[] = DEFAULT_AGENT_CONFIGS.map((c) => ({ ...c, enabled: false }));
  const errors = validateAgentConfigs(configs);
  assert.ok(errors.some((e) => e.includes("enabled")));
});

test("rejects empty config list", () => {
  const errors = validateAgentConfigs([]);
  assert.ok(errors.length > 0);
});
