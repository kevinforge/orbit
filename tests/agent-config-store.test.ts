import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentConfigStore, DEFAULT_AGENT_CONFIGS, validateAgentConfigs, type AgentConfig } from "../src/core/agent-config-store.ts";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "orbit-test-config-"));
}

test("DEFAULT_AGENT_CONFIGS seeds four disabled built-in templates", () => {
  assert.equal(DEFAULT_AGENT_CONFIGS.length, 4);
  const ids = DEFAULT_AGENT_CONFIGS.map((c) => c.id);
  assert.ok(ids.includes("pm"));
  assert.ok(ids.includes("architect"));
  assert.ok(ids.includes("developer"));
  assert.ok(ids.includes("tester"));
  for (const config of DEFAULT_AGENT_CONFIGS) {
    assert.equal(config.enabled, false, `${config.id} should be disabled by default`);
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

test("load returns defaults for valid JSON with invalid runtime", () => {
  const dir = tempDir();
  try {
    const store = new AgentConfigStore(dir);
    const filePath = path.join(dir, "workspaces", "ws1", "agents.json");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify([{ id: "a", name: "A", role: "general", runtime: "not-a-runtime", systemPrompt: "x", enabled: true }]));
    const configs = store.load("ws1");
    assert.equal(configs.length, 4);
    assert.equal(configs[0].id, "pm");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("load returns defaults for valid JSON with duplicate ids", () => {
  const dir = tempDir();
  try {
    const store = new AgentConfigStore(dir);
    const filePath = path.join(dir, "workspaces", "ws1", "agents.json");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify([
      { id: "dup", name: "A", role: "general", runtime: "claude-code", systemPrompt: "x", enabled: true },
      { id: "dup", name: "B", role: "general", runtime: "codex", systemPrompt: "y", enabled: true },
    ]));
    const configs = store.load("ws1");
    assert.equal(configs.length, 4);
    assert.equal(configs[0].id, "pm");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("load accepts valid JSON with no enabled agents", () => {
  const dir = tempDir();
  try {
    const store = new AgentConfigStore(dir);
    const filePath = path.join(dir, "workspaces", "ws1", "agents.json");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify([{ id: "a", name: "A", role: "general", runtime: "claude-code", systemPrompt: "x", enabled: false }]));
    const configs = store.load("ws1");
    assert.equal(configs.length, 1);
    assert.equal(configs[0].id, "a");
    assert.equal(configs[0].enabled, false);
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

test("accepts config with no enabled agents", () => {
  const configs: AgentConfig[] = DEFAULT_AGENT_CONFIGS.map((c) => ({ ...c, enabled: false }));
  const errors = validateAgentConfigs(configs);
  assert.deepEqual(errors, []);
});

test("rejects empty config list", () => {
  const errors = validateAgentConfigs([]);
  assert.ok(errors.length > 0);
});

test("rejects permissionProfile with non-boolean canReadFiles", () => {
  const configs: AgentConfig[] = [
    {
      id: "agent1", name: "A", role: "general", runtime: "claude-code",
      systemPrompt: "do stuff", enabled: true,
      permissionProfile: {
        canReadFiles: "yes" as unknown as boolean, canWriteFiles: false, canRunCommands: false,
        canInstallDependencies: false, canGitCommit: false, allowedDirectories: ["."],
      },
    },
  ];
  const errors = validateAgentConfigs(configs);
  assert.ok(errors.some((e) => e.includes("canReadFiles")));
});

test("rejects invalid role", () => {
  const configs: AgentConfig[] = [
    { id: "agent1", name: "A", role: "bad-role" as AgentConfig["role"], runtime: "claude-code", systemPrompt: "do stuff", enabled: true },
  ];
  const errors = validateAgentConfigs(configs);
  assert.ok(errors.some((e) => e.includes("role") && e.includes("agent1")), `Expected a role error, got: ${JSON.stringify(errors)}`);
});

test("rejects non-boolean enabled field", () => {
  const configs: AgentConfig[] = [
    { id: "agent1", name: "A", role: "general", runtime: "claude-code", systemPrompt: "do stuff", enabled: "false" as unknown as boolean },
  ];
  const errors = validateAgentConfigs(configs);
  assert.ok(errors.some((e) => e.includes("enabled") && e.includes("boolean")), `Expected an enabled/boolean error, got: ${JSON.stringify(errors)}`);
});

test("rejects missing enabled field", () => {
  const configs: AgentConfig[] = [
    { id: "agent1", name: "A", role: "general", runtime: "claude-code", systemPrompt: "do stuff", enabled: undefined as unknown as boolean },
  ];
  const errors = validateAgentConfigs(configs);
  assert.ok(errors.some((e) => e.includes("enabled")), `Expected an enabled error, got: ${JSON.stringify(errors)}`);
});

test("rejects permissionProfile with missing boolean fields", () => {
  const configs: AgentConfig[] = [
    {
      id: "agent1", name: "A", role: "general", runtime: "claude-code",
      systemPrompt: "do stuff", enabled: true,
      permissionProfile: {
        canReadFiles: true, allowedDirectories: ["."],
      } as unknown as AgentConfig["permissionProfile"],
    },
  ];
  const errors = validateAgentConfigs(configs);
  assert.ok(errors.some((e) => e.includes("canWriteFiles")));
  assert.ok(errors.some((e) => e.includes("canRunCommands")));
  assert.ok(errors.some((e) => e.includes("canInstallDependencies")));
  assert.ok(errors.some((e) => e.includes("canGitCommit")));
});

test("rejects non-string id without throwing", () => {
  const configs = [
    { id: 123, name: "A", role: "general", runtime: "claude-code", systemPrompt: "x", enabled: true },
  ] as unknown as AgentConfig[];
  const errors = validateAgentConfigs(configs);
  assert.ok(errors.some((e) => e.includes("id")), `Expected an id error, got: ${JSON.stringify(errors)}`);
});

test("rejects non-string name without throwing", () => {
  const configs = [
    { id: "a", name: 123, role: "general", runtime: "claude-code", systemPrompt: "x", enabled: true },
  ] as unknown as AgentConfig[];
  const errors = validateAgentConfigs(configs);
  assert.ok(errors.some((e) => e.includes("name")), `Expected a name error, got: ${JSON.stringify(errors)}`);
});

test("rejects non-string systemPrompt without throwing", () => {
  const configs = [
    { id: "a", name: "A", role: "general", runtime: "claude-code", systemPrompt: 123, enabled: true },
  ] as unknown as AgentConfig[];
  const errors = validateAgentConfigs(configs);
  assert.ok(errors.some((e) => e.includes("systemPrompt")), `Expected a systemPrompt error, got: ${JSON.stringify(errors)}`);
});

test("rejects null array element without throwing", () => {
  const errors = validateAgentConfigs([null] as unknown as AgentConfig[]);
  assert.ok(errors.some((e) => e.includes("object")), `Expected an object error, got: ${JSON.stringify(errors)}`);
});

test("rejects non-object array element without throwing", () => {
  const errors = validateAgentConfigs(["bad"] as unknown as AgentConfig[]);
  assert.ok(errors.some((e) => e.includes("object")), `Expected an object error, got: ${JSON.stringify(errors)}`);
});

// --- Permission profile persistence (#26) ---

test("DEFAULT_AGENT_CONFIGS include permissionProfile for each agent", () => {
  for (const config of DEFAULT_AGENT_CONFIGS) {
    assert.ok(config.permissionProfile, `${config.id} should have permissionProfile`);
    assert.equal(typeof config.permissionProfile!.canReadFiles, "boolean", `${config.id} canReadFiles`);
    assert.equal(typeof config.permissionProfile!.canWriteFiles, "boolean", `${config.id} canWriteFiles`);
    assert.equal(typeof config.permissionProfile!.canRunCommands, "boolean", `${config.id} canRunCommands`);
    assert.equal(typeof config.permissionProfile!.canInstallDependencies, "boolean", `${config.id} canInstallDependencies`);
    assert.equal(typeof config.permissionProfile!.canGitCommit, "boolean", `${config.id} canGitCommit`);
    assert.ok(Array.isArray(config.permissionProfile!.allowedDirectories), `${config.id} allowedDirectories`);
    assert.ok(config.permissionProfile!.allowedDirectories.length > 0, `${config.id} allowedDirectories non-empty`);
  }
});

test("save persists permissionProfile in agents.json on disk", () => {
  const dir = tempDir();
  try {
    const store = new AgentConfigStore(dir);
    const configs: AgentConfig[] = [
      {
        id: "agent1", name: "A", role: "general", runtime: "claude-code",
        systemPrompt: "do stuff", enabled: true,
        permissionProfile: {
          canReadFiles: true, canWriteFiles: false, canRunCommands: true,
          canInstallDependencies: false, canGitCommit: false, allowedDirectories: ["."],
        },
      },
    ];
    store.save("ws1", configs);
    const filePath = path.join(dir, "workspaces", "ws1", "agents.json");
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    assert.ok(raw[0].permissionProfile, "file should contain permissionProfile");
    assert.equal(raw[0].permissionProfile.canReadFiles, true);
    assert.equal(raw[0].permissionProfile.canWriteFiles, false);
    assert.equal(raw[0].permissionProfile.canRunCommands, true);
    assert.equal(raw[0].permissionProfile.canInstallDependencies, false);
    assert.equal(raw[0].permissionProfile.canGitCommit, false);
    assert.deepEqual(raw[0].permissionProfile.allowedDirectories, ["."]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("load migrates old configs missing permissionProfile to role defaults", () => {
  const dir = tempDir();
  try {
    const store = new AgentConfigStore(dir);
    const filePath = path.join(dir, "workspaces", "ws1", "agents.json");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // Old config without permissionProfile (simulating pre-#26 format)
    fs.writeFileSync(filePath, JSON.stringify([
      { id: "old-dev", name: "Old Dev", description: "", role: "developer", runtime: "claude-code", systemPrompt: "dev", enabled: true },
    ]));
    const loaded = store.load("ws1");
    assert.equal(loaded.length, 1);
    // After migration, should have permissionProfile derived from role
    assert.ok(loaded[0].permissionProfile, "should migrate old config with permissionProfile");
    assert.equal(loaded[0].permissionProfile!.canReadFiles, true);
    assert.equal(loaded[0].permissionProfile!.canWriteFiles, true);
    assert.equal(loaded[0].permissionProfile!.canRunCommands, true);
    assert.equal(loaded[0].permissionProfile!.canInstallDependencies, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reset outputs configs with permissionProfile", () => {
  const dir = tempDir();
  try {
    const store = new AgentConfigStore(dir);
    const reset = store.reset("ws1");
    for (const config of reset) {
      assert.ok(config.permissionProfile, `${config.id} should have permissionProfile after reset`);
    }
    // Check file on disk too
    const filePath = path.join(dir, "workspaces", "ws1", "agents.json");
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    for (const entry of raw) {
      assert.ok(entry.permissionProfile, `${entry.id} on disk should have permissionProfile`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validate still permits configs without permissionProfile (backward compat)", () => {
  const configs: AgentConfig[] = [
    { id: "old", name: "Old", role: "general", runtime: "claude-code", systemPrompt: "x", enabled: true },
  ];
  const errors = validateAgentConfigs(configs);
  assert.deepEqual(errors, []);
});

test("validate does not require permissionProfile for each config", () => {
  // permissionProfile is optional in AgentConfig by design
  const configs: AgentConfig[] = [
    { id: "a", name: "A", role: "pm", runtime: "codex", systemPrompt: "do pm stuff", enabled: true },
    { id: "b", name: "B", role: "developer", runtime: "claude-code", systemPrompt: "do dev stuff", enabled: true, permissionProfile: undefined },
  ];
  const errors = validateAgentConfigs(configs);
  assert.deepEqual(errors, []);
});
