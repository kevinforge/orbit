import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentModelStateStore } from "../src/core/agent-model-state-store.ts";
import type { AgentModelStateSnapshot } from "../src/shared/types.ts";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "orbit-test-model-state-"));
}

function snapshot(overrides: Partial<AgentModelStateSnapshot> = {}): AgentModelStateSnapshot {
  return {
    agentId: "developer",
    runtimeKind: "claude-code",
    configId: "model",
    choices: [
      { value: "model-a", name: "模型 A" },
      { value: "model-b", name: "模型 B" },
    ],
    currentValue: "model-a",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("update writes per-agent snapshots and load reads them back", () => {
  const dir = tempDir();
  try {
    const store = new AgentModelStateStore(dir);
    store.update("ws1", snapshot());
    store.update("ws1", snapshot({ agentId: "reviewer", runtimeKind: "codex", currentValue: "model-b" }));

    assert.equal(store.get("ws1", "developer")?.currentValue, "model-a");
    assert.equal(store.get("ws1", "reviewer")?.runtimeKind, "codex");
    assert.equal(store.get("ws1", "missing"), undefined);
    assert.deepEqual(store.load("ws2"), {}, "工作区之间相互独立");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("updating the same agent replaces its snapshot without touching others", () => {
  const dir = tempDir();
  try {
    const store = new AgentModelStateStore(dir);
    store.update("ws1", snapshot());
    store.update("ws1", snapshot({ currentValue: "model-b", updatedAt: "2026-02-01T00:00:00.000Z" }));

    const states = store.load("ws1");
    assert.equal(Object.keys(states).length, 1);
    assert.equal(states.developer?.currentValue, "model-b");
    assert.equal(states.developer?.updatedAt, "2026-02-01T00:00:00.000Z");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("missing or malformed files degrade to an empty state", () => {
  const dir = tempDir();
  try {
    const store = new AgentModelStateStore(dir);
    assert.deepEqual(store.load("missing"), {});

    const filePath = path.join(dir, "workspaces", "ws1", "agent-model-state.json");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "not json");
    assert.deepEqual(store.load("ws1"), {});

    fs.writeFileSync(filePath, JSON.stringify({ states: { developer: "corrupt" } }));
    assert.equal(store.get("ws1", "developer"), undefined, "非对象条目被剔除");

    fs.writeFileSync(filePath, JSON.stringify({ states: { developer: {} } }));
    assert.equal(store.get("ws1", "developer"), undefined, "缺字段对象被剔除");

    fs.writeFileSync(filePath, JSON.stringify({
      states: {
        developer: { ...snapshot(), agentId: "other-agent" },
      },
    }));
    assert.equal(store.get("ws1", "developer"), undefined, "键和值中的员工 ID 不一致时被剔除");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("snapshots persist on disk under the workspace directory", () => {
  const dir = tempDir();
  try {
    const store = new AgentModelStateStore(dir);
    store.update("ws1", snapshot());
    const raw = JSON.parse(
      fs.readFileSync(path.join(dir, "workspaces", "ws1", "agent-model-state.json"), "utf8"),
    ) as { states: Record<string, AgentModelStateSnapshot> };
    assert.equal(raw.states.developer?.configId, "model");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
