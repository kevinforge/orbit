import assert from "node:assert/strict";
import test from "node:test";

import { configsToProfiles, createDefaultAgentProfiles } from "../src/core/agent-profiles.ts";
import { DEFAULT_AGENT_CONFIGS } from "../src/core/agent-config-store.ts";

test("default profiles use the generic software team members", () => {
  const profiles = createDefaultAgentProfiles("D:/project");
  assert.deepEqual(profiles.map((profile) => profile.id), ["requirements", "solution", "implementation", "verification"]);
  assert.ok(profiles.every((profile) => !("role" in profile)));
});

test("runtime overrides target ids without changing names", () => {
  const profiles = createDefaultAgentProfiles("D:/project", { implementation: "codebuddy", verification: "codex" });
  assert.equal(profiles.find((profile) => profile.id === "implementation")?.runtime, "codebuddy");
  assert.equal(profiles.find((profile) => profile.id === "verification")?.runtime, "codex");
});

test("configsToProfiles keeps user names and omits configuration-only fields", () => {
  const profiles = configsToProfiles([{ ...DEFAULT_AGENT_CONFIGS[0], name: "我的分析员", enabled: true }], "D:/project");
  assert.equal(profiles[0]?.name, "我的分析员");
  assert.equal("enabled" in (profiles[0] ?? {}), false);
  assert.equal("role" in (profiles[0] ?? {}), false);
});
