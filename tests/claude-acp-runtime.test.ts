import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildClaudeAcpCommand,
  createClaudeAcpRuntime,
  resolveClaudeAcpCommand,
  type ClaudeAcpConnection,
  type ClaudeAcpConnector,
} from "../src/core/claude-acp-runtime.ts";
import { AgentRunCancelledError } from "../src/core/agent-runtime.ts";
import type { AgentActivityEvent } from "../src/shared/types.ts";

type FakeOptions = {
  capabilities?: Awaited<ReturnType<ClaudeAcpConnection["initialize"]>>["agentCapabilities"];
  onLoad?: (notify: Parameters<ClaudeAcpConnector>[1]) => void;
  onPrompt?: (notify: Parameters<ClaudeAcpConnector>[1]) => void;
  promptResponse?: Awaited<ReturnType<ClaudeAcpConnection["prompt"]>>;
};

function fakeConnector(options: FakeOptions = {}) {
  const calls: Array<{ method: string; value?: unknown }> = [];
  const connector: ClaudeAcpConnector = (_runOptions, notify) => ({
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
      return { sessionId: "claude-session" };
    },
    async loadSession(request) {
      calls.push({ method: "session/load", value: request });
      options.onLoad?.(notify);
      return {};
    },
    async resumeSession(request) {
      calls.push({ method: "session/resume", value: request });
      return {};
    },
    async prompt(request) {
      calls.push({ method: "session/prompt", value: request });
      options.onPrompt?.(notify);
      return options.promptResponse ?? { stopReason: "end_turn" };
    },
    async setConfigOption(request) {
      calls.push({ method: "session/set_config_option", value: request });
      return { configOptions: [] };
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
    agentId: "architect",
    cwd: "D:/workspace",
    prompt: "hello",
    ...overrides,
  };
}

test("starts Claude through the ACP adapter instead of --print stream-json", () => {
  const command = buildClaudeAcpCommand({});
  assert.ok(command.file.length > 0);
  assert.ok(command.args.some((arg) => arg.includes("claude-agent-acp")) || command.file.includes("claude-agent-acp"));
  assert.ok(!command.args.includes("--print"));
  assert.ok(!command.args.includes("stream-json"));
  assert.ok(!command.args.includes("bypassPermissions"));
});

test("supports a configured Claude ACP command path", () => {
  assert.equal(resolveClaudeAcpCommand({ CLAUDE_ACP_PATH: "D:/tools/custom-acp.exe" }), "D:/tools/custom-acp.exe");
  const command = buildClaudeAcpCommand({ CLAUDE_ACP_PATH: "D:/tools/custom-acp.exe" });
  assert.ok(command.file === "D:/tools/custom-acp.exe" || command.args.at(-1) === "D:/tools/custom-acp.exe");
});

test("creates a Claude ACP session and advertises elicitation", async () => {
  const activities: AgentActivityEvent[] = [];
  const fake = fakeConnector({
    onPrompt(notify) {
      notify({
        sessionId: "claude-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Claude answer" },
        },
      });
    },
  });
  const runtime = createClaudeAcpRuntime(fake.connector);
  const handle = runtime.run(runOptions({ onActivity: (activity: AgentActivityEvent) => activities.push(activity) }));

  assert.equal(runtime.kind, "claude-code");
  assert.equal(runtime.transport, "acp");
  assert.equal(await handle.result, "Claude answer");
  assert.equal(await handle.sessionId, "claude-session");
  const initialize = fake.calls.find((call) => call.method === "initialize")!.value as {
    clientCapabilities: { elicitation?: { form?: object; url?: object } };
  };
  assert.deepEqual(initialize.clientCapabilities.elicitation, { form: {}, url: {} });
  assert.deepEqual(
    activities.filter((activity) => activity.type === "process.text").map((activity) => (
      activity.type === "process.text" ? { text: activity.text, snapshot: Boolean(activity.snapshot) } : null
    )),
    [
      { text: "Claude answer", snapshot: false },
      { text: "", snapshot: true },
    ],
  );
});

test("keeps mid-turn answer text in the process timeline and settles the final group after tool calls", async () => {
  // Issue #139 回归：文本 → 工具调用 → 新文本。运行期间两段文本都按到达
  // 顺序进入过程时间线；结算快照显式标记最终分组（RunManager 内部消化，
  // 不转发前端），快照文本不含最终回复。
  const activities: AgentActivityEvent[] = [];
  const fake = fakeConnector({
    onPrompt(notify) {
      notify({
        sessionId: "claude-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "interim-1",
          content: { type: "text", text: "先检查一下。" },
        },
      });
      notify({
        sessionId: "claude-session",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tool-1",
          title: "Read file",
          kind: "read",
          status: "in_progress",
          rawInput: { path: "package.json" },
        },
      });
      notify({
        sessionId: "claude-session",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-1",
          status: "completed",
          rawOutput: "done",
        },
      });
      notify({
        sessionId: "claude-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "final-1",
          content: { type: "text", text: "最终回复" },
        },
      });
    },
  });
  const runtime = createClaudeAcpRuntime(fake.connector);
  const result = await runtime.run(runOptions({
    onActivity: (activity: AgentActivityEvent) => activities.push(activity),
  })).result;

  assert.equal(result, "最终回复");
  assert.deepEqual(activities.map((activity) => activity.type), [
    "process.text",
    "tool.started",
    "tool.completed",
    "process.text",
    "process.text",
  ]);
  // 不同 assistant messageId 形成前后两个 answer 分组；两组文本都不被隐藏。
  assert.deepEqual(
    activities
      .filter((activity) => activity.type === "process.text" && !activity.snapshot)
      .map((activity) => activity.type === "process.text"
        ? { text: activity.text, stream: activity.stream, answerGroup: activity.answerGroup }
        : null),
    [
      { text: "先检查一下。", stream: "answer", answerGroup: "interim-1" },
      { text: "最终回复", stream: "answer", answerGroup: "final-1" },
    ],
  );
  const snapshot = activities.at(-1);
  assert.ok(
    snapshot?.type === "process.text" && snapshot.snapshot === true && snapshot.excludedAnswerGroup === "final-1",
    "settlement snapshot must explicitly mark the final answer group",
  );
  assert.ok(
    snapshot?.type === "process.text" && snapshot.text === "先检查一下。" && !snapshot.text.includes("最终回复"),
    "snapshot text must exclude the final answer group",
  );
});

test("returns only Claude's last assistant message while preserving visible progress output", async () => {
  const output: string[] = [];
  const fake = fakeConnector({
    onPrompt(notify) {
      notify({
        sessionId: "claude-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "progress-1",
          content: { type: "text", text: "Reading the project first." },
        },
      });
      notify({
        sessionId: "claude-session",
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "hidden reasoning" },
        },
      });
      notify({
        sessionId: "claude-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "final-1",
          content: { type: "text", text: "Final " },
        },
      });
      notify({
        sessionId: "claude-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "final-1",
          content: { type: "text", text: "answer" },
        },
      });
    },
  });
  const runtime = createClaudeAcpRuntime(fake.connector);

  assert.equal(
    await runtime.run(runOptions({ onOutput: (text: string) => output.push(text) })).result,
    "Final answer",
  );
  assert.deepEqual(output, ["Reading the project first.", "Final ", "answer"]);
});

test("resumes an existing Claude ACP session without replaying loaded history", async () => {
  const fake = fakeConnector({
    capabilities: { sessionCapabilities: { resume: {} } },
    onPrompt(notify) {
      notify({
        sessionId: "existing-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "resumed answer" },
        },
      });
    },
  });
  const runtime = createClaudeAcpRuntime(fake.connector);

  assert.equal(
    await runtime.run(runOptions({ resumeSessionId: "existing-session" })).result,
    "resumed answer",
  );
  assert.ok(fake.calls.some((call) => call.method === "session/resume"));
  assert.ok(!fake.calls.some((call) => call.method === "session/new"));
});

test("sends attached images as native ACP content", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-claude-acp-image-"));
  const imagePath = path.join(tempDir, "sample.png");
  fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  try {
    const fake = fakeConnector({
      capabilities: { promptCapabilities: { image: true } },
      onPrompt(notify) {
        notify({
          sessionId: "claude-session",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "image received" },
          },
        });
      },
    });
    const runtime = createClaudeAcpRuntime(fake.connector);
    await runtime.run(runOptions({ imagePaths: [imagePath] })).result;

    const prompt = fake.calls.find((call) => call.method === "session/prompt")!.value as {
      prompt: Array<{ type: string; mimeType?: string; data?: string }>;
    };
    assert.equal(prompt.prompt[1]?.type, "image");
    assert.equal(prompt.prompt[1]?.mimeType, "image/png");
    assert.equal(prompt.prompt[1]?.data, Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Claude ACP cancelled turns expose a typed cancellation error", async () => {
  const fake = fakeConnector({ promptResponse: { stopReason: "cancelled" } });
  const runtime = createClaudeAcpRuntime(fake.connector);

  await assert.rejects(runtime.run(runOptions()).result, (error: unknown) => {
    assert.ok(error instanceof AgentRunCancelledError);
    assert.match(error.message, /Claude Code ACP turn was cancelled/);
    assert.equal(error.userMessage, "运行已取消。");
    return true;
  });
});
