import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  buildCodeBuddyAcpArgs,
  buildCodeBuddyAcpCommand,
  createCodeBuddyAcpRuntime,
  decideCodeBuddyPermission,
  resolveCodeBuddyElicitation,
  resolveCodeBuddyPermission,
  type CodeBuddyAcpConnection,
  type CodeBuddyAcpConnector,
} from "../src/core/codebuddy-acp-runtime.ts";
import { AgentRunCancelledError } from "../src/core/agent-runtime.ts";
import type { AgentActivityEvent } from "../src/shared/types.ts";

type FakeOptions = {
  capabilities?: Awaited<ReturnType<CodeBuddyAcpConnection["initialize"]>>["agentCapabilities"];
  onLoad?: (notify: Parameters<CodeBuddyAcpConnector>[1]) => void;
  onPrompt?: (notify: Parameters<CodeBuddyAcpConnector>[1]) => void;
  promptResponse?: Awaited<ReturnType<CodeBuddyAcpConnection["prompt"]>>;
};

function fakeConnector(options: FakeOptions = {}) {
  const calls: Array<{ method: string; value?: unknown }> = [];
  let cancelled = false;
  let closed = false;
  const connector: CodeBuddyAcpConnector = (_runOptions, notify) => ({
    pid: 12345,
    async initialize(request) {
      calls.push({ method: "initialize", value: request });
      return {
        protocolVersion: 1,
        agentCapabilities: options.capabilities ?? { loadSession: true },
      };
    },
    async newSession(request) {
      calls.push({ method: "session/new", value: request });
      return { sessionId: "new-session" };
    },
    async loadSession(request) {
      calls.push({ method: "session/load", value: request });
      options.onLoad?.(notify);
    },
    async resumeSession(request) {
      calls.push({ method: "session/resume", value: request });
    },
    async prompt(request) {
      calls.push({ method: "session/prompt", value: request });
      options.onPrompt?.(notify);
      return options.promptResponse ?? { stopReason: cancelled ? "cancelled" : "end_turn" };
    },
    async cancel(sessionId) {
      cancelled = true;
      calls.push({ method: "session/cancel", value: sessionId });
    },
    close() {
      closed = true;
      calls.push({ method: "close" });
    },
  });
  return { connector, calls, wasClosed: () => closed };
}

function runOptions(overrides: Record<string, unknown> = {}) {
  return {
    agentId: "tester",
    cwd: "D:/workspace",
    prompt: "hello",
    ...overrides,
  };
}

test("starts CodeBuddy exclusively in ACP mode", () => {
  assert.deepEqual(buildCodeBuddyAcpArgs(), ["--acp"]);
  const command = buildCodeBuddyAcpCommand();
  assert.ok(command.file.length > 0);
  assert.ok(command.args.includes("--acp"));
  assert.ok(!command.args.includes("--print"));
  assert.ok(!command.args.includes("bypassPermissions"));
});

test("creates an ACP session and returns streamed agent text", async () => {
  const fake = fakeConnector({
    onPrompt(notify) {
      notify({
        sessionId: "new-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "final answer" },
        },
      });
    },
  });
  const runtime = createCodeBuddyAcpRuntime(fake.connector);
  const handle = runtime.run(runOptions());

  assert.equal(await handle.result, "final answer");
  assert.equal(await handle.sessionId, "new-session");
  assert.deepEqual(fake.calls.map((call) => call.method), [
    "initialize",
    "session/new",
    "session/prompt",
    "close",
  ]);
  const newSession = fake.calls.find((call) => call.method === "session/new")!.value as { cwd: string };
  assert.equal(newSession.cwd, path.resolve("D:/workspace"));
  assert.equal(fake.wasClosed(), true);
});

test("keeps CodeBuddy progress and internal messages out of the final answer", async () => {
  const output: string[] = [];
  const fake = fakeConnector({
    onPrompt(notify) {
      notify({
        sessionId: "new-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "progress-1",
          content: { type: "text", text: "CHECKING" },
        },
      });
      notify({
        sessionId: "new-session",
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "hidden reasoning" },
        },
      });
      notify({
        sessionId: "new-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "final-1",
          content: { type: "text", text: "FINAL_CODEBUDDY" },
        },
      });
      notify({
        sessionId: "new-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "member-1",
          content: { type: "text", text: "member progress" },
          _meta: { "codebuddy.ai/memberEvent": { type: "message" } },
        },
      });
      notify({
        sessionId: "new-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "compact-1",
          content: { type: "text", text: "internal compact summary" },
          _meta: { "codebuddy.ai/isCompactInternal": true },
        },
      });
    },
  });
  const runtime = createCodeBuddyAcpRuntime(fake.connector);

  assert.equal(
    await runtime.run(runOptions({ onOutput: (text: string) => output.push(text) })).result,
    "FINAL_CODEBUDDY",
  );
  assert.deepEqual(output, ["CHECKING", "FINAL_CODEBUDDY", "member progress"]);
});

test("loads an existing session and suppresses replayed history", async () => {
  const fake = fakeConnector({
    capabilities: { loadSession: true },
    onLoad(notify) {
      notify({
        sessionId: "existing-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "old replay" },
        },
      });
    },
    onPrompt(notify) {
      notify({
        sessionId: "existing-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "new answer" },
        },
      });
    },
  });
  const runtime = createCodeBuddyAcpRuntime(fake.connector);
  const handle = runtime.run(runOptions({ resumeSessionId: "existing-session" }));

  assert.equal(await handle.result, "new answer");
  assert.equal(await handle.sessionId, "existing-session");
  assert.ok(fake.calls.some((call) => call.method === "session/load"));
  assert.ok(!fake.calls.some((call) => call.method === "session/new"));
});

test("prefers session/resume when the agent advertises it", async () => {
  const fake = fakeConnector({
    capabilities: { sessionCapabilities: { resume: {} } },
    onPrompt(notify) {
      notify({
        sessionId: "existing-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "resumed" },
        },
      });
    },
  });
  const runtime = createCodeBuddyAcpRuntime(fake.connector);
  const handle = runtime.run(runOptions({ resumeSessionId: "existing-session" }));

  assert.equal(await handle.result, "resumed");
  assert.ok(fake.calls.some((call) => call.method === "session/resume"));
  assert.ok(!fake.calls.some((call) => call.method === "session/load"));
});

test("rejects incompatible ACP protocol versions", async () => {
  const connector: CodeBuddyAcpConnector = (_options, _notify) => ({
    pid: 12345,
    async initialize() { return { protocolVersion: 2 }; },
    async newSession() { return { sessionId: "unused" }; },
    async loadSession() {},
    async resumeSession() {},
    async prompt() { return { stopReason: "end_turn" }; },
    async cancel() {},
    close() {},
  });
  const runtime = createCodeBuddyAcpRuntime(connector);

  await assert.rejects(runtime.run(runOptions()).result, /requires 1/);
});

test("reports unsupported session restoration as a resume failure", async () => {
  const fake = fakeConnector({ capabilities: {} });
  const runtime = createCodeBuddyAcpRuntime(fake.connector);

  await assert.rejects(
    runtime.run(runOptions({ resumeSessionId: "stale-session" })).result,
    /could not resume/,
  );
});

test("maps ACP tool lifecycle updates to Orbit activity events", async () => {
  const activities: AgentActivityEvent[] = [];
  const fake = fakeConnector({
    onPrompt(notify) {
      notify({
        sessionId: "new-session",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tool-1",
          title: "Read package.json",
          kind: "read",
          status: "in_progress",
          rawInput: { path: "package.json" },
        },
      });
      notify({
        sessionId: "new-session",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-1",
          status: "completed",
          rawOutput: "done",
        },
      });
      notify({
        sessionId: "new-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "complete" },
        },
      });
    },
  });
  const runtime = createCodeBuddyAcpRuntime(fake.connector);
  await runtime.run(runOptions({ onActivity: (activity: AgentActivityEvent) => activities.push(activity) })).result;

  assert.deepEqual(activities.map((activity) => activity.type), ["tool.started", "tool.completed"]);
  assert.equal(activities[0]?.type === "tool.started" && activities[0].name, "Read package.json");
});

test("interrupt sends session/cancel and rejects the turn", async () => {
  let finishPrompt!: (response: { stopReason: "cancelled" }) => void;
  const promptResult = new Promise<{ stopReason: "cancelled" }>((resolve) => {
    finishPrompt = resolve;
  });
  const fake = fakeConnector();
  const originalConnector = fake.connector;
  const connector: CodeBuddyAcpConnector = (options, notify) => {
    const connection = originalConnector(options, notify);
    return {
      ...connection,
      async prompt(request) {
        fake.calls.push({ method: "session/prompt", value: request });
        return promptResult;
      },
      async cancel(sessionId) {
        fake.calls.push({ method: "session/cancel", value: sessionId });
        finishPrompt({ stopReason: "cancelled" });
      },
    };
  };
  const runtime = createCodeBuddyAcpRuntime(connector);
  const handle = runtime.run(runOptions());
  await handle.sessionId;
  handle.process.interrupt();

  await assert.rejects(handle.result, /cancelled/);
  assert.ok(fake.calls.some((call) => call.method === "session/cancel"));
});

test("ACP cancelled turns expose a typed cancellation error", async () => {
  const fake = fakeConnector({ promptResponse: { stopReason: "cancelled" } });
  const runtime = createCodeBuddyAcpRuntime(fake.connector);

  await assert.rejects(runtime.run(runOptions()).result, (error: unknown) => {
    assert.ok(error instanceof AgentRunCancelledError);
    assert.equal(error.userMessage, "运行已取消。");
    return true;
  });
});

test("full-access permission decisions allow supported ACP options", () => {
  const request = {
    sessionId: "session",
    toolCall: { toolCallId: "tool", kind: "execute" as const, rawInput: { command: "npm install left-pad" } },
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" as const },
      { optionId: "reject", name: "Reject", kind: "reject_once" as const },
    ],
  };

  assert.deepEqual(decideCodeBuddyPermission(request), {
    outcome: { outcome: "selected", optionId: "allow" },
  });
  assert.deepEqual(decideCodeBuddyPermission(
    { ...request, options: [{ optionId: "always", name: "Always", kind: "allow_always" }] },
  ), {
    outcome: { outcome: "cancelled" },
  });
});

test("ask mode waits for the Orbit permission decision", async () => {
  const request = {
    sessionId: "session",
    toolCall: { toolCallId: "tool-ask", title: "Run tests", kind: "execute" as const, rawInput: { command: "npm test" } },
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" as const },
      { optionId: "reject", name: "Reject", kind: "reject_once" as const },
    ],
  };
  const seen: unknown[] = [];

  const response = await resolveCodeBuddyPermission(request, runOptions({
    approvalMode: "ask",
    requestPermission: async (permission: unknown) => {
      seen.push(permission);
      return "allow";
    },
  }));

  assert.equal(seen.length, 1);
  assert.deepEqual(response, { outcome: { outcome: "selected", optionId: "allow" } });
});

test("permission decisions recognize CodeBuddy tool names when ACP kind is omitted", async () => {
  const request = {
    sessionId: "session",
    toolCall: {
      toolCallId: "tool-read",
      rawInput: { file_path: "README.md" },
      _meta: { "codebuddy.ai/toolName": "Read" },
    },
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" as const },
      { optionId: "reject", name: "Reject", kind: "reject_once" as const },
    ],
  };
  const seen: unknown[] = [];

  const response = await resolveCodeBuddyPermission(request, runOptions({
    approvalMode: "ask",
    requestPermission: async (permission: unknown) => {
      seen.push(permission);
      return "allow";
    },
  }));

  assert.deepEqual(seen, [{
    id: "tool-read",
    title: "Read",
    kind: "read",
    input: '{"file_path":"README.md"}',
  }]);
  assert.deepEqual(response, { outcome: { outcome: "selected", optionId: "allow" } });
});

test("elicitation requests wait for a structured Orbit response", async () => {
  const seen: unknown[] = [];
  const response = await resolveCodeBuddyElicitation({
    sessionId: "session",
    mode: "form",
    message: "Choose a strategy",
    requestedSchema: {
      type: "object",
      properties: { strategy: { type: "string", enum: ["safe", "fast"] } },
      required: ["strategy"],
    },
  }, runOptions({
    requestElicitation: async (request: unknown) => {
      seen.push(request);
      return { action: "accept", content: { strategy: "safe" } };
    },
  }));

  assert.deepEqual(seen, [{
    message: "Choose a strategy",
    mode: "form",
    sessionId: "session",
    requestedSchema: {
      type: "object",
      properties: { strategy: { type: "string", enum: ["safe", "fast"] } },
      required: ["strategy"],
    },
  }]);
  assert.deepEqual(response, { action: "accept", content: { strategy: "safe" } });
});

test("full access auto-approves all ACP permission requests", async () => {
  const request = {
    sessionId: "session",
    toolCall: { toolCallId: "tool-full", title: "Install package", kind: "execute" as const, rawInput: { command: "npm install left-pad" } },
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" as const },
      { optionId: "reject", name: "Reject", kind: "reject_once" as const },
    ],
  };
  let asked = false;

  const allowed = await resolveCodeBuddyPermission(request, runOptions({
    approvalMode: "full-access",
    requestPermission: async () => { asked = true; return "allow"; },
  }));
  assert.equal(asked, false);
  assert.deepEqual(allowed, { outcome: { outcome: "selected", optionId: "allow" } });
});
