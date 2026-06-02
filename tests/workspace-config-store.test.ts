import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_WORKSPACE_CONFIG,
  resolveWorkspaceConfig,
  WorkspaceConfigStore,
} from "../src/core/workspace-config-store.ts";
import type { WorkspaceConfig } from "../src/core/workspace-config-store.ts";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "orbit-test-workspace-config-"));
}

// --- resolveWorkspaceConfig ---

test("resolveWorkspaceConfig returns defaults for undefined input", () => {
  const resolved = resolveWorkspaceConfig(undefined);
  assert.equal(resolved.systemPrompt, "");
  assert.deepEqual(resolved.rules, []);
});

test("resolveWorkspaceConfig returns defaults for null input", () => {
  const resolved = resolveWorkspaceConfig(null);
  assert.equal(resolved.systemPrompt, "");
  assert.deepEqual(resolved.rules, []);
});

test("resolveWorkspaceConfig returns defaults for empty object", () => {
  const resolved = resolveWorkspaceConfig({});
  assert.equal(resolved.systemPrompt, "");
  assert.deepEqual(resolved.rules, []);
});

test("resolveWorkspaceConfig trims whitespace from systemPrompt", () => {
  const resolved = resolveWorkspaceConfig({ systemPrompt: "  hello world  " });
  assert.equal(resolved.systemPrompt, "hello world");
});

test("resolveWorkspaceConfig filters empty and whitespace-only rules", () => {
  const resolved = resolveWorkspaceConfig({ rules: ["  valid  ", "   ", ""] });
  assert.deepEqual(resolved.rules, ["valid"]);
});

test("resolveWorkspaceConfig preserves valid rules with trimming", () => {
  const resolved = resolveWorkspaceConfig({ rules: ["  Keep code clean", "Write tests first  "] });
  assert.deepEqual(resolved.rules, ["Keep code clean", "Write tests first"]);
});

test("resolveWorkspaceConfig handles non-array rules gracefully", () => {
  const resolved = resolveWorkspaceConfig({ rules: "not-an-array" as unknown as string[] });
  assert.deepEqual(resolved.rules, []);
});

// --- WorkspaceConfigStore ---

test("load returns defaults when no config file exists", () => {
  const dir = tempDir();
  try {
    const store = new WorkspaceConfigStore(dir);
    const config = store.load("ws1");
    assert.equal(config.systemPrompt, "");
    assert.deepEqual(config.rules, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("save then load round-trips config", () => {
  const dir = tempDir();
  try {
    const store = new WorkspaceConfigStore(dir);
    const config: WorkspaceConfig = {
      systemPrompt: "This is a workspace-level prompt.",
      rules: ["Always use TypeScript", "Write tests before code"],
    };
    store.save("ws1", config);
    const loaded = store.load("ws1");
    assert.equal(loaded.systemPrompt, "This is a workspace-level prompt.");
    assert.deepEqual(loaded.rules, ["Always use TypeScript", "Write tests before code"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("save creates parent directories", () => {
  const dir = path.join(tempDir(), "nested", "deep");
  try {
    const store = new WorkspaceConfigStore(dir);
    store.save("ws1", { systemPrompt: "test" });
    assert.ok(fs.existsSync(path.join(dir, "workspaces", "ws1", "config.json")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("different workspaces have independent configs", () => {
  const dir = tempDir();
  try {
    const store = new WorkspaceConfigStore(dir);
    store.save("ws1", { systemPrompt: "prompt for ws1", rules: ["rule1"] });
    store.save("ws2", { systemPrompt: "prompt for ws2", rules: ["rule2"] });
    assert.equal(store.load("ws1").systemPrompt, "prompt for ws1");
    assert.deepEqual(store.load("ws1").rules, ["rule1"]);
    assert.equal(store.load("ws2").systemPrompt, "prompt for ws2");
    assert.deepEqual(store.load("ws2").rules, ["rule2"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("load handles corrupted JSON gracefully", () => {
  const dir = tempDir();
  try {
    const store = new WorkspaceConfigStore(dir);
    const filePath = path.join(dir, "workspaces", "ws1", "config.json");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "not valid json{{{");
    const config = store.load("ws1");
    assert.equal(config.systemPrompt, "");
    assert.deepEqual(config.rules, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("load handles valid JSON that is not an object", () => {
  const dir = tempDir();
  try {
    const store = new WorkspaceConfigStore(dir);
    const filePath = path.join(dir, "workspaces", "ws1", "config.json");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(["array", "not", "object"]));
    const config = store.load("ws1");
    assert.equal(config.systemPrompt, "");
    assert.deepEqual(config.rules, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("save with empty config stores minimal JSON", () => {
  const dir = tempDir();
  try {
    const store = new WorkspaceConfigStore(dir);
    store.save("ws1", {});
    const filePath = path.join(dir, "workspaces", "ws1", "config.json");
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    assert.equal(typeof raw, "object");
    const loaded = store.load("ws1");
    assert.equal(loaded.systemPrompt, "");
    assert.deepEqual(loaded.rules, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("load filters out empty systemPrompt (whitespace-only)", () => {
  const dir = tempDir();
  try {
    const store = new WorkspaceConfigStore(dir);
    store.save("ws1", { systemPrompt: "   " });
    const loaded = store.load("ws1");
    assert.equal(loaded.systemPrompt, "");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("save persists file that can be read by a new store instance", () => {
  const dir = tempDir();
  try {
    const store1 = new WorkspaceConfigStore(dir);
    store1.save("ws1", {
      systemPrompt: "persist test",
      rules: ["rule-a", "rule-b"],
    });

    const store2 = new WorkspaceConfigStore(dir);
    const loaded = store2.load("ws1");
    assert.equal(loaded.systemPrompt, "persist test");
    assert.deepEqual(loaded.rules, ["rule-a", "rule-b"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
