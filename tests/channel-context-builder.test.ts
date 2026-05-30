import assert from "node:assert/strict";
import test from "node:test";

import { createDefaultAgentProfiles } from "../src/core/agent-profiles.ts";
import { buildChannelContext } from "../src/core/channel-context-builder.ts";

test("builds structured context for current agent", () => {
  const profiles = createDefaultAgentProfiles("D:/project");
  const context = buildChannelContext({
    agentId: "developer",
    profiles,
    channelMessage: "@developer: implement queue @tester: verify it",
  });

  assert.ok(context.includes("[Orbit Context]"));
  assert.ok(context.includes("Current agent: Developer (@developer)"));
  assert.ok(context.includes("@tester: Tester — Validates behavior, runs tests, reports risks."));
  assert.ok(context.includes("[Full channel message]"));
  assert.ok(context.includes("@developer: implement queue @tester: verify it"));
  assert.ok(context.includes("Permission profile:"));
  assert.ok(context.includes("Orbit has already scheduled the other agents"));
  assert.ok(context.includes("Do not start by repeating the full channel message"));
});

test("includes description in available agents list", () => {
  const profiles = createDefaultAgentProfiles("D:/project");
  const context = buildChannelContext({
    agentId: "developer",
    profiles,
    channelMessage: "@developer: test",
  });

  assert.ok(context.includes("@pm: Product Manager — Clarifies requirements, defines scope and acceptance criteria."));
  assert.ok(context.includes("@architect: Architect — Designs technical boundaries, reviews implementation risk."));
  assert.ok(context.includes("@developer: Developer — Implements features with TDD, creates branches and draft PRs."));
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

  const context = buildChannelContext({
    agentId: "dev",
    profiles,
    channelMessage: "@dev: test",
  });

  assert.ok(context.includes("@pm: PM\n"), "should not have trailing dash for empty description");
  assert.ok(context.includes("@dev: Dev\n"), "should not have trailing dash for empty-string description");
  assert.ok(!context.includes(" — \n"), "no bare em-dash separator");
});

test("includes few-shot collaboration examples in context", () => {
  const profiles = createDefaultAgentProfiles("D:/project");
  const context = buildChannelContext({
    agentId: "developer",
    profiles,
    channelMessage: "@developer: test",
  });

  // Should contain the collaboration examples section
  assert.ok(context.includes("Collaboration examples:"), "should have examples section header");
  // Should mention the key distinction between @agent (reference) and @agent: (assignment)
  assert.ok(context.includes("@reviewer") || context.includes("@agent:"), "examples should demonstrate assignment syntax");
  // Should include guidance on when NOT to hand off
  assert.ok(context.includes("No further work") || context.includes("不需要交接"), "should show when not to hand off");
});

test("plain mention in agent reply does not trigger routing", () => {
  // This is a documentation/context test: the collaboration rules and examples
  // should make it clear that @agent (no colon) is only a reference.
  const profiles = createDefaultAgentProfiles("D:/project");
  const context = buildChannelContext({
    agentId: "developer",
    profiles,
    channelMessage: "@developer: implement feature",
  });

  assert.ok(context.includes("Plain @agent mentions without a colon are references only"), "rules must mention plain mentions are references");
  assert.ok(context.includes("@agent: assignment marker"), "rules must mention assignment marker");
});
