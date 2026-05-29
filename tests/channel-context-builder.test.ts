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
