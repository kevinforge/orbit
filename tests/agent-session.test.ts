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
          kill() {},
          pid: 12345,
          interrupt() {},
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
          kill() {},
          pid: 12345,
          interrupt() {},
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
          kill() {},
          pid: 12345,
          interrupt() {},
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

test("interrupt does NOT clear session — preserves conversation context", async () => {
  const dir = tmpDir();
  const store = new SessionStore(dir);

  // Pre-populate a session that should survive interrupt
  store.save("codebuddy", "default", "developer", {
    agentId: "developer",
    runtime: "codebuddy",
    sessionId: "session-before-interrupt",
    lastRunAt: new Date().toISOString(),
    runCount: 1,
  });

  let interruptCalled = false;
  const deferredResult: { resolve: (value: string) => void; reject: (error: Error) => void } = {
    resolve: () => {},
    reject: () => {},
  };
  const resultPromise = new Promise<string>((res, rej) => {
    deferredResult.resolve = res;
    deferredResult.reject = rej;
  });

  const runtime: AgentRuntime = {
    kind: "codebuddy",
    run() {
      return {
        process: {
          kill() {},
          pid: 12345,
          interrupt() { interruptCalled = true; },
        },
        result: resultPromise,
        sessionId: Promise.resolve("new-session-after-interrupt"),
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
  session.send("run-1", "hello");

  // Wait a tick for the run to start
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Interrupt the running run with the correct runId
  const interrupted = session.interrupt("run-1");
  assert.equal(interrupted, true);
  assert.equal(interruptCalled, true);

  // Session should NOT be cleared — the original session should still exist
  const sessionAfterInterrupt = store.load("codebuddy", "default", "developer");
  assert.equal(sessionAfterInterrupt?.sessionId, "session-before-interrupt", "session should survive interrupt");
});

test("error case (rate limit) still persists sessionId if one was generated", async () => {
  const dir = tmpDir();
  const store = new SessionStore(dir);

  // Pre-populate an existing session
  store.save("claude-code", "default", "developer", {
    agentId: "developer",
    runtime: "claude-code",
    sessionId: "old-session",
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
          kill() {},
          pid: 12345,
          interrupt() {},
        },
        // CLI fails with rate limit error, but still generates a new sessionId
        result: Promise.reject(new Error("API Error: Request rejected (429) · Daily limit exceeded (2000/2000)")),
        sessionId: Promise.resolve("new-session-after-error"),
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

  try {
    await session.send("run-1", "hello");
    assert.fail("should have thrown rate limit error");
  } catch (error) {
    assert.ok((error as Error).message.includes("429"));
  }

  // Session should be updated to the new sessionId even though the run failed
  const sessionAfterError = store.load("claude-code", "default", "developer");
  assert.equal(sessionAfterError?.sessionId, "new-session-after-error", "sessionId should be persisted even on error");
  assert.equal(sessionAfterError?.runCount, 2, "runCount should be incremented");
});

test("interrupt followed by result reject should NOT change status to error", async () => {
  const dir = tmpDir();
  const store = new SessionStore(dir);

  let interruptCalled = false;
  const deferredResult: { resolve: (value: string) => void; reject: (error: Error) => void } = {
    resolve: () => {},
    reject: () => {},
  };
  const resultPromise = new Promise<string>((res, rej) => {
    deferredResult.resolve = res;
    deferredResult.reject = rej;
  });

  const runtime: AgentRuntime = {
    kind: "claude-code",
    run() {
      return {
        process: {
          kill() {},
          pid: 12345,
          interrupt() { interruptCalled = true; },
        },
        result: resultPromise,
        sessionId: Promise.resolve("session-after-interrupt"),
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
  const sendPromise = session.send("run-1", "hello");

  // Wait a tick for the run to start
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Interrupt the running run
  const interrupted = session.interrupt("run-1");
  assert.equal(interrupted, true);
  assert.equal(interruptCalled, true);

  // Status should be idle after interrupt
  assert.equal(session.getStatus(), "idle", "status should be idle immediately after interrupt");

  // Simulate what happens when the killed process exits: result promise rejects
  deferredResult.reject(new Error("Process killed: exit code 137"));

  // Wait for the catch handler to run and catch the expected rejection
  try {
    await sendPromise;
    assert.fail("send should have rejected after interrupt");
  } catch (error) {
    assert.ok((error as Error).message.includes("Process killed"));
  }

  // CRITICAL: Status should STILL be idle, NOT error
  // This is the bug we're testing for - catch() should not overwrite idle status
  assert.equal(session.getStatus(), "idle", "status should remain idle after interrupt-induced reject, not become error");
});
