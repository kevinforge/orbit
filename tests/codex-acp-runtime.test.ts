import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCodexAcpCommand,
  codexAcpEnvForRun,
  createCodexAcpRuntime,
  isCodexDiagnosticMessage,
  resolveCodexAcpCommand,
  type CodexAcpConnection,
  type CodexAcpConnector,
} from "../src/core/codex-acp-runtime.ts";
import { createAcpRuntime, type AcpRuntimeDefinition } from "../src/core/acp-runtime.ts";
import { AgentRunCancelledError } from "../src/core/agent-runtime.ts";

type FakeOptions = {
  capabilities?: Awaited<ReturnType<CodexAcpConnection["initialize"]>>["agentCapabilities"];
  onPrompt?: (notify: Parameters<CodexAcpConnector>[1]) => void;
  promptResponse?: Awaited<ReturnType<CodexAcpConnection["prompt"]>>;
};

function fakeConnector(options: FakeOptions = {}) {
  const calls: Array<{ method: string; value?: unknown }> = [];
  const connector: CodexAcpConnector = (_runOptions, notify) => ({
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
      return { sessionId: "codex-session" };
    },
    async loadSession(request) {
      calls.push({ method: "session/load", value: request });
    },
    async resumeSession(request) {
      calls.push({ method: "session/resume", value: request });
    },
    async prompt(request) {
      calls.push({ method: "session/prompt", value: request });
      options.onPrompt?.(notify);
      return options.promptResponse ?? { stopReason: "end_turn" };
    },
    async cancel(sessionId) {
      calls.push({ method: "session/cancel", value: sessionId });
    },
    close() {
      calls.push({ method: "close" });
    },
  });
  return { connector, calls };
}

function runOptions(overrides: Record<string, unknown> = {}) {
  return {
    agentId: "product-manager",
    cwd: "D:/workspace",
    prompt: "hello",
    ...overrides,
  };
}

test("starts Codex through the ACP adapter instead of codex exec --json", () => {
  const command = buildCodexAcpCommand({});
  assert.ok(command.args.some((arg) => arg.includes("codex-acp")) || command.file.includes("codex-acp"));
  assert.ok(!command.args.includes("exec"));
  assert.ok(!command.args.includes("--json"));
  assert.ok(!command.args.includes("--dangerously-bypass-approvals-and-sandbox"));
});

test("supports a configured Codex ACP command path", () => {
  assert.equal(resolveCodexAcpCommand({ CODEX_ACP_PATH: "D:/tools/custom-codex-acp.exe" }), "D:/tools/custom-codex-acp.exe");
  const command = buildCodexAcpCommand({ CODEX_ACP_PATH: "D:/tools/custom-codex-acp.exe" });
  assert.ok(command.file === "D:/tools/custom-codex-acp.exe" || command.args.at(-1) === "D:/tools/custom-codex-acp.exe");
});

test("maps Orbit approval modes to Codex ACP agent modes", () => {
  assert.deepEqual(codexAcpEnvForRun({ approvalMode: "ask" }), { INITIAL_AGENT_MODE: "agent" });
  assert.deepEqual(codexAcpEnvForRun({ approvalMode: "full-access" }), { INITIAL_AGENT_MODE: "agent-full-access" });
  assert.deepEqual(codexAcpEnvForRun({}), { INITIAL_AGENT_MODE: "agent" });
});

test("keeps Codex adapter warnings out of the final answer", async () => {
  const warning = {
    sessionUpdate: "agent_message_chunk" as const,
    content: { type: "text" as const, text: "Warning: WebSocket unavailable\n\n" },
  };
  assert.equal(isCodexDiagnosticMessage(warning), true);

  const activities: unknown[] = [];
  const fake = fakeConnector({
    onPrompt(notify) {
      notify({ sessionId: "codex-session", update: warning });
      notify({
        sessionId: "codex-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "answer-1",
          content: { type: "text", text: "clean answer" },
        },
      });
    },
  });
  const runtime = createCodexAcpRuntime(fake.connector);

  assert.equal(await runtime.run(runOptions({ onActivity: (activity: unknown) => activities.push(activity) })).result, "clean answer");
  // 诊断告警保持为状态活动；正常答案只在流式期间出现在过程区，
  // 结算时用空快照清除最终回复文本，避免完成态重复展示。
  assert.deepEqual(activities, [
    {
      type: "status",
      text: "Warning: WebSocket unavailable",
      timestamp: (activities[0] as { timestamp: string }).timestamp,
    },
    {
      type: "process.text",
      text: "clean answer",
      stream: "answer",
      answerGroup: "answer-1",
      timestamp: (activities[1] as { timestamp: string }).timestamp,
    },
    {
      type: "process.text",
      text: "",
      snapshot: true,
      excludedAnswerGroup: "answer-1",
      timestamp: (activities[2] as { timestamp: string }).timestamp,
    },
  ]);
});

test("uses Codex final-answer phase instead of commentary or thought chunks", async () => {
  const output: string[] = [];
  const activities: Array<{ type: string; text?: string; snapshot?: boolean }> = [];
  const fake = fakeConnector({
    onPrompt(notify) {
      notify({
        sessionId: "codex-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "commentary-1",
          content: { type: "text", text: "Inspecting the project." },
          _meta: { codex: { phase: "commentary" } },
        },
      });
      notify({
        sessionId: "codex-session",
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "hidden reasoning" },
        },
      });
      notify({
        sessionId: "codex-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "final-1",
          content: { type: "text", text: "Final " },
          _meta: { codex: { phase: "final_answer" } },
        },
      });
      notify({
        sessionId: "codex-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "final-1",
          content: { type: "text", text: "answer" },
        },
      });
      notify({
        sessionId: "codex-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "commentary-2",
          content: { type: "text", text: "Late commentary" },
          _meta: { codex: { phase: "commentary" } },
        },
      });
    },
  });
  const runtime = createCodexAcpRuntime(fake.connector);

  assert.equal(
    await runtime.run(runOptions({
      onOutput: (text: string) => output.push(text),
      onActivity: (activity: { type: string; text?: string; snapshot?: boolean }) => activities.push(activity),
    })).result,
    "Final answer",
  );
  assert.deepEqual(output, ["Inspecting the project.", "Final ", "answer", "Late commentary"]);

  const processText = activities.filter((activity) => activity.type === "process.text");
  assert.deepEqual(
    processText.map((activity) => ({ text: activity.text, snapshot: Boolean(activity.snapshot) })),
    [
      { text: "Inspecting the project.", snapshot: false },
      { text: "Final ", snapshot: false },
      { text: "answer", snapshot: false },
      { text: "Late commentary", snapshot: false },
      { text: "Inspecting the project.Late commentary", snapshot: true },
    ],
  );
});

test("keeps commentary before tool calls in the process timeline and settles the final answer group", async () => {
  // Issue #139 回归：commentary 文本 → 工具调用 → final_answer 文本 → 完成。
  const activities: Array<{ type: string; text?: string; stream?: string; answerGroup?: string; snapshot?: boolean; excludedAnswerGroup?: string }> = [];
  const fake = fakeConnector({
    onPrompt(notify) {
      notify({
        sessionId: "codex-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "commentary-1",
          content: { type: "text", text: "正在检查项目。" },
          _meta: { codex: { phase: "commentary" } },
        },
      });
      notify({
        sessionId: "codex-session",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tool-1",
          title: "Run tests",
          kind: "execute",
          status: "in_progress",
          rawInput: { command: "npm test" },
        },
      });
      notify({
        sessionId: "codex-session",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-1",
          status: "completed",
          rawOutput: "passed",
        },
      });
      notify({
        sessionId: "codex-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "final-1",
          content: { type: "text", text: "最终回复" },
          _meta: { codex: { phase: "final_answer" } },
        },
      });
    },
  });
  const runtime = createCodexAcpRuntime(fake.connector);
  const result = await runtime.run(runOptions({
    onActivity: (activity: { type: string; text?: string; stream?: string; answerGroup?: string; snapshot?: boolean; excludedAnswerGroup?: string }) => activities.push(activity),
  })).result;

  assert.equal(result, "最终回复");
  assert.deepEqual(activities.map((activity) => activity.type), [
    "process.text",
    "tool.started",
    "tool.completed",
    "process.text",
    "process.text",
  ]);
  // commentary 归入 progress 流；final_answer 分组成为最终回复。
  assert.deepEqual(
    activities
      .filter((activity) => activity.type === "process.text" && !activity.snapshot)
      .map((activity) => ({ text: activity.text, stream: activity.stream, answerGroup: activity.answerGroup })),
    [
      { text: "正在检查项目。", stream: "progress", answerGroup: "" },
      { text: "最终回复", stream: "answer", answerGroup: "final-1" },
    ],
  );
  const snapshot = activities.at(-1);
  assert.equal(snapshot?.snapshot, true);
  assert.equal(snapshot?.excludedAnswerGroup, "final-1");
  assert.equal(snapshot?.text, "正在检查项目。");
});

test("creates a Codex ACP session and returns streamed text", async () => {
  const fake = fakeConnector({
    onPrompt(notify) {
      notify({
        sessionId: "codex-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Codex answer" },
        },
      });
    },
  });
  const runtime = createCodexAcpRuntime(fake.connector);
  const handle = runtime.run(runOptions());

  assert.equal(runtime.kind, "codex");
  assert.equal(runtime.transport, "acp");
  assert.equal(await handle.result, "Codex answer");
  assert.equal(await handle.sessionId, "codex-session");
});

test("resumes an existing Codex ACP session", async () => {
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
  const runtime = createCodexAcpRuntime(fake.connector);

  assert.equal(await runtime.run(runOptions({ resumeSessionId: "existing-session" })).result, "resumed");
  assert.ok(fake.calls.some((call) => call.method === "session/resume"));
  assert.ok(!fake.calls.some((call) => call.method === "session/new"));
});

test("Codex ACP cancelled turns expose a typed cancellation error", async () => {
  const fake = fakeConnector({ promptResponse: { stopReason: "cancelled" } });
  const runtime = createCodexAcpRuntime(fake.connector);

  await assert.rejects(runtime.run(runOptions()).result, (error: unknown) => {
    assert.ok(error instanceof AgentRunCancelledError);
    assert.match(error.message, /Codex ACP turn was cancelled/);
    return true;
  });
});

test("per-run env reaches command resolution through the real spawn path", async () => {
  const commandPath = `D:/tools/orbit-missing-acp-${process.pid}-${Date.now()}.exe`;
  let receivedEnv: NodeJS.ProcessEnv | undefined;
  let resolvedCommand: { file: string; args: string[] } | undefined;
  const definition: AcpRuntimeDefinition = {
    kind: "codex",
    displayName: "Codex",
    buildCommand(env) {
      receivedEnv = env;
      resolvedCommand = buildCodexAcpCommand(env);
      return resolvedCommand;
    },
  };
  const runtime = createAcpRuntime(definition);
  const handle = runtime.run(runOptions({ env: { CODEX_ACP_PATH: commandPath } }));
  try {
    assert.equal(receivedEnv?.CODEX_ACP_PATH, commandPath);
    assert.ok(
      resolvedCommand?.file === commandPath || resolvedCommand?.args.at(-1) === commandPath,
    );
  } finally {
    await handle.result.catch(() => {});
  }
});
