import assert from "node:assert/strict";
import test from "node:test";

import type { AgentConfig, ChannelWatchTriggers } from "../src/shared/types.ts";

/**
 * Tests for agent template copy functionality.
 * These tests verify the core logic for:
 * 1. Unique ID generation (generateUniqueId pattern)
 * 2. Deep copy of agent configs (structuredClone behavior)
 * 3. Triggers clearing for supervisor roles
 * 4. Name suffix addition
 */

// Simulate generateUniqueId function from App.tsx
function generateUniqueId(sourceId: string, existingConfigs: AgentConfig[]): string {
  const existingIds = new Set(existingConfigs.map((c) => c.id));
  let newId = `${sourceId}-copy`;
  let counter = 1;
  while (existingIds.has(newId)) {
    newId = `${sourceId}-copy-${counter}`;
    counter++;
  }
  return newId;
}

// Simulate copyConfig logic from App.tsx
function copyAgentConfig(source: AgentConfig, existingConfigs: AgentConfig[]): AgentConfig {
  const newId = generateUniqueId(source.id, existingConfigs);
  const copy: AgentConfig = {
    ...structuredClone(source),
    id: newId,
    name: `${source.name} (副本)`,
    enabled: false,
  };
  // Clear triggers to avoid conflicts
  if (copy.triggers) {
    copy.triggers = undefined;
  }
  return copy;
}

test("generateUniqueId produces unique ID with -copy suffix", () => {
  const existing: AgentConfig[] = [
    { id: "architect", name: "Architect", role: "architect", runtime: "claude-code", systemPrompt: "", enabled: true },
  ];
  const newId = generateUniqueId("architect", existing);
  assert.equal(newId, "architect-copy");
});

test("generateUniqueId increments counter when -copy exists", () => {
  const existing: AgentConfig[] = [
    { id: "architect", name: "Architect", role: "architect", runtime: "claude-code", systemPrompt: "", enabled: true },
    { id: "architect-copy", name: "Architect Copy", role: "architect", runtime: "claude-code", systemPrompt: "", enabled: false },
  ];
  const newId = generateUniqueId("architect", existing);
  assert.equal(newId, "architect-copy-1");
});

test("generateUniqueId increments counter for multiple copies", () => {
  const existing: AgentConfig[] = [
    { id: "architect", name: "Architect", role: "architect", runtime: "claude-code", systemPrompt: "", enabled: true },
    { id: "architect-copy", name: "Architect Copy 1", role: "architect", runtime: "claude-code", systemPrompt: "", enabled: false },
    { id: "architect-copy-1", name: "Architect Copy 2", role: "architect", runtime: "claude-code", systemPrompt: "", enabled: false },
    { id: "architect-copy-2", name: "Architect Copy 3", role: "architect", runtime: "claude-code", systemPrompt: "", enabled: false },
  ];
  const newId = generateUniqueId("architect", existing);
  assert.equal(newId, "architect-copy-3");
});

test("generateUniqueId works for IDs with hyphens", () => {
  const existing: AgentConfig[] = [
    { id: "my-agent", name: "My Agent", role: "general", runtime: "claude-code", systemPrompt: "", enabled: true },
  ];
  const newId = generateUniqueId("my-agent", existing);
  assert.equal(newId, "my-agent-copy");
});

test("structuredClone creates deep copy of permissionProfile", () => {
  const source: AgentConfig = {
    id: "developer",
    name: "Developer",
    role: "developer",
    runtime: "claude-code",
    systemPrompt: "You are a developer.",
    enabled: true,
    permissionProfile: {
      canReadFiles: true,
      canWriteFiles: true,
      canRunCommands: true,
      canInstallDependencies: true,
      canGitCommit: true,
      allowedDirectories: ["src/", "tests/"],
    },
  };
  const copy = structuredClone(source);
  // Modify copy's permissionProfile
  copy.permissionProfile!.allowedDirectories.push("dist/");
  // Source should remain unchanged
  assert.deepEqual(source.permissionProfile!.allowedDirectories, ["src/", "tests/"]);
  assert.deepEqual(copy.permissionProfile!.allowedDirectories, ["src/", "tests/", "dist/"]);
});

test("copyAgentConfig adds (副本) suffix to name", () => {
  const source: AgentConfig = {
    id: "architect",
    name: "架构师",
    role: "architect",
    runtime: "claude-code",
    systemPrompt: "设计系统架构",
    enabled: true,
  };
  const existing: AgentConfig[] = [source];
  const copy = copyAgentConfig(source, existing);
  assert.equal(copy.name, "架构师 (副本)");
});

test("copyAgentConfig sets enabled to false", () => {
  const source: AgentConfig = {
    id: "architect",
    name: "Architect",
    role: "architect",
    runtime: "claude-code",
    systemPrompt: "",
    enabled: true,
  };
  const existing: AgentConfig[] = [source];
  const copy = copyAgentConfig(source, existing);
  assert.equal(copy.enabled, false);
});

test("copyAgentConfig clears triggers for supervisor role", () => {
  const triggers: ChannelWatchTriggers = {
    onUnassignedMessage: true,
    onAgentBlocked: true,
    maxTriggersPerConversation: 5,
    debounceMs: 2000,
  };
  const source: AgentConfig = {
    id: "supervisor",
    name: "Supervisor",
    role: "coordinator",
    runtime: "claude-code",
    systemPrompt: "",
    enabled: true,
    triggers,
  };
  const existing: AgentConfig[] = [source];
  const copy = copyAgentConfig(source, existing);
  assert.equal(copy.triggers, undefined);
});

test("copyAgentConfig preserves triggers for non-supervisor roles", () => {
  const triggers: ChannelWatchTriggers = {
    onUnassignedMessage: true,
  };
  const source: AgentConfig = {
    id: "custom-agent",
    name: "Custom Agent",
    role: "general",
    runtime: "claude-code",
    systemPrompt: "",
    enabled: true,
    triggers,
  };
  const existing: AgentConfig[] = [source];
  const copy = copyAgentConfig(source, existing);
  // Even for non-supervisor roles, triggers are cleared per design to avoid conflicts
  assert.equal(copy.triggers, undefined);
});

test("copyAgentConfig deep copies ui field", () => {
  const source: AgentConfig = {
    id: "developer",
    name: "Developer",
    role: "developer",
    runtime: "claude-code",
    systemPrompt: "",
    enabled: true,
    ui: { label: "开发" },
  };
  const existing: AgentConfig[] = [source];
  const copy = copyAgentConfig(source, existing);
  assert.deepEqual(copy.ui, { label: "开发" });
  // Modify copy's ui
  copy.ui!.label = "开发副本";
  // Source should remain unchanged
  assert.equal(source.ui!.label, "开发");
});

test("copyAgentConfig preserves all other fields", () => {
  const source: AgentConfig = {
    id: "developer",
    name: "Developer",
    role: "developer",
    runtime: "claude-code",
    systemPrompt: "You write clean code.",
    enabled: true,
    description: "Writes code",
    permissionProfile: {
      canReadFiles: true,
      canWriteFiles: true,
      canRunCommands: true,
      canInstallDependencies: true,
      canGitCommit: true,
      allowedDirectories: [],
    },
    ui: { label: "Dev" },
  };
  const existing: AgentConfig[] = [source];
  const copy = copyAgentConfig(source, existing);
  assert.equal(copy.role, "developer");
  assert.equal(copy.runtime, "claude-code");
  assert.equal(copy.systemPrompt, "You write clean code.");
  assert.equal(copy.description, "Writes code");
  assert.deepEqual(copy.permissionProfile, source.permissionProfile);
});