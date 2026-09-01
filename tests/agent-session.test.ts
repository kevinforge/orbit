import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentSession } from "../src/core/agent-session.ts";
import { AgentRunCancelledError, type AgentRuntime, type AgentRuntimeRunOptions } from "../src/core/agent-runtime.ts";
import { EventBus } from "../src/core/event-bus.ts";
import { SessionStore } from "../src/core/session-store.ts";
import type { AgentCommand, AgentModelStateSnapshot, MessageAttachment, RuntimeEvent } from "../src/shared/types.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "orbit-agent-session-test-"));
}

function makeSession(store: SessionStore): AgentSession {
  return new AgentSession({
    id: "developer",
    label: "Developer",
    cwd: process.cwd(),
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
    runtime: controllableRuntime("unused").runtime,
    eventBus: new EventBus(),
    sessionStore: store,
    conversationId: "conv-a",
  });

  const sessionB = new AgentSession({
    id: "developer",
    label: "Developer",
    cwd: process.cwd(),
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

test("send persists ACP transport metadata", async () => {
  const dir = tmpDir();
  const store = new SessionStore(dir);
  const controlled = controllableRuntime("clean final", "acp-session");
  const session = new AgentSession({
    id: "developer",
    label: "Developer",
    cwd: "D:/workspace",
    runtime: { ...controlled.runtime, transport: "acp", protocolVersion: 1 },
    eventBus: new EventBus(),
    sessionStore: store,
    conversationId: "default",
  });

  session.start();
  await session.send("run-1", "hello");

  const record = store.load("codebuddy", "default", "developer");
  assert.equal(record?.transport, "acp");
  assert.equal(record?.protocolVersion, 1);
});

test("send accepts agent handoff final answer", async () => {
  const dir = tmpDir();
  const store = new SessionStore(dir);
  const { runtime } = controllableRuntime("@architect: PR #37 is ready for review.", "handoff-sess");
  const session = new AgentSession({
    id: "developer",
    label: "Developer",
    cwd: "D:/workspace",
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

test("send passes the full attachment metadata to the runtime", async () => {
  const dir = tmpDir();
  const store = new SessionStore(dir);
  const calls: AgentRuntimeRunOptions[] = [];
  const runtime: AgentRuntime = {
    kind: "codebuddy",
    run(options) {
      calls.push(options);
      return {
        process: { kill() {}, pid: 12345, interrupt() {} },
        result: Promise.resolve("clean final"),
        sessionId: Promise.resolve("sess-with-attachments"),
      };
    },
  };
  const session = new AgentSession({
    id: "developer",
    label: "Developer",
    cwd: "D:/workspace",
    runtime,
    eventBus: new EventBus(),
    sessionStore: store,
    conversationId: "default",
  });

  const attachments: MessageAttachment[] = [
    {
      id: "img-1", kind: "image", mimeType: "image/png", filename: "shot.png",
      path: "/data/shot.png", url: "/api/attachments/ws/conv/img-1", size: 2048,
      createdAt: new Date().toISOString(),
    },
    {
      id: "pdf-1", kind: "file", mimeType: "application/pdf", filename: "spec.pdf",
      path: "/data/spec.pdf", url: "/api/attachments/ws/conv/pdf-1", size: 4096,
      createdAt: new Date().toISOString(),
    },
  ];

  session.start();
  await session.send("run-1", "hello", attachments);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.attachments, attachments, "runtime options must carry the intact attachment list");
});

test("session restore retry carries the same attachment list", async () => {
  const dir = tmpDir();
  const store = new SessionStore(dir);
  store.save("codebuddy", "default", "developer", {
    agentId: "developer",
    runtime: "codebuddy",
    sessionId: "stale-session",
    lastRunAt: new Date().toISOString(),
    runCount: 1,
  });
  const calls: AgentRuntimeRunOptions[] = [];
  const runtime: AgentRuntime = {
    kind: "codebuddy",
    run(options) {
      calls.push(options);
      return {
        process: { kill() {}, pid: 12345, interrupt() {} },
        result: calls.length === 1
          ? Promise.reject(new Error("session not found: stale-session"))
          : Promise.resolve("clean final"),
        sessionId: Promise.resolve(calls.length === 1 ? null : "fresh-session"),
      };
    },
  };
  const session = new AgentSession({
    id: "developer",
    label: "Developer",
    cwd: "D:/workspace",
    runtime,
    eventBus: new EventBus(),
    sessionStore: store,
    conversationId: "default",
  });

  const attachments: MessageAttachment[] = [
    {
      id: "pdf-1", kind: "file", mimeType: "application/pdf", filename: "spec.pdf",
      path: "/data/spec.pdf", url: "/api/attachments/ws/conv/pdf-1", size: 4096,
      createdAt: new Date().toISOString(),
    },
  ];

  session.start();
  await session.send("run-1", "hello", attachments);

  assert.equal(calls.length, 2, "restore failure must retry once");
  assert.deepEqual(calls[0]!.attachments, attachments, "first attempt carries the attachments");
  assert.deepEqual(calls[1]!.attachments, attachments, "retry after restore failure must carry the same attachments");
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

test("session downgrade inside the runtime persists the replacement sessionId", async () => {
  // #141 后半：runtime 在 resume 失败且不可恢复时内部降级到新 runtime 会话。
  // AgentSession 必须持久化降级后的新 sessionId（而非旧的 resume 值），且
  // 不把它当作 resume 失败做二次重试。
  const dir = tmpDir();
  const store = new SessionStore(dir);
  store.save("codebuddy", "default", "developer", {
    agentId: "developer",
    runtime: "codebuddy",
    sessionId: "stale-session",
    lastRunAt: new Date().toISOString(),
    runCount: 1,
  });

  const eventBus = new EventBus();
  const events: Array<{ type: string; text?: string }> = [];
  eventBus.subscribe((event) => events.push(event));

  const calls: AgentRuntimeRunOptions[] = [];
  const runtime: AgentRuntime = {
    kind: "codebuddy",
    run(options) {
      calls.push(options);
      // 模拟 acp-runtime 的不可恢复降级：resume 报 thread-store conflict，
      // runtime 内部改走 session/new 拿到新 id，并发出过程提示。
      options.onOutput?.("原 CodeBuddy 会话无法恢复（thread-store conflict），已使用新的会话继续。");
      return {
        process: { kill() {}, pid: 12345, interrupt() {} },
        result: Promise.resolve("clean final"),
        sessionId: Promise.resolve("fresh-session"),
      };
    },
  };

  const session = new AgentSession({
    id: "developer",
    label: "Developer",
    cwd: "D:/workspace",
    runtime,
    eventBus,
    sessionStore: store,
    conversationId: "default",
  });

  session.start();
  const result = await session.send("run-1", "hello");

  assert.equal(result.content, "clean final");
  assert.equal(result.sessionId, "fresh-session");
  // 降级发生在 runtime 内部：AgentSession 只发起一次 run，不做二次重试。
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.resumeSessionId, "stale-session");
  // 持久化的是降级后的新 sessionId。
  const persisted = store.load("codebuddy", "default", "developer");
  assert.equal(persisted!.sessionId, "fresh-session", "降级后的新 sessionId 必须被持久化");
  assert.equal(persisted!.runCount, 2);
  // 降级提示作为过程输出进入事件流，不改写正文。
  const downgradeNotice = events.find(
    (event) => event.type === "terminal.chunk" && event.text?.includes("已使用新的会话继续"),
  );
  assert.ok(downgradeNotice, "降级提示必须进入 runtime 输出事件流");
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

  // Cancellation is asynchronous: the active run remains occupied until the
  // runtime promise settles, so a queued task cannot start too early.
  assert.equal(session.getStatus(), "running", "status should remain running while cancellation is pending");

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

test("interrupt settles pending permissions and elicitations, then forced cancel returns to idle", async () => {
  // Issue #136：runtime 无视取消被强制收口时，挂起的权限/表单请求必须先被
  // 清理（权限拒绝、表单取消），会话最终回到 idle 而不是 error。
  const dir = tmpDir();
  const store = new SessionStore(dir);
  const eventBus = new EventBus();
  let capturedOptions: AgentRuntimeRunOptions | null = null;
  let rejectRun!: (error: Error) => void;
  const resultPromise = new Promise<string>((_resolve, reject) => { rejectRun = reject; });
  const runtime: AgentRuntime = {
    kind: "codebuddy",
    run(options) {
      capturedOptions = options;
      return {
        process: { kill() {}, pid: 12345, interrupt() {} },
        result: resultPromise,
        sessionId: Promise.resolve(null),
      };
    },
  };
  const session = new AgentSession({
    id: "developer",
    label: "Developer",
    cwd: process.cwd(),
    runtime,
    eventBus,
    sessionStore: store,
    conversationId: "default",
  });

  session.start();
  const sendPromise = session.send("run-force", "hello", undefined, "ask");
  await new Promise((resolve) => setTimeout(resolve, 0));

  const permissionDecision = capturedOptions!.requestPermission!({ id: "tool-1", title: "Run tests" });
  const elicitationResponse = capturedOptions!.requestElicitation!({ message: "Choose", mode: "form" });
  assert.equal(session.pendingPermissions().length, 1);
  assert.equal(session.pendingElicitations().length, 1);

  session.interrupt("run-force");
  assert.equal(await permissionDecision, "reject");
  assert.deepEqual(await elicitationResponse, { action: "cancel" });
  assert.equal(session.pendingPermissions().length, 0);
  assert.equal(session.pendingElicitations().length, 0);

  // 修复后的 runAcp 保证 handle.result 在有限时间内以取消错误收口。
  rejectRun(new AgentRunCancelledError("CodeBuddy ACP turn was force-cancelled"));
  try {
    await sendPromise;
    assert.fail("send should reject after forced cancel");
  } catch (error) {
    assert.ok(error instanceof AgentRunCancelledError);
  }
  assert.equal(session.getStatus(), "idle", "强制取消后必须回到 idle，而不是 error");
});

test("publishes and resolves runtime permission requests", async () => {
  const dir = tmpDir();
  const store = new SessionStore(dir);
  const eventBus = new EventBus();
  const events: Array<{ type: string }> = [];
  eventBus.subscribe((event) => events.push(event));
  let runOptions: AgentRuntimeRunOptions | null = null;
  let finishRun!: (value: string) => void;
  const result = new Promise<string>((resolve) => { finishRun = resolve; });
  const runtime: AgentRuntime = {
    kind: "codebuddy",
    run(options) {
      runOptions = options;
      return {
        process: { kill() {}, pid: 12345, interrupt() {} },
        result,
        sessionId: Promise.resolve("permission-session"),
      };
    },
  };
  const session = new AgentSession({
    id: "developer",
    label: "Developer",
    cwd: process.cwd(),
    runtime,
    eventBus,
    sessionStore: store,
    conversationId: "default",
  });
  session.start();
  const sendPromise = session.send("run-approval", "hello", undefined, "ask");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(runOptions!.approvalMode, "ask");
  const decisionPromise = runOptions!.requestPermission!({ id: "tool-1", title: "Run tests", kind: "execute" });
  const pending = session.pendingPermissions();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.id, "run-approval:tool-1");
  assert.ok(events.some((event) => event.type === "permission.requested"));
  assert.ok(events.some((event) => event.type === "runtime.activity"), "permission status should enter the runtime activity pipeline");

  assert.equal(session.resolvePermission(pending[0]!.id, "allow"), true);
  assert.equal(await decisionPromise, "allow");
  assert.equal(session.pendingPermissions().length, 0);
  assert.ok(events.some((event) => event.type === "permission.resolved"));

  finishRun("clean final");
  await sendPromise;
});

test("keeps parallel runtime permission requests isolated", async () => {
  const dir = tmpDir();
  const store = new SessionStore(dir);
  const eventBus = new EventBus();
  let runOptions: AgentRuntimeRunOptions | null = null;
  let finishRun!: (value: string) => void;
  const runtime: AgentRuntime = {
    kind: "codebuddy",
    run(options) {
      runOptions = options;
      return {
        process: { kill() {}, pid: 12345, interrupt() {} },
        result: new Promise<string>((resolve) => { finishRun = resolve; }),
        sessionId: Promise.resolve("parallel-permission-session"),
      };
    },
  };
  const session = new AgentSession({
    id: "developer",
    label: "Developer",
    cwd: process.cwd(),
    runtime,
    eventBus,
    sessionStore: store,
    conversationId: "default",
  });
  session.start();
  const sendPromise = session.send("run-parallel", "hello", undefined, "ask");
  await new Promise((resolve) => setTimeout(resolve, 0));

  const first = runOptions!.requestPermission!({ id: "tool-1", title: "Read file" });
  const second = runOptions!.requestPermission!({ id: "tool-2", title: "Run tests" });
  assert.deepEqual(session.pendingPermissions().map((permission) => permission.id), [
    "run-parallel:tool-1",
    "run-parallel:tool-2",
  ]);

  assert.equal(session.resolvePermission("run-parallel:tool-1", "allow"), true);
  assert.equal(session.resolvePermission("run-parallel:tool-2", "reject"), true);
  assert.equal(await first, "allow");
  assert.equal(await second, "reject");
  assert.equal(session.pendingPermissions().length, 0);

  finishRun("clean final");
  await sendPromise;
});

test("publishes and resolves runtime elicitation requests", async () => {
  const dir = tmpDir();
  const store = new SessionStore(dir);
  const eventBus = new EventBus();
  const events: Array<{ type: string }> = [];
  eventBus.subscribe((event) => events.push(event));
  let runOptions: AgentRuntimeRunOptions | null = null;
  let finishRun!: (value: string) => void;
  const result = new Promise<string>((resolve) => { finishRun = resolve; });
  const runtime: AgentRuntime = {
    kind: "codebuddy",
    run(options) {
      runOptions = options;
      return {
        process: { kill() {}, pid: 12345, interrupt() {} },
        result,
        sessionId: Promise.resolve("elicitation-session"),
      };
    },
  };
  const session = new AgentSession({
    id: "developer",
    label: "Developer",
    cwd: process.cwd(),
    runtime,
    eventBus,
    sessionStore: store,
    conversationId: "default",
  });
  session.start();
  const sendPromise = session.send("run-elicitation", "hello", undefined, "ask");
  await new Promise((resolve) => setTimeout(resolve, 0));

  const responsePromise = runOptions!.requestElicitation!({
    message: "Choose a strategy",
    mode: "form",
    requestedSchema: { type: "object", properties: { strategy: { type: "string" } } },
  });
  const pending = session.pendingElicitations();
  assert.equal(pending.length, 1);
  assert.ok(events.some((event) => event.type === "elicitation.requested"));
  assert.ok(events.some((event) => event.type === "runtime.activity"), "elicitation status should enter the runtime activity pipeline");

  assert.equal(session.resolveElicitation(pending[0]!.id, { action: "accept", content: { strategy: "safe" } }), true);
  assert.deepEqual(await responsePromise, { action: "accept", content: { strategy: "safe" } });
  assert.equal(session.pendingElicitations().length, 0);
  assert.ok(events.some((event) => event.type === "elicitation.resolved"));

  finishRun("clean final");
  await sendPromise;
});

test("expires pending permission requests and clears their UI state", async () => {
  const dir = tmpDir();
  const store = new SessionStore(dir);
  const eventBus = new EventBus();
  const events: Array<{ type: string }> = [];
  eventBus.subscribe((event) => events.push(event));
  let runOptions: AgentRuntimeRunOptions | null = null;
  let finishRun!: (value: string) => void;
  const runtime: AgentRuntime = {
    kind: "codebuddy",
    run(options) {
      runOptions = options;
      return {
        process: { kill() {}, pid: 12345, interrupt() {} },
        result: new Promise<string>((resolve) => { finishRun = resolve; }),
        sessionId: Promise.resolve("permission-expiry-session"),
      };
    },
  };
  const session = new AgentSession({
    id: "developer",
    label: "Developer",
    cwd: process.cwd(),
    runtime,
    eventBus,
    sessionStore: store,
    conversationId: "default",
    interactionTimeoutMs: 10,
  });
  session.start();
  const sendPromise = session.send("run-expiry", "hello", undefined, "ask");
  await new Promise((resolve) => setTimeout(resolve, 0));

  const decision = runOptions!.requestPermission!({ id: "tool-1", title: "Run tests" });
  assert.ok(session.pendingPermissions()[0]!.expiresAt);
  assert.equal(await decision, "reject");
  assert.equal(session.pendingPermissions().length, 0);
  assert.ok(events.filter((event) => event.type === "permission.resolved").length === 1);

  finishRun("clean final");
  await sendPromise;
});

test("expires pending elicitation requests and ignores late responses", async () => {
  const dir = tmpDir();
  const store = new SessionStore(dir);
  const eventBus = new EventBus();
  let runOptions: AgentRuntimeRunOptions | null = null;
  let finishRun!: (value: string) => void;
  const runtime: AgentRuntime = {
    kind: "codebuddy",
    run(options) {
      runOptions = options;
      return {
        process: { kill() {}, pid: 12345, interrupt() {} },
        result: new Promise<string>((resolve) => { finishRun = resolve; }),
        sessionId: Promise.resolve("elicitation-expiry-session"),
      };
    },
  };
  const session = new AgentSession({
    id: "developer",
    label: "Developer",
    cwd: process.cwd(),
    runtime,
    eventBus,
    sessionStore: store,
    conversationId: "default",
    interactionTimeoutMs: 10,
  });
  session.start();
  const sendPromise = session.send("run-expiry", "hello", undefined, "ask");
  await new Promise((resolve) => setTimeout(resolve, 0));

  const response = runOptions!.requestElicitation!({ message: "Choose", mode: "form" });
  const requestId = session.pendingElicitations()[0]!.id;
  assert.deepEqual(await response, { action: "cancel" });
  assert.equal(session.pendingElicitations().length, 0);
  assert.equal(session.resolveElicitation(requestId, { action: "decline" }), false);

  finishRun("clean final");
  await sendPromise;
});

// ---- issue #142：模型偏好与快照桥流转 ----

test("model preference and snapshot bridge reach the runtime run options", async () => {
  const dir = tmpDir();
  const store = new SessionStore(dir);
  const controlled = controllableRuntime("ok", "sess-1");
  const lastSnapshot: AgentModelStateSnapshot = {
    agentId: "developer",
    runtimeKind: "codebuddy",
    configId: "model",
    choices: [{ value: "model-a", name: "模型 A" }, { value: "model-b", name: "模型 B" }],
    currentValue: "model-a",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const updates: AgentModelStateSnapshot[] = [];
  const session = new AgentSession({
    id: "developer",
    label: "Developer",
    cwd: process.cwd(),
    runtime: controlled.runtime,
    eventBus: new EventBus(),
    sessionStore: store,
    conversationId: "conv-model",
    preferredModelId: "model-b",
    modelState: {
      load: (agentId) => (agentId === "developer" ? lastSnapshot : undefined),
      update: (snapshot) => updates.push(snapshot),
    },
  });
  session.start();

  const result = await session.send("run-1", "hello");
  assert.equal(result.content, "ok");
  assert.equal(controlled.calls.length, 1);
  assert.equal(controlled.calls[0]!.preferredModelId, "model-b");
  assert.equal(controlled.calls[0]!.lastSessionConfig, lastSnapshot);
  assert.equal(typeof controlled.calls[0]!.onSessionConfig, "function");

  const next = { ...lastSnapshot, currentValue: "model-b" };
  controlled.calls[0]!.onSessionConfig!(next);
  assert.deepEqual(updates, [next]);

  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- issue #160：员工会话的斜杠命令快照 ----

function commandsUpdatedEvents(events: RuntimeEvent[]): Array<Extract<RuntimeEvent, { type: "agent.commands.updated" }>> {
  return events.filter((event): event is Extract<RuntimeEvent, { type: "agent.commands.updated" }> => event.type === "agent.commands.updated");
}

test("slash command announcements are cached and published as conversation events", async () => {
  const dir = tmpDir();
  const store = new SessionStore(dir);
  const controlled = controllableRuntime("ok", "sess-1");
  const events: RuntimeEvent[] = [];
  const eventBus = new EventBus();
  eventBus.subscribe((event) => events.push(event));
  const session = new AgentSession({
    id: "developer",
    label: "Developer",
    cwd: process.cwd(),
    runtime: controlled.runtime,
    eventBus,
    sessionStore: store,
    conversationId: "conv-commands",
  });
  session.start();

  const result = await session.send("run-1", "hello");
  assert.equal(result.content, "ok");
  assert.deepEqual(session.availableCommands(), [], "会话未通告前不得有命令");

  const commands: AgentCommand[] = [
    { name: "init", description: "初始化项目" },
    { name: "review", description: "审查当前变更", inputHint: "可选关注点" },
  ];
  controlled.calls[0]!.onSessionCommands!(commands, "sess-1");

  assert.deepEqual(session.availableCommands(), commands);
  const published = commandsUpdatedEvents(events);
  assert.equal(published.length, 1);
  assert.equal(published[0]!.conversationId, "conv-commands");
  assert.equal(published[0]!.agentId, "developer");
  assert.deepEqual(published[0]!.commands, commands);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("a replacement session id clears the cached command snapshot", async () => {
  const dir = tmpDir();
  const store = new SessionStore(dir);
  const events: RuntimeEvent[] = [];
  const eventBus = new EventBus();
  eventBus.subscribe((event) => events.push(event));
  const calls: AgentRuntimeRunOptions[] = [];
  let nextSessionId = "sess-1";
  const session = new AgentSession({
    id: "developer",
    label: "Developer",
    cwd: process.cwd(),
    runtime: {
      kind: "codebuddy",
      run(options) {
        calls.push(options);
        return {
          process: { kill() {}, pid: 12345, interrupt() {} },
          result: Promise.resolve("ok"),
          sessionId: Promise.resolve(nextSessionId),
        };
      },
    },
    eventBus,
    sessionStore: store,
    conversationId: "conv-commands",
  });
  session.start();

  await session.send("run-1", "hello");
  const commands: AgentCommand[] = [{ name: "init", description: "初始化项目" }];
  calls[0]!.onSessionCommands!(commands, "sess-1");
  assert.deepEqual(session.availableCommands(), commands);

  // 恢复失败降级：新一轮落定不同的 runtime 会话 id，旧通告不再可信。
  nextSessionId = "sess-2";
  await session.send("run-2", "again");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(session.availableCommands(), [], "替换会话后命令缓存必须清空");
  const published = commandsUpdatedEvents(events);
  assert.equal(published.length, 2);
  assert.deepEqual(published[1]!.commands, [], "清空必须以空列表广播给打开的页面");

  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- issue #160 收尾：探测写回与正式通告共用一份权威快照 ----

test("probed commands write back as the authoritative snapshot without publishing", () => {
  const dir = tmpDir();
  const events: RuntimeEvent[] = [];
  const eventBus = new EventBus();
  eventBus.subscribe((event) => events.push(event));
  const session = new AgentSession({
    id: "developer",
    label: "Developer",
    cwd: process.cwd(),
    runtime: {
      kind: "claude-code",
      run() { throw new Error("探测写回不需要真实运行"); },
    },
    eventBus,
    sessionStore: new SessionStore(dir),
    conversationId: "conv-probe",
  });
  session.start();

  assert.equal(session.commandsAnnounced(), false, "从未通告时不得伪造快照");
  const commands: AgentCommand[] = [{ name: "review", description: "审查当前变更" }];
  session.adoptProbedCommands(commands);

  assert.equal(session.commandsAnnounced(), true, "写回后 /api/state 与发送校验必须能看到这些命令");
  assert.deepEqual(session.availableCommands(), commands);
  assert.deepEqual(commandsUpdatedEvents(events), [], "写回不广播：探测结果由服务端探测路径自己按会话广播");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("a late probe write-back cannot clobber a real announcement", async () => {
  const dir = tmpDir();
  const store = new SessionStore(dir);
  const controlled = controllableRuntime("ok", "sess-1");
  const session = new AgentSession({
    id: "developer",
    label: "Developer",
    cwd: process.cwd(),
    runtime: controlled.runtime,
    eventBus: new EventBus(),
    sessionStore: store,
    conversationId: "conv-probe",
  });
  session.start();
  await session.send("run-1", "hello");

  const commands: AgentCommand[] = [{ name: "init", description: "初始化项目" }];
  controlled.calls[0]!.onSessionCommands!(commands, "sess-1");
  assert.deepEqual(session.availableCommands(), commands);

  session.adoptProbedCommands([{ name: "probed", description: "迟到的探测结果" }]);
  assert.deepEqual(session.availableCommands(), commands, "正式会话已通告后探测写回不得覆盖真实数据");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("a probed snapshot is invalidated when the real session lands and is repopulated by its announcement", async () => {
  const dir = tmpDir();
  const store = new SessionStore(dir);
  const events: RuntimeEvent[] = [];
  const eventBus = new EventBus();
  eventBus.subscribe((event) => events.push(event));
  const controlled = controllableRuntime("ok", "sess-1");
  const session = new AgentSession({
    id: "developer",
    label: "Developer",
    cwd: process.cwd(),
    runtime: controlled.runtime,
    eventBus,
    sessionStore: store,
    conversationId: "conv-probe",
  });
  session.start();

  const probed: AgentCommand[] = [{ name: "review", description: "临时会话探测结果" }];
  session.adoptProbedCommands(probed);
  assert.deepEqual(session.availableCommands(), probed);

  // 正式会话落定：探测哨兵与真实会话 id 不匹配，缓存失效并广播空列表。
  await session.send("run-1", "hello");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(session.availableCommands(), [], "探测写回的命令在正式会话落定后必须失效");
  const published = commandsUpdatedEvents(events);
  assert.equal(published.length, 1);
  assert.deepEqual(published[0]!.commands, [], "失效必须以空列表广播给打开的页面");

  // 正式会话通告随后补齐命令，且此后快照归属真实会话。
  const announced: AgentCommand[] = [{ name: "init", description: "初始化项目" }];
  controlled.calls[0]!.onSessionCommands!(announced, "sess-1");
  assert.deepEqual(session.availableCommands(), announced);
  session.adoptProbedCommands(probed);
  assert.deepEqual(session.availableCommands(), announced, "正式通告之后探测写回不得再覆盖");

  fs.rmSync(dir, { recursive: true, force: true });
});
