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
  assert.deepEqual(activities, [{
    type: "status",
    text: "Warning: WebSocket unavailable",
    timestamp: (activities[0] as { timestamp: string }).timestamp,
  }]);
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
  // Regression guard: spawnAcpConnection must forward options.env to
  // definition.buildCommand, otherwise CODEX_ACP_PATH / CLAUDE_ACP_PATH passed
  // per run are ignored in favor of process.env. Uses the real default connector
  // (spawnAcpConnection) with a spy definition wrapping the real Codex resolver.
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
  // The custom path does not exist, so the spawned process fails fast. buildCommand
  // is invoked synchronously inside spawnAcpConnection before run() returns, so the
  // assertions below observe it directly. Awaiting the doomed result lets runAcp's
  // own finally clean up the connection without a manual kill.
  const handle = runtime.run(runOptions({ env: { CODEX_ACP_PATH: "D:/tools/custom-codex-acp.exe" } }));
  try {
    assert.equal(receivedEnv?.CODEX_ACP_PATH, "D:/tools/custom-codex-acp.exe");
    assert.ok(
      resolvedCommand?.file === "D:/tools/custom-codex-acp.exe" ||
        resolvedCommand?.args.at(-1) === "D:/tools/custom-codex-acp.exe",
    );
  } finally {
    await handle.result.catch(() => {});
  }
});
