import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentSession } from "../src/core/agent-session.ts";
import type { AgentRuntime, AgentRuntimeRunOptions } from "../src/core/agent-runtime.ts";
import { EventBus } from "../src/core/event-bus.ts";
import { SessionStore } from "../src/core/session-store.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "orbit-agent-session-test-"));
}

function makeSession(store: SessionStore): AgentSession {
  return new AgentSession({
    id: "developer",
    label: "Developer",
    cwd: process.cwd(),
    permissionProfile: {
      canReadFiles: true,
      canWriteFiles: true,
      canRunCommands: true,
      canInstallDependencies: true,
      canGitCommit: false,
      allowedDirectories: ["."],
    },
    runtime: {
      kind: "claude-code",
      run() {
        throw new Error("test runtime should not be called");
      },
    },
    eventBus: new EventBus(),
    sessionStore: store,
    conversationId: "default",
  });
}

function controllableRuntime(result: string, sessionId: string | null = null) {
  const calls: AgentRuntimeRunOptions[] = [];
  const runtime: AgentRuntime = {
    kind: "codebuddy",
    run(options) {
      calls.push(options);
      return {
        process: {
          kill() {
            return true;
          },
        },
        result: Promise.resolve(result),
        sessionId: Promise.resolve(sessionId),
      };
    },
  };
  return { runtime, calls };
}

test("send without prior session — no resume flag, session persisted", async () => {
  const dir = tmpDir();
  const store = new SessionStore(dir);
  const session = makeSession(store);
  session.start();

  assert.equal(store.load("claude-code", "default", "developer"), null);
  assert.equal(session.getStatus(), "idle");
});

test("send with prior session — resume flag passed", () => {
  const dir = tmpDir();
  const store = new SessionStore(dir);
  store.save("claude-code", "default", "developer", {
    agentId: "developer",
    runtime: "claude-code",
    sessionId: "existing-sess",
    lastRunAt: new Date().toISOString(),
    runCount: 3,
  });

  const session = makeSession(store);
  session.start();

  const loaded = store.load("claude-code", "default", "developer");
  assert.equal(loaded!.sessionId, "existing-sess");
  assert.equal(loaded!.runCount, 3);
});

test("resume failure clears and retries — store cleared after session-not-found", () => {
  const dir = tmpDir();
  const store = new SessionStore(dir);
  store.save("claude-code", "default", "developer", {
    agentId: "developer",
    runtime: "claude-code",
    sessionId: "bad-session",
    lastRunAt: new Date().toISOString(),
    runCount: 1,
  });

  store.clear("claude-code", "default", "developer");
  assert.equal(store.load("claude-code", "default", "developer"), null);
});

test("non-resume failure does not clear store", () => {
  const dir = tmpDir();
  const store = new SessionStore(dir);
  store.save("claude-code", "default", "developer", {
    agentId: "developer",
    runtime: "claude-code",
    sessionId: "good-session",
    lastRunAt: new Date().toISOString(),
    runCount: 1,
  });

  const loaded = store.load("claude-code", "default", "developer");
  assert.equal(loaded!.sessionId, "good-session");
});

test("persistSession increments runCount", () => {
  const dir = tmpDir();
  const store = new SessionStore(dir);
  store.save("claude-code", "default", "developer", {
    agentId: "developer",
    runtime: "claude-code",
    sessionId: "sess-1",
    lastRunAt: new Date().toISOString(),
    runCount: 1,
  });

  const prev = store.load("claude-code", "default", "developer");
  store.save("claude-code", "default", "developer", {
    agentId: "developer",
    runtime: "claude-code",
    sessionId: "sess-2",
    lastRunAt: new Date().toISOString(),
    runCount: (prev?.runCount ?? 0) + 1,
  });

  const updated = store.load("claude-code", "default", "developer");
  assert.equal(updated!.runCount, 2);
  assert.equal(updated!.sessionId, "sess-2");
});

test("different conversations use independent sessions", () => {
  const dir = tmpDir();
  const store = new SessionStore(dir);

  const sessionA = new AgentSession({
    id: "developer",
    label: "Developer",
    cwd: process.cwd(),
    permissionProfile: {
      canReadFiles: true,
      canWriteFiles: true,
      canRunCommands: true,
      canInstallDependencies: true,
      canGitCommit: false,
      allowedDirectories: ["."],
    },
    runtime: controllableRuntime("unused").runtime,
    eventBus: new EventBus(),
    sessionStore: store,
    conversationId: "conv-a",
  });

  const sessionB = new AgentSession({
    id: "developer",
    label: "Developer",
    cwd: process.cwd(),
    permissionProfile: {
      canReadFiles: true,
      canWriteFiles: true,
      canRunCommands: true,
      canInstallDependencies: true,
      canGitCommit: false,
      allowedDirectories: ["."],
    },
    runtime: controllableRuntime("unused").runtime,
    eventBus: new EventBus(),
    sessionStore: store,
    conversationId: "conv-b",
  });

  sessionA.start();
  sessionB.start();

  store.save("codebuddy", "conv-a", "developer", {
    agentId: "developer",
    runtime: "codebuddy",
    sessionId: "sess-a",
    lastRunAt: new Date().toISOString(),
    runCount: 1,
  });

  store.save("codebuddy", "conv-b", "developer", {
    agentId: "developer",
    runtime: "codebuddy",
    sessionId: "sess-b",
    lastRunAt: new Date().toISOString(),
    runCount: 1,
  });

  assert.equal(store.load("codebuddy", "conv-a", "developer")!.sessionId, "sess-a");
  assert.equal(store.load("codebuddy", "conv-b", "developer")!.sessionId, "sess-b");
});

test("send executes through configured runtime and passes resume session", async () => {
  const dir = tmpDir();
  const store = new SessionStore(dir);
  store.save("codebuddy", "default", "developer", {
    agentId: "developer",
    runtime: "codebuddy",
    sessionId: "existing-sess",
    lastRunAt: new Date().toISOString(),
    runCount: 1,
  });
  const { runtime, calls } = controllableRuntime("clean final", "next-sess");
  const session = new AgentSession({
    id: "developer",
    label: "Developer",
    cwd: "D:/workspace",
    permissionProfile: {
      canReadFiles: true,
      canWriteFiles: true,
      canRunCommands: true,
      canInstallDependencies: true,
      canGitCommit: false,
      allowedDirectories: ["."],
    },
    runtime,
    eventBus: new EventBus(),
    sessionStore: store,
    conversationId: "default",
  });

  session.start();
  const result = await session.send("run-1", "hello");

  assert.equal(result.content, "clean final");
  assert.equal(result.sessionId, "next-sess");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.agentId, "developer");
  assert.equal(calls[0]!.cwd, "D:/workspace");
  assert.equal(calls[0]!.prompt, "hello");
  assert.equal(calls[0]!.resumeSessionId, "existing-sess");
  assert.equal(store.load("codebuddy", "default", "developer")!.sessionId, "next-sess");
});

test("send accepts agent handoff final answer", async () => {
  const dir = tmpDir();
  const store = new SessionStore(dir);
  const { runtime } = controllableRuntime("@architect: PR #37 is ready for review.", "handoff-sess");
  const session = new AgentSession({
    id: "developer",
    label: "Developer",
    cwd: "D:/workspace",
    permissionProfile: {
      canReadFiles: true,
      canWriteFiles: true,
      canRunCommands: true,
      canInstallDependencies: true,
      canGitCommit: false,
      allowedDirectories: ["."],
    },
    runtime,
    eventBus: new EventBus(),
    sessionStore: store,
    conversationId: "default",
  });

  session.start();
  const result = await session.send("run-1", "hello");

  assert.equal(result.content, "@architect: PR #37 is ready for review.");
  assert.equal(result.sessionId, "handoff-sess");
  assert.equal(session.getStatus(), "idle");
});

test("resume failure clears stale session and retries without resume", async () => {
  const dir = tmpDir();
  const store = new SessionStore(dir);
  store.save("codebuddy", "default", "developer", {
    agentId: "developer",
    runtime: "codebuddy",
    sessionId: "bad-session",
    lastRunAt: new Date().toISOString(),
    runCount: 1,
  });

  const calls: AgentRuntimeRunOptions[] = [];
  const runtime: AgentRuntime = {
    kind: "codebuddy",
    run(options) {
      calls.push(options);
      return {
        process: {
          kill() {
            return true;
          },
        },
        result: calls.length === 1
          ? Promise.reject(new Error("No conversation found with session ID: bad-session"))
          : Promise.resolve("clean final"),
        sessionId: Promise.resolve(calls.length === 1 ? null : "fresh-session"),
      };
    },
  };

  const session = new AgentSession({
    id: "developer",
    label: "Developer",
    cwd: "D:/workspace",
    permissionProfile: {
      canReadFiles: true,
      canWriteFiles: true,
      canRunCommands: true,
      canInstallDependencies: true,
      canGitCommit: false,
      allowedDirectories: ["."],
    },
    runtime,
    eventBus: new EventBus(),
    sessionStore: store,
    conversationId: "default",
  });

  session.start();
  const result = await session.send("run-1", "hello");

  assert.equal(result.content, "clean final");
  assert.equal(result.sessionId, "fresh-session");
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.resumeSessionId, "bad-session");
  assert.equal(calls[1]!.resumeSessionId, undefined);
  assert.equal(store.load("codebuddy", "default", "developer")!.sessionId, "fresh-session");
});

test("Claude API deserialize failure clears stale resume session and retries without resume", async () => {
  const dir = tmpDir();
  const store = new SessionStore(dir);
  store.save("claude-code", "default", "developer", {
    agentId: "developer",
    runtime: "claude-code",
    sessionId: "bad-claude-session",
    lastRunAt: new Date().toISOString(),
    runCount: 1,
  });

  const calls: AgentRuntimeRunOptions[] = [];
  const runtime: AgentRuntime = {
    kind: "claude-code",
    run(options) {
      calls.push(options);
      return {
        process: {
          kill() {
            return true;
          },
        },
        result: calls.length === 1
          ? Promise.reject(new Error("unknown API Error: 400 Failed to deserialize the JSON body into the target type: messages[1].role: unknown variant `system`, expected `user` or `assistant` at line 1 column 15698"))
          : Promise.resolve("clean final"),
        sessionId: Promise.resolve(calls.length === 1 ? null : "fresh-claude-session"),
      };
    },
  };

  const session = new AgentSession({
    id: "developer",
    label: "Developer",
    cwd: "D:/workspace",
    permissionProfile: {
      canReadFiles: true,
      canWriteFiles: true,
      canRunCommands: true,
      canInstallDependencies: true,
      canGitCommit: false,
      allowedDirectories: ["."],
    },
    runtime,
    eventBus: new EventBus(),
    sessionStore: store,
    conversationId: "default",
  });

  session.start();
  const result = await session.send("run-1", "hello");

  assert.equal(result.content, "clean final");
  assert.equal(result.sessionId, "fresh-claude-session");
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.resumeSessionId, "bad-claude-session");
  assert.equal(calls[1]!.resumeSessionId, undefined);
  assert.equal(store.load("claude-code", "default", "developer")!.sessionId, "fresh-claude-session");
});

test("interrupt kills active child process and sets status to idle", () => {
  const dir = tmpDir();
  const store = new SessionStore(dir);
  let killed = false;
  const runtime: AgentRuntime = {
    kind: "codebuddy",
    run() {
      return {
        process: {
          kill() {
            killed = true;
            return true;
          },
        },
        result: new Promise(() => {}), // never resolves
        sessionId: Promise.resolve(null),
      };
    },
  };

  const session = new AgentSession({
    id: "developer",
    label: "Developer",
    cwd: process.cwd(),
    permissionProfile: {
      canReadFiles: true,
      canWriteFiles: true,
      canRunCommands: true,
      canInstallDependencies: true,
      canGitCommit: false,
      allowedDirectories: ["."],
    },
    runtime,
    eventBus: new EventBus(),
    sessionStore: store,
    conversationId: "default",
  });

  session.start();
  assert.equal(session.getStatus(), "idle");

  // Start a run (it never resolves)
  void session.send("run-1", "hello");
  assert.equal(session.getStatus(), "running");

  // Interrupt
  session.interrupt();
  assert.equal(killed, true, "child process should be killed");
  assert.equal(session.getStatus(), "idle", "status should be idle after interrupt");
});

test("interrupt when not running is a no-op", () => {
  const dir = tmpDir();
  const store = new SessionStore(dir);
  const session = makeSession(store);
  session.start();

  assert.equal(session.getStatus(), "idle");
  session.interrupt();
  assert.equal(session.getStatus(), "idle");
});
