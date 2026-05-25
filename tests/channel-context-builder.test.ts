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
  assert.ok(context.includes("@tester: Tester"));
  assert.ok(context.includes("[Full channel message]"));
  assert.ok(context.includes("@developer: implement queue @tester: verify it"));
  assert.ok(context.includes("Permission profile:"));
  assert.ok(context.includes("Orbit has already scheduled the other agents"));
  assert.ok(context.includes("Do not start by repeating the full channel message"));
});
