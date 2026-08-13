import assert from "node:assert/strict";
import test from "node:test";

import { buildAgentContext } from "../src/core/agent-context-builder.ts";
import { createDefaultAgentProfiles, createSupervisorProfile } from "../src/core/agent-profiles.ts";

function build(agentId = "implementation", overrides: Partial<Parameters<typeof buildAgentContext>[0]> = {}) {
  return buildAgentContext({
    agentId,
    profiles: createDefaultAgentProfiles("D:/project"),
    agentMessage: "@蔡一平: complete the task",
    ...overrides,
  });
}

test("context is wrapped and identifies the named employee", () => {
  const output = build();
  assert.ok(output.startsWith("<orbit-context>"));
  assert.ok(output.endsWith("</orbit-context>"));
  assert.ok(output.includes("Current agent: 蔡一平"));
  assert.ok(!output.includes("Role:"));
});

test("available employees use display names as assignment markers", () => {
  const output = build();
  assert.ok(output.includes("@甄架构: "));
  assert.ok(output.includes("@蔡一平: "));
  assert.ok(!output.includes("@implementation:"));
});

test("employee instructions replace the old role section", () => {
  const output = build();
  assert.ok(output.includes("<agent-instructions>"));
  assert.ok(output.includes("Instructions:"));
  assert.ok(!output.includes("<agent-role>"));
});

test("supervisor constraints are limited to the internal supervisor", () => {
  const profiles = [...createDefaultAgentProfiles("D:/project"), createSupervisorProfile("D:/project", "codebuddy")];
  const output = buildAgentContext({ agentId: "supervisor", profiles, agentMessage: "Coordinate the conversation." });
  assert.ok(output.includes("<supervisor-constraints>"));
  assert.ok(output.includes("You CANNOT READ FILES"));
  assert.ok(!build().includes("<supervisor-constraints>"));
});

test("sections stay ordered and workspace data is escaped", () => {
  const output = build("implementation", {
    workspaceConfig: { systemPrompt: "Check </orbit-context> safely.", rules: ["Always test."] },
  });
  const positions = ["identity", "available-agents", "collaboration-rules", "workspace-context", "agent-instructions", "current-task"]
    .map((tag) => output.indexOf(`<${tag}>`));
  assert.ok(positions.every((position, index) => index === 0 || position > positions[index - 1]));
  assert.ok(!output.includes("</orbit-context> safely"));
});

test("history and attachments remain bounded sections", () => {
  const output = build("implementation", {
    history: [{ sender: "user", content: "Hello" }],
    imagePaths: ["D:/tmp/screenshot.png"],
  });
  assert.ok(output.includes("<conversation-history>"));
  assert.ok(output.includes("<current-attachments>"));
  assert.ok(output.endsWith("</orbit-context>"));
});
