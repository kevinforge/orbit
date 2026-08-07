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
  const handle = runtime.run(runOptions());

  assert.equal(runtime.kind, "claude-code");
  assert.equal(runtime.transport, "acp");
  assert.equal(await handle.result, "Claude answer");
  assert.equal(await handle.sessionId, "claude-session");
  const initialize = fake.calls.find((call) => call.method === "initialize")!.value as {
    clientCapabilities: { elicitation?: { form?: object; url?: object } };
  };
  assert.deepEqual(initialize.clientCapabilities.elicitation, { form: {}, url: {} });
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
