import assert from "node:assert/strict";
import test from "node:test";

import { createDefaultAgentProfiles } from "../src/core/agent-profiles.ts";
import { buildAgentContext } from "../src/core/agent-context-builder.ts";

test("builds structured context for current agent", () => {
  const profiles = createDefaultAgentProfiles("D:/project");
  const context = buildAgentContext({
    agentId: "developer",
    profiles,
    agentMessage: "@developer: implement queue @tester: verify it",
  });

  assert.ok(context.includes("[Orbit Context]"));
  assert.ok(context.includes("Current agent: Developer (@developer)"));
  assert.ok(context.includes("@tester: Tester - Validates behavior, runs tests, reports risks."));
  assert.ok(context.includes("[Current task]"));
  assert.ok(context.includes("@developer: implement queue @tester: verify it"));
  assert.ok(context.includes("Permission profile:"));
  assert.ok(context.includes("Orbit has already scheduled the other agents"));
  assert.ok(context.includes("Do not start by repeating the conversation"));
});

test("agent context uses ASCII collaboration punctuation", () => {
  const profiles = createDefaultAgentProfiles("D:/project");
  const context = buildAgentContext({
    agentId: "developer",
    profiles,
    agentMessage: "@developer: test",
  });

  assert.ok(!context.includes("\u2014"));
  assert.ok(!context.includes("\u2192"));
});

test("includes description in available agents list", () => {
  const profiles = createDefaultAgentProfiles("D:/project");
  const context = buildAgentContext({
    agentId: "developer",
    profiles,
    agentMessage: "@developer: test",
  });

  assert.ok(context.includes("@pm: Product Manager - Clarifies requirements, defines scope and acceptance criteria."));
  assert.ok(context.includes("@architect: Architect - Designs technical boundaries, reviews implementation risk."));
  assert.ok(context.includes("@developer: Developer - Implements features with TDD, creates branches and draft PRs."));
});

test("available agents omits description when empty without extra formatting", () => {
  const profiles = [
    {
      id: "pm",
      name: "PM",
      description: undefined,
      role: "pm" as const,
      runtime: "claude-code" as const,
      cwd: "D:/project",
      systemPrompt: "You are a PM.",
      permissionProfile: {
        canReadFiles: true,
        canWriteFiles: false,
        canRunCommands: false,
        canInstallDependencies: false,
        canGitCommit: false,
        allowedDirectories: [],
      },
    },
    {
      id: "dev",
      name: "Dev",
      description: "",
      role: "developer" as const,
      runtime: "claude-code" as const,
      cwd: "D:/project",
      systemPrompt: "You are a Dev.",
      permissionProfile: {
        canReadFiles: true,
        canWriteFiles: true,
        canRunCommands: true,
        canInstallDependencies: true,
        canGitCommit: true,
        allowedDirectories: [],
      },
    },
  ];

  const context = buildAgentContext({
    agentId: "dev",
    profiles,
    agentMessage: "@dev: test",
  });

  assert.ok(context.includes("@pm: PM\n"), "should not have trailing dash for empty description");
  assert.ok(context.includes("@dev: Dev\n"), "should not have trailing dash for empty-string description");
  assert.ok(!context.includes(" -\n"), "no bare separator");
});

test("includes few-shot collaboration examples in context", () => {
  const profiles = createDefaultAgentProfiles("D:/project");
  const context = buildAgentContext({
    agentId: "developer",
    profiles,
    agentMessage: "@developer: test",
  });

  assert.ok(context.includes("Collaboration examples:"), "should have examples section header");
  assert.ok(context.includes("@reviewer") || context.includes("@agent:"), "examples should demonstrate assignment syntax");
  assert.ok(context.includes("No further work"), "should show when not to hand off");
});

test("plain mention in agent reply does not trigger routing", () => {
  const profiles = createDefaultAgentProfiles("D:/project");
  const context = buildAgentContext({
    agentId: "developer",
    profiles,
    agentMessage: "@developer: implement feature",
  });

  assert.ok(context.includes("Plain @agent mentions without a colon are references only"), "rules must mention plain mentions are references");
  assert.ok(context.includes("@agent: assignment marker"), "rules must mention assignment marker");
});

// --- Workspace config injection ---

test("includes workspace systemPrompt when provided", () => {
  const profiles = createDefaultAgentProfiles("D:/project");
  const context = buildAgentContext({
    agentId: "developer",
    profiles,
    agentMessage: "@developer: test",
    workspaceConfig: {
      systemPrompt: "This is a workspace-level instruction.",
      rules: [],
    },
  });

  assert.ok(context.includes("Workspace prompt:"));
  assert.ok(context.includes("This is a workspace-level instruction."));
});

test("workspace prompt appears after fixed rules and before role instruction", () => {
  const profiles = createDefaultAgentProfiles("D:/project");
  const context = buildAgentContext({
    agentId: "developer",
    profiles,
    agentMessage: "@developer: test",
    workspaceConfig: {
      systemPrompt: "WORKSPACE_PROMPT_MARKER",
      rules: ["WORKSPACE_RULE_MARKER"],
    },
  });

  const finalAnswerIndex = context.indexOf("Final answer rules:");
  const workspacePromptIndex = context.indexOf("Workspace prompt:");
  const workspaceRulesIndex = context.indexOf("Workspace rules:");
  const roleInstructionIndex = context.indexOf("Role instruction:");
  const taskIndex = context.indexOf("[Current task]");

  assert.ok(finalAnswerIndex < workspacePromptIndex, "workspace prompt should appear after final answer rules");
  assert.ok(workspacePromptIndex < roleInstructionIndex, "workspace prompt should appear before role instruction");
  assert.ok(workspaceRulesIndex < roleInstructionIndex, "workspace rules should appear before role instruction");
  assert.ok(roleInstructionIndex < taskIndex, "role instruction should appear before current task");
});

test("includes workspace rules when provided", () => {
  const profiles = createDefaultAgentProfiles("D:/project");
  const context = buildAgentContext({
    agentId: "developer",
    profiles,
    agentMessage: "@developer: test",
    workspaceConfig: {
      systemPrompt: "",
      rules: ["All code must have tests.", "Use TypeScript strict mode."],
    },
  });

  assert.ok(context.includes("Workspace rules:"));
  assert.ok(context.includes("- All code must have tests."));
  assert.ok(context.includes("- Use TypeScript strict mode."));
});

test("workspace rules and systemPrompt can coexist in context", () => {
  const profiles = createDefaultAgentProfiles("D:/project");
  const context = buildAgentContext({
    agentId: "developer",
    profiles,
    agentMessage: "@developer: test",
    workspaceConfig: {
      systemPrompt: "Workspace-level prompt.",
      rules: ["Rule 1", "Rule 2"],
    },
  });

  assert.ok(context.includes("Workspace prompt:"));
  assert.ok(context.includes("Workspace-level prompt."));
  assert.ok(context.includes("Workspace rules:"));
  assert.ok(context.includes("- Rule 1"));
  assert.ok(context.includes("- Rule 2"));
});

test("no workspace config injected when workspaceConfig is not provided", () => {
  const profiles = createDefaultAgentProfiles("D:/project");
  const context = buildAgentContext({
    agentId: "developer",
    profiles,
    agentMessage: "@developer: test",
  });

  assert.ok(!context.includes("Workspace prompt:"));
  assert.ok(!context.includes("Workspace rules:"));
});

test("empty workspace config does not inject markers", () => {
  const profiles = createDefaultAgentProfiles("D:/project");
  const context = buildAgentContext({
    agentId: "developer",
    profiles,
    agentMessage: "@developer: test",
    workspaceConfig: {
      systemPrompt: "",
      rules: [],
    },
  });

  assert.ok(!context.includes("Workspace prompt:"));
  assert.ok(!context.includes("Workspace rules:"));
});

test("supervisor context includes strict tool constraint block", () => {
  const profiles = [
    ...createDefaultAgentProfiles("D:/project"),
    {
      id: "supervisor",
      name: "Supervisor",
      description: "Coordinates agents.",
      role: "coordinator" as const,
      runtime: "claude-code" as const,
      cwd: "D:/project",
      systemPrompt: "You coordinate.",
      permissionProfile: {
        canReadFiles: false,
        canWriteFiles: false,
        canRunCommands: false,
        canInstallDependencies: false,
        canGitCommit: false,
        allowedDirectories: [],
      },
    },
  ];

  const context = buildAgentContext({
    agentId: "supervisor",
    profiles,
    agentMessage: "Evaluate the conversation state.",
  });

  assert.ok(context.includes("[Supervisor Constraints]"), "supervisor context should include constraints block");
  assert.ok(context.includes("YOU CANNOT READ FILES"), "should explicitly forbid reading files");
  assert.ok(context.includes("YOU CANNOT RUN COMMANDS"), "should explicitly forbid running commands");
  assert.ok(context.includes("YOU CANNOT SEARCH CODE"), "should explicitly forbid searching code");
  assert.ok(context.includes("Delegation guide:"), "should provide delegation guidance");
});

test("non-supervisor context does not include supervisor constraints block", () => {
  const profiles = createDefaultAgentProfiles("D:/project");
  const context = buildAgentContext({
    agentId: "developer",
    profiles,
    agentMessage: "@developer: implement feature",
  });

  assert.ok(!context.includes("[Supervisor Constraints]"), "non-coordinator agents should not see supervisor constraints");
});

test("context is still valid with workspace config (regression check)", () => {
  const profiles = createDefaultAgentProfiles("D:/project");
  const context = buildAgentContext({
    agentId: "developer",
    profiles,
    agentMessage: "@developer: test",
    workspaceConfig: {
      systemPrompt: "Be extra careful.",
      rules: ["Never push to main.", "Always review before merge."],
    },
  });

  // All essential sections still present
  assert.ok(context.includes("[Orbit Context]"));
  assert.ok(context.includes("Current agent: Developer (@developer)"));
  assert.ok(context.includes("Permission profile:"));
  assert.ok(context.includes("Available agents:"));
  assert.ok(context.includes("Collaboration rules:"));
  assert.ok(context.includes("Final answer rules:"));
  assert.ok(context.includes("[Current task]"));
  assert.ok(context.includes("@developer: test"));
});
