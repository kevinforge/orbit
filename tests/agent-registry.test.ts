import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentRegistry } from "../src/core/agent-registry.ts";
import type { AgentRuntime } from "../src/core/agent-runtime.ts";
import { createDefaultAgentProfiles } from "../src/core/agent-profiles.ts";
import { EventBus } from "../src/core/event-bus.ts";
import { SessionStore } from "../src/core/session-store.ts";

function createTempSessionStore(): SessionStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-agent-registry-"));
  return new SessionStore(dir);
}

test("creates sessions with the runtime selected by each profile", async () => {
  const profiles = createDefaultAgentProfiles(process.cwd()).map((profile) =>
    profile.id === "tester" ? { ...profile, runtime: "codebuddy" as const } : profile,
  );
  const calls: string[] = [];
  const codeBuddyRuntime: AgentRuntime = {
    kind: "codebuddy",
    run(options) {
      calls.push(options.agentId);
      return {
        process: { kill: () => true },
        result: Promise.resolve("codebuddy final"),
        sessionId: Promise.resolve("codebuddy-session"),
      };
    },
  };
  const claudeRuntime: AgentRuntime = {
    kind: "claude-code",
    run() {
      throw new Error("Claude runtime should not run for tester");
    },
  };
  const codexRuntime: AgentRuntime = {
    kind: "codex",
    run() {
      throw new Error("Codex runtime should not run for tester");
    },
  };
  const registry = new AgentRegistry(
    profiles,
    new EventBus(),
    createTempSessionStore(),
    "default",
    new Map([
      ["claude-code", claudeRuntime],
      ["codex", codexRuntime],
      ["codebuddy", codeBuddyRuntime],
    ]),
  );

  registry.startAll();
  const result = await registry.get("tester").send("run-1", "hello");

  assert.equal(result.content, "codebuddy final");
  assert.deepEqual(calls, ["tester"]);
});

test("states include each agent runtime", () => {
  const profiles = createDefaultAgentProfiles(process.cwd()).map((profile) =>
    profile.id === "developer" ? { ...profile, runtime: "codebuddy" as const } : profile,
  );
  const runtime: AgentRuntime = {
    kind: "claude-code",
    run() {
      throw new Error("runtime should not run");
    },
  };
  const codeBuddyRuntime: AgentRuntime = {
    ...runtime,
    kind: "codebuddy",
  };
  const codexRuntime: AgentRuntime = {
    ...runtime,
    kind: "codex",
  };
  const registry = new AgentRegistry(
    profiles,
    new EventBus(),
    createTempSessionStore(),
    "default",
    new Map([
      ["claude-code", runtime],
      ["codex", codexRuntime],
      ["codebuddy", codeBuddyRuntime],
    ]),
  );

  const developer = registry.states().find((state) => state.id === "developer");

  assert.equal(developer?.runtime, "codebuddy");
});
