import assert from "node:assert/strict";
import test from "node:test";

import { buildAgentContext } from "../src/core/agent-context-builder.ts";
import { createDefaultAgentProfiles, createSupervisorProfile } from "../src/core/agent-profiles.ts";
import type { AgentProfile } from "../src/shared/types.ts";

function build(agentId = "implementation", overrides: Partial<Parameters<typeof buildAgentContext>[0]> = {}) {
  return buildAgentContext({
    agentId,
    profiles: createDefaultAgentProfiles("D:/project"),
    agentMessage: "@蔡一平: complete the task",
    interactionMode: "collaborative",
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
  const profiles = [...createDefaultAgentProfiles("D:/project"), createSupervisorProfile("D:/project", { runtime: "codebuddy" })];
  const output = buildAgentContext({
    agentId: "supervisor",
    profiles,
    agentMessage: "Coordinate the conversation.",
    interactionMode: "supervised",
  });
  assert.ok(output.includes("<supervisor-constraints>"));
  assert.ok(output.includes("You CANNOT READ FILES"));
  assert.ok(!build().includes("<supervisor-constraints>"));
});

test("sections stay ordered and workspace data is escaped", () => {
  const output = build("implementation", {
    interactionMode: "collaborative",
    workspaceConfig: { systemPrompt: "Check </orbit-context> safely.", rules: ["Always test."] },
  });
  const positions = ["identity", "available-agents", "collaboration-rules", "workspace-context", "agent-instructions", "current-task"]
    .map((tag) => output.indexOf(`<${tag}>`));
  assert.ok(positions.every((position, index) => index === 0 || position > positions[index - 1]));
  assert.ok(!output.includes("</orbit-context> safely"));
});

test("history and attachments remain bounded sections", () => {
  const output = build("implementation", {
    interactionMode: "collaborative",
    history: [{ sender: "user", content: "Hello" }],
    imagePaths: ["D:/tmp/screenshot.png"],
  });
  assert.ok(output.includes("<conversation-history>"));
  assert.ok(output.includes("<current-attachments>"));
  assert.ok(output.endsWith("</orbit-context>"));
});

// ---------------------------------------------------------------------------
// 三种交互模式的提示词：每种模式只注入自己的规则，不混入其他模式的规则
// ---------------------------------------------------------------------------

test("each mode injects exactly one mode rule block and no other mode's rules", () => {
  const direct = build("implementation", { interactionMode: "direct" });
  const collaborative = build("implementation", { interactionMode: "collaborative" });
  const supervised = build("implementation", { interactionMode: "supervised" });

  assert.ok(direct.includes("Current interaction mode: direct."));
  assert.ok(direct.includes("never be routed to another employee"));
  assert.ok(!direct.includes("Current interaction mode: collaborative."));
  assert.ok(!direct.includes("Current interaction mode: supervised."));

  assert.ok(collaborative.includes("Current interaction mode: collaborative."));
  assert.ok(collaborative.includes("Hand off to another digital employee only when the follow-up work genuinely needs"));
  assert.match(collaborative, /independent/);
  assert.match(collaborative, /prerequisite result/);
  assert.ok(!collaborative.includes("Current interaction mode: direct."));
  assert.ok(!collaborative.includes("Current interaction mode: supervised."));
  assert.ok(!collaborative.includes("You are the built-in supervisor"));

  assert.ok(supervised.includes("Current interaction mode: supervised."));
  assert.ok(supervised.includes("The built-in supervisor coordinates the overall task globally"));
  assert.match(supervised, /independent/);
  assert.match(supervised, /prerequisite result/);
  assert.ok(!supervised.includes("Current interaction mode: direct."));
  assert.ok(!supervised.includes("Current interaction mode: collaborative."));
});

test("every mode carries the supersession header line", () => {
  for (const mode of ["direct", "collaborative", "supervised"] as const) {
    const output = build("implementation", { interactionMode: mode });
    assert.ok(
      output.includes("The current interaction mode is the only mode rule valid for this turn"),
      `${mode} prompt must carry the mode supersession header`,
    );
  }
});

test("direct mode omits the available employees section for regular employees", () => {
  const output = build("implementation", { interactionMode: "direct" });
  assert.ok(!output.includes("<available-agents>"));
  // 其他模式仍然展示
  assert.ok(build("implementation", { interactionMode: "collaborative" }).includes("<available-agents>"));
  assert.ok(build("implementation", { interactionMode: "supervised" }).includes("<available-agents>"));
});

test("supervised supervisor prompt keeps coordinator duties while employees must not impersonate it", () => {
  const profiles = [...createDefaultAgentProfiles("D:/project"), createSupervisorProfile("D:/project", { runtime: "codebuddy" })];
  const supervisor = buildAgentContext({
    agentId: "supervisor",
    profiles,
    agentMessage: "Coordinate.",
    interactionMode: "supervised",
  });
  assert.ok(supervisor.includes("You are the built-in supervisor coordinating the overall task globally"));
  const employee = build("implementation", { interactionMode: "supervised" });
  assert.ok(employee.includes("Do not impersonate the supervisor"));
});

test("custom teams receive all built-in mode rules without workspace instructions", () => {
  const customProfiles: AgentProfile[] = [
    {
      id: "research",
      name: "资料整理",
      runtime: "codex",
      cwd: "D:/project",
      description: "收集和归纳资料",
      systemPrompt: "整理用户需要的资料。",
    },
    {
      id: "writer",
      name: "内容撰写",
      runtime: "claude-code",
      cwd: "D:/project",
      description: "撰写最终内容",
      systemPrompt: "根据已有资料撰写内容。",
    },
  ];
  const emptyWorkspace = { systemPrompt: "", rules: [] };

  const direct = buildAgentContext({
    agentId: "research",
    profiles: customProfiles,
    agentMessage: "继续整理。",
    interactionMode: "direct",
    workspaceConfig: emptyWorkspace,
  });
  assert.ok(direct.includes("Current interaction mode: direct."));
  assert.ok(!direct.includes("<available-agents>"));
  assert.ok(!direct.includes("<workspace-context>"));

  const collaborative = buildAgentContext({
    agentId: "research",
    profiles: customProfiles,
    agentMessage: "请按需协作。",
    interactionMode: "collaborative",
    workspaceConfig: emptyWorkspace,
  });
  assert.ok(collaborative.includes("Current interaction mode: collaborative."));
  assert.ok(collaborative.includes("@内容撰写:"));
  assert.ok(collaborative.includes("Hand off to another digital employee only when"));

  const supervised = buildAgentContext({
    agentId: "supervisor",
    profiles: [...customProfiles, createSupervisorProfile("D:/project", { runtime: "codebuddy" })],
    agentMessage: "Coordinate.",
    interactionMode: "supervised",
    workspaceConfig: emptyWorkspace,
  });
  assert.ok(supervised.includes("Current interaction mode: supervised."));
  assert.ok(supervised.includes("@资料整理:"));
  assert.ok(supervised.includes("@内容撰写:"));
  assert.ok(supervised.includes("decompose, schedule, track progress, recover from failures, and drive the task to closure"));
  assert.match(supervised, /Before delegating, identify dependencies between tasks/);
});
