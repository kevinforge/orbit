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
    profile.id === "verification" ? { ...profile, runtime: "codebuddy" as const } : profile,
  );
  const calls: string[] = [];
  const codeBuddyRuntime: AgentRuntime = {
    kind: "codebuddy",
    run(options) {
      calls.push(options.agentId);
      return {
        process: { kill: () => {}, pid: 12345, interrupt: () => {} },
        result: Promise.resolve("codebuddy final"),
        sessionId: Promise.resolve("codebuddy-session"),
      };
    },
  };
  const claudeRuntime: AgentRuntime = {
    kind: "claude-code",
    run() {
      throw new Error("Claude runtime should not run for verification");
    },
  };
  const codexRuntime: AgentRuntime = {
    kind: "codex",
    run() {
      throw new Error("Codex runtime should not run for verification");
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
  const result = await registry.get("verification").send("run-1", "hello");

  assert.equal(result.content, "codebuddy final");
  assert.deepEqual(calls, ["verification"]);
});

test("states include each agent runtime", () => {
  const profiles = createDefaultAgentProfiles(process.cwd()).map((profile) =>
    profile.id === "implementation" ? { ...profile, runtime: "codebuddy" as const } : profile,
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

  const developer = registry.states().find((state) => state.id === "implementation");

  assert.equal(developer?.runtime, "codebuddy");
});

test("updatePreferredModel changes the preference in place without recreating the session", () => {
  const profiles = createDefaultAgentProfiles(process.cwd());
  const noopRuntime: AgentRuntime = {
    kind: "claude-code",
    run() { throw new Error("this test does not start runs"); },
  };
  const codexRuntime: AgentRuntime = { ...noopRuntime, kind: "codex" };
  const codeBuddyRuntime: AgentRuntime = { ...noopRuntime, kind: "codebuddy" };
  const registry = new AgentRegistry(
    profiles,
    new EventBus(),
    createTempSessionStore(),
    "conv-model-only",
    new Map([
      ["claude-code", noopRuntime],
      ["codex", codexRuntime],
      ["codebuddy", codeBuddyRuntime],
    ]),
  );

  const session = registry.get("implementation");
  assert.equal(session.preferredModel(), undefined);

  assert.equal(registry.updatePreferredModel("implementation", "claude-opus-4"), true);
  // 会话实例未变：仅模型变化时不应重建会话、不打断排队/运行中的任务。
  assert.strictEqual(registry.get("implementation"), session);
  assert.equal(session.preferredModel(), "claude-opus-4");
  assert.equal(registry.profile("implementation")?.preferredModelId, "claude-opus-4");

  // 清空偏好：整字段移除，而不是留空字符串。
  assert.equal(registry.updatePreferredModel("implementation", "   "), true);
  assert.equal(session.preferredModel(), undefined);
  assert.equal("preferredModelId" in (registry.profile("implementation") ?? {}), false);

  assert.equal(registry.updatePreferredModel("unknown-employee", "claude-opus-4"), false);
});

test("an updated preference reaches the runtime on the next run only", async () => {
  const profiles = createDefaultAgentProfiles(process.cwd());
  const seen: Array<string | undefined> = [];
  const codexRuntime: AgentRuntime = {
    kind: "codex",
    run(options) {
      seen.push(options.preferredModelId);
      return {
        process: { kill: () => {}, pid: 12345, interrupt: () => {} },
        result: Promise.resolve("codex final"),
        sessionId: Promise.resolve("codex-session"),
      };
    },
  };
  const noopRuntime: AgentRuntime = {
    kind: "claude-code",
    run() { throw new Error("only the codex employee runs in this test"); },
  };
  const registry = new AgentRegistry(
    profiles,
    new EventBus(),
    createTempSessionStore(),
    "conv-next-run",
    new Map([
      ["claude-code", noopRuntime],
      ["codex", codexRuntime],
      ["codebuddy", { ...noopRuntime, kind: "codebuddy" }],
    ]),
  );
  registry.startAll();

  await registry.get("requirements").send("run-1", "first");
  registry.updatePreferredModel("requirements", "gpt-5-codex");
  await registry.get("requirements").send("run-2", "second");

  assert.deepEqual(seen, [undefined, "gpt-5-codex"]);
});
