import assert from "node:assert/strict";
import test from "node:test";

import { createDefaultAgentProfiles } from "../src/core/agent-profiles.ts";

test("loads four default Orbit roles", () => {
  const profiles = createDefaultAgentProfiles("D:/project");

  assert.deepEqual(
    profiles.map((profile) => profile.id),
    ["pm", "architect", "developer", "tester"],
  );
  assert.deepEqual(
    profiles.map((profile) => profile.role),
    ["pm", "architect", "developer", "tester"],
  );
});

test("developer can write files while pm cannot", () => {
  const profiles = createDefaultAgentProfiles("D:/project");
  const pm = profiles.find((profile) => profile.id === "pm");
  const developer = profiles.find((profile) => profile.id === "developer");

  assert.equal(pm?.permissionProfile.canWriteFiles, false);
  assert.equal(developer?.permissionProfile.canWriteFiles, true);
});

