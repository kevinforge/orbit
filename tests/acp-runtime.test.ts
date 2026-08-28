import assert from "node:assert/strict";
import test from "node:test";

import type {
  InitializeResponse,
  PromptResponse,
  SessionConfigOption,
  SessionConfigSelectOptions,
  SessionNotification,
  SetSessionConfigOptionResponse,
} from "@agentclientprotocol/sdk";

import {
  CANCEL_GRACE_MS,
  probeAcpModelState,
  runAcp,
  spawnAcpConnection,
  type AcpConnection,
  type AcpConnector,
  type AcpRuntimeDefinition,
} from "../src/core/acp-runtime.ts";
import { AgentRunCancelledError } from "../src/core/agent-runtime.ts";
import type { AgentActivityEvent, AgentModelStateSnapshot } from "../src/shared/types.ts";

// Issue #136：公共 ACP 取消生命周期。优雅取消走 session/cancel；runtime 无视
// 取消且 prompt 永不结算时，宽限期后强制销毁连接并收口结果。超时用假定时器
// 模拟，测试不真实等待 CANCEL_GRACE_MS。
const definition: AcpRuntimeDefinition = {
  kind: "codebuddy",
  displayName: "Fake Agent",
  buildCommand: () => ({ file: "fake-acp", args: [] }),
};

type FakeConnectionControls = {
  hangInitialize?: boolean;
  hangPrompt?: boolean;
  promptResponse?: PromptResponse;
  cancelError?: Error;
  resumeCapability?: boolean;
  resumeError?: Error;
  secondResumeError?: Error;
  answerText?: string;
  // issue #142：会话建立响应携带的 config options 与 set_config_option 行为。
  sessionConfigOptions?: Array<SessionConfigOption>;
  setConfigOptionError?: Error;
  setConfigOptionPending?: boolean;
  setConfigOptionConfigOptions?: Array<SessionConfigOption>;
};

function fakeConnector(controls: FakeConnectionControls = {}) {
  const calls: string[] = [];
  let spawnCount = 0;
  let notifySessionUpdate: ((notification: SessionNotification) => void) | null = null;
  const connector: AcpConnector = (_options, notify) => {
    spawnCount += 1;
    calls.push(`spawn:${spawnCount}`);
    const connectionSpawn = spawnCount;
    notifySessionUpdate = notify;
    const connection: AcpConnection = {
      pid: 4242,
      initialize() {
        calls.push("initialize");
        return controls.hangInitialize
          ? new Promise<InitializeResponse>(() => {})
          : Promise.resolve({
              protocolVersion: 1,
              agentCapabilities: {
                loadSession: true,
                ...(controls.resumeCapability ? { sessionCapabilities: { resume: {} } } : {}),
              },
            });
      },
      async newSession() {
        calls.push(`session/new:${connectionSpawn}`);
        return {
          sessionId: connectionSpawn === 1 ? "fake-session" : `fake-session-${connectionSpawn}`,
          ...(controls.sessionConfigOptions ? { configOptions: controls.sessionConfigOptions } : {}),
        };
      },
      async loadSession(request) {
        calls.push(`session/load:${request.sessionId}`);
        return controls.sessionConfigOptions ? { configOptions: controls.sessionConfigOptions } : {};
      },
      async resumeSession(request) {
        calls.push(`session/resume:${connectionSpawn}:${request.sessionId}`);
        const error = connectionSpawn === 1 ? controls.resumeError : controls.secondResumeError;
        if (error) throw error;
        return controls.sessionConfigOptions ? { configOptions: controls.sessionConfigOptions } : {};
      },
      hasSession(sessionId: string) {
        return sessionId === "resumed-session";
      },
      async setConfigOption(request) {
        calls.push(`session/set_config_option:${request.sessionId}:${request.configId}:${request.value}`);
        if (controls.setConfigOptionError) throw controls.setConfigOptionError;
        if (controls.setConfigOptionPending) return new Promise<SetSessionConfigOptionResponse>(() => {});
        const configOptions = controls.setConfigOptionConfigOptions ?? controls.sessionConfigOptions ?? [];
        return { configOptions } satisfies SetSessionConfigOptionResponse;
      },
      prompt(request: { sessionId: string }) {
        calls.push(`session/prompt:${request.sessionId}`);
        if (controls.answerText !== undefined) {
          notifySessionUpdate?.({
            sessionId: request.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: controls.answerText },
            },
          });
        }
        return controls.hangPrompt
          ? new Promise<PromptResponse>(() => {})
          : Promise.resolve(controls.promptResponse ?? { stopReason: "end_turn" });
      },
      cancel(sessionId: string) {
        calls.push(`session/cancel:${sessionId}`);
        return controls.cancelError ? Promise.reject(controls.cancelError) : Promise.resolve();
      },
      close() {
        calls.push(`close:${connectionSpawn}`);
      },
      destroy() {
        calls.push(`destroy:${connectionSpawn}`);
      },
    };
    return connection;
  };
  return {
    connector,
    calls,
    get spawnCount() {
      return spawnCount;
    },
    emitSessionUpdate(update: SessionNotification["update"]) {
      notifySessionUpdate?.({ sessionId: "fake-session", update });
    },
  };
}

function runOptions(overrides: Record<string, unknown> = {}) {
  return {
    agentId: "developer",
    cwd: "D:/workspace",
    prompt: "hello",
    ...overrides,
  };
}

test("graceful cancel settles the turn through session/cancel", async () => {
  const fake = fakeConnector({ promptResponse: { stopReason: "cancelled" } });
  const handle = runAcp(runOptions(), definition, fake.connector);
  await handle.sessionId;

  handle.process.interrupt();

  await assert.rejects(handle.result, (error: unknown) => {
    assert.ok(error instanceof AgentRunCancelledError);
    assert.equal(error.userMessage, "运行已取消。");
    return true;
  });
  assert.ok(fake.calls.includes("session/cancel:fake-session"), "interrupt 必须先发 session/cancel");
  assert.equal(await handle.sessionId, "fake-session");
});

test("does not prompt when cancellation arrives while applying the preferred model", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fake = fakeConnector({
    setConfigOptionPending: true,
    sessionConfigOptions: [modelOption({ currentValue: "model-a" })],
  });
  const handle = runAcp(
    runOptions({ preferredModelId: "model-b" }),
    definition,
    fake.connector,
  );
  await handle.sessionId;

  handle.process.interrupt();
  t.mock.timers.tick(CANCEL_GRACE_MS);
  await assert.rejects(handle.result, AgentRunCancelledError);
  assert.ok(fake.calls.some((call) => call.startsWith("session/set_config_option:")));
  assert.equal(fake.calls.some((call) => call.startsWith("session/prompt:")), false);
});

test("force-cancels an unresponsive prompt after the cancel grace period", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const output: string[] = [];
  const fake = fakeConnector({ hangPrompt: true });
  const handle = runAcp(
    runOptions({ onOutput: (text: string) => output.push(text) }),
    definition,
    fake.connector,
  );
  await handle.sessionId;

  handle.process.interrupt();
  assert.ok(fake.calls.includes("session/cancel:fake-session"));
  assert.ok(!fake.calls.some((call) => call.startsWith("destroy:")), "宽限期内不得强制销毁连接");

  t.mock.timers.tick(CANCEL_GRACE_MS);

  await assert.rejects(handle.result, (error: unknown) => {
    assert.ok(error instanceof AgentRunCancelledError);
    assert.match(error.message, /force-cancelled/);
    assert.equal(error.userMessage, "运行已取消。");
    return true;
  });
  assert.ok(fake.calls.some((call) => call.startsWith("destroy:")), "宽限期超时后必须强制销毁连接");
  assert.equal(output.length, 1, "强制收口只输出一次诊断");
  assert.match(output[0]!, /已强制终止进程/);
});

test("forced cancel still settles sessionId so error paths never hang", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fake = fakeConnector({ hangPrompt: true });
  const handle = runAcp(runOptions(), definition, fake.connector);
  await handle.sessionId;

  handle.process.interrupt();
  t.mock.timers.tick(CANCEL_GRACE_MS);

  await assert.rejects(handle.result, AgentRunCancelledError);
  assert.equal(await handle.sessionId, "fake-session", "AgentSession 的异常路径依赖 sessionId 落定");
});

test("session updates arriving after a forced cancel are ignored", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const activities: AgentActivityEvent[] = [];
  const fake = fakeConnector({ hangPrompt: true });
  const handle = runAcp(
    runOptions({ onActivity: (activity: AgentActivityEvent) => activities.push(activity) }),
    definition,
    fake.connector,
  );
  await handle.sessionId;

  handle.process.interrupt();
  t.mock.timers.tick(CANCEL_GRACE_MS);
  await assert.rejects(handle.result, AgentRunCancelledError);

  fake.emitSessionUpdate({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "晚到文本" },
  });
  assert.deepEqual(activities, [], "强制收口后的会话更新不得进入活动流");
});

test("a failing session/cancel request force-cancels immediately", async () => {
  const fake = fakeConnector({ hangPrompt: true, cancelError: new Error("cancel not supported") });
  const handle = runAcp(runOptions(), definition, fake.connector);
  await handle.sessionId;
  // 确保取消发生在 prompt 已经挂起之后，避免把“尚未开始 prompt 的取消”
  // 与“取消请求失败后的强制收口”混在同一个断言里。
  await new Promise<void>((resolve) => setImmediate(resolve));

  handle.process.interrupt();

  await assert.rejects(handle.result, (error: unknown) => {
    assert.ok(error instanceof AgentRunCancelledError);
    assert.match(error.message, /force-cancelled/);
    return true;
  });
  assert.ok(fake.calls.some((call) => call.startsWith("destroy:")), "取消请求失败必须立即强制销毁连接");
});

test("interrupt before the session is established force-cancels the turn", async () => {
  const fake = fakeConnector({ hangInitialize: true });
  const handle = runAcp(runOptions(), definition, fake.connector);

  handle.process.interrupt();

  await assert.rejects(handle.result, (error: unknown) => {
    assert.ok(error instanceof AgentRunCancelledError);
    return true;
  });
  assert.ok(fake.calls.some((call) => call.startsWith("destroy:")));
  assert.equal(await handle.sessionId, null, "未建立会话时 sessionId 以 null 落定");
});

test("repeated interrupt requests stay idempotent", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fake = fakeConnector({ hangPrompt: true });
  const handle = runAcp(runOptions(), definition, fake.connector);
  await handle.sessionId;

  handle.process.interrupt();
  handle.process.interrupt();
  t.mock.timers.tick(CANCEL_GRACE_MS);
  handle.process.interrupt();

  await assert.rejects(handle.result, AgentRunCancelledError);
  assert.equal(fake.calls.filter((call) => call === "session/cancel:fake-session").length, 1);
  assert.equal(fake.calls.filter((call) => call.startsWith("destroy:")).length, 1);
});

test("stdout EOF rejects pending ACP requests and marks the connection dead", { timeout: 20_000, skip: process.platform === "win32" }, async () => {
  // Issue #141：runtime 进程活着但提前关闭 stdout 时，pending 请求原先会
  // 永久挂起；现在 transport closed 必须显式拒绝，且连接不可再复用。
  // Windows 上 Node 的同步 stdout 无法从进程内真正关闭管道（end()、
  // destroy()、closeSync(1) 实测都不触发父进程 EOF），本用例只在 POSIX
  // 运行；CI（ubuntu）负责覆盖，Windows 由下一个 exit 用例验证诊断格式。
  const script = "require('node:fs').closeSync(1); setInterval(() => {}, 1000);";
  const probeDefinition: AcpRuntimeDefinition = {
    kind: "codebuddy",
    displayName: "Transport Probe",
    buildCommand: () => ({ file: process.execPath, args: ["-e", script] }),
  };
  const connection = spawnAcpConnection(probeDefinition, runOptions({ cwd: process.cwd() }), () => {});
  try {
    // SDK 在流关闭时可能抢先以裸 "ACP connection closed" 拒绝 pending 请求，
    // 与本模块的 transport-closed 兜底存在赛跑；这里断言稳定不变量：请求
    // 必须被拒绝（不再挂死），且连接随后不可复用。
    await assert.rejects(
      connection.initialize({ protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "Orbit", version: "test" } }),
    );
    assert.equal(connection.isAlive(), false, "stdout EOF 后连接必须视为不可复用");
  } finally {
    connection.destroy?.();
  }
});

test("an unrecoverable resume failure falls back to a fresh session", async () => {
  // Issue #141：thread-store conflict / active writer 表明原会话状态已不可
  // 用，必须在同一条连接上直接新建会话，sessionId 落定新值并输出过程提示。
  const output: string[] = [];
  const fake = fakeConnector({
    resumeCapability: true,
    answerText: "答复文本",
    resumeError: new Error("Fake Agent ACP request failed (pid 1): thread-store conflict: thread already has an active writer"),
  });
  const handle = runAcp(
    runOptions({
      resumeSessionId: "old-session",
      onOutput: (text: string) => output.push(text),
    }),
    definition,
    fake.connector,
  );

  const answer = await handle.result;
  assert.equal(answer, "答复文本");
  assert.equal(await handle.sessionId, "fake-session", "降级后 sessionId 必须落定新会话的 id");
  assert.ok(fake.calls.includes("session/resume:1:old-session"), "恢复失败前必须先尝试 resume");
  assert.ok(fake.calls.includes("session/new:1"), "不可恢复失败必须新建会话");
  assert.ok(fake.calls.includes("session/prompt:fake-session"), "新建会话后 prompt 必须使用新 id");
  assert.equal(fake.spawnCount, 1, "不可恢复降级不换连接");
  assert.ok(output.some((text) => text.includes("已使用新的会话继续")), `expected downgrade notice in: ${output.join(" | ")}`);
  assert.ok(output.some((text) => text.includes("thread-store conflict")), `expected failure summary in: ${output.join(" | ")}`);
});

test("a recoverable resume failure retries the same session id on a fresh connection", async () => {
  // Issue #141：传输断开/超时/进程退出只会让连接失效，会话本身仍有效——
  // 销毁当前 lease，用新连接和同一个 sessionId 重试一次。
  const output: string[] = [];
  const fake = fakeConnector({
    resumeCapability: true,
    answerText: "答复文本",
    resumeError: new Error("Fake Agent ACP transport closed (stdout ended while pid 1 was still running)."),
  });
  const handle = runAcp(
    runOptions({
      resumeSessionId: "old-session",
      onOutput: (text: string) => output.push(text),
    }),
    definition,
    fake.connector,
  );

  const answer = await handle.result;
  assert.equal(answer, "答复文本");
  assert.equal(await handle.sessionId, "old-session", "可恢复重试必须保留原 sessionId");
  assert.equal(fake.spawnCount, 2, "重试必须销毁旧连接并另起新连接");
  assert.ok(fake.calls.includes("destroy:1"), "旧 lease 必须先销毁");
  assert.ok(fake.calls.includes("session/resume:2:old-session"), "重试必须在新连接上用同一个 sessionId resume");
  assert.ok(fake.calls.includes("session/prompt:old-session"));
  assert.ok(output.some((text) => text.includes("已在新连接上恢复原会话")), `expected retry notice in: ${output.join(" | ")}`);
});

test("a retry that fails again settles as a normal error", async () => {
  const fake = fakeConnector({
    resumeCapability: true,
    resumeError: new Error("Fake Agent ACP transport closed (stdout ended while pid 1 was still running)."),
    secondResumeError: new Error("Fake Agent ACP transport closed (stdout ended while pid 2 was still running)."),
  });
  const handle = runAcp(
    runOptions({ resumeSessionId: "old-session" }),
    definition,
    fake.connector,
  );

  await assert.rejects(handle.result, (error: unknown) => {
    assert.match((error as Error).message, /transport closed/);
    return true;
  });
  assert.equal(fake.spawnCount, 2, "只允许重试一次");
  assert.ok(!fake.calls.some((call) => call.startsWith("session/new:")), "重试失败不得静默降级新建");
});

test("an unclassified resume failure settles as a normal error without fallback", async () => {
  const fake = fakeConnector({
    resumeCapability: true,
    resumeError: new Error("mystery failure"),
  });
  const handle = runAcp(
    runOptions({ resumeSessionId: "old-session" }),
    definition,
    fake.connector,
  );

  await assert.rejects(handle.result, /mystery failure/);
  assert.equal(fake.spawnCount, 1, "识别不了的错误不得换连接或降级");
  assert.ok(!fake.calls.some((call) => call.startsWith("session/new:")));
});

test("an unexpected process exit rejects pending requests with pid diagnostics", { timeout: 20_000 }, async () => {
  // Issue #141：失败诊断必须带 runtime displayName、pid 与退出码，便于区分
  // transport 断开与进程崩溃。
  const script = "process.exit(7);";
  const probeDefinition: AcpRuntimeDefinition = {
    kind: "codebuddy",
    displayName: "Exit Probe",
    buildCommand: () => ({ file: process.execPath, args: ["-e", script] }),
  };
  const connection = spawnAcpConnection(probeDefinition, runOptions({ cwd: process.cwd() }), () => {});
  try {
    await assert.rejects(
      connection.initialize({ protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "Orbit", version: "test" } }),
      (error: unknown) => {
        // exit 监听与 SDK 的裸拒绝赛跑，但连接已死时 request 会统一补上
        // runtime 前缀与 pid，两种消息都必须可定位到具体进程。
        assert.match((error as Error).message, /Exit Probe ACP .+pid \d+/, `unexpected message: ${(error as Error).message}`);
        return true;
      },
    );
    assert.equal(connection.isAlive(), false);
  } finally {
    connection.destroy?.();
  }
});

// ---- issue #142：员工首选模型的惰性应用 ----

function modelOption(overrides: {
  currentValue?: string;
  options?: SessionConfigSelectOptions;
} = {}): SessionConfigOption {
  return {
    id: "model",
    name: "Model",
    type: "select",
    category: "model",
    currentValue: overrides.currentValue ?? "model-a",
    options: overrides.options ?? [
      { value: "model-a", name: "模型 A" },
      { value: "model-b", name: "模型 B" },
    ],
  };
}

test("probes model options without prompting and destroys the temporary connection", async () => {
  const fake = fakeConnector({
    sessionConfigOptions: [modelOption({ currentValue: "model-a" })],
  });
  const snapshot = await probeAcpModelState(
    definition,
    { agentId: "developer", cwd: "D:/workspace" },
    fake.connector,
  );

  assert.deepEqual(snapshot?.choices, [
    { value: "model-a", name: "模型 A" },
    { value: "model-b", name: "模型 B" },
  ]);
  assert.equal(snapshot?.currentValue, undefined, "临时探测会话不得伪造员工当前模型");
  assert.equal(snapshot?.currentValueSource, "probe");
  assert.equal(fake.calls.some((call) => call.startsWith("session/prompt:")), false);
  assert.ok(fake.calls.some((call) => call.startsWith("destroy:")));
});

test("applies the preferred model after the session is established", async () => {
  const fake = fakeConnector({
    answerText: "hello",
    sessionConfigOptions: [modelOption()],
    setConfigOptionConfigOptions: [modelOption({ currentValue: "model-b" })],
  });
  const notices: string[] = [];
  const snapshots: AgentModelStateSnapshot[] = [];
  const handle = runAcp(
    runOptions({
      preferredModelId: "model-b",
      onActivity: (activity: AgentActivityEvent) => { if (activity.type === "process.text") notices.push(activity.text); },
      onSessionConfig: (snapshot: AgentModelStateSnapshot) => snapshots.push(snapshot),
    }),
    definition,
    fake.connector,
  );
  await handle.result;

  assert.ok(
    fake.calls.includes("session/set_config_option:fake-session:model:model-b"),
    `set_config_option must be issued before the prompt, got: ${fake.calls.join(", ")}`,
  );
  assert.ok(fake.calls.indexOf("session/set_config_option:fake-session:model:model-b") < fake.calls.indexOf("session/prompt:fake-session"));
  assert.ok(notices.some((text) => text.includes("模型已切换为 模型 B")), "切换提示走过程叙述流对用户可见");
  assert.equal(snapshots.length, 2, "建立时与切换后各回调一次快照");
  assert.equal(snapshots[0]!.currentValue, "model-a");
  assert.equal(snapshots[0]!.currentValueSource, "session");
  assert.equal(snapshots[1]!.currentValue, "model-b");
  assert.equal(snapshots[1]!.currentValueSource, "session");
  assert.deepEqual(snapshots[0]!.choices, [
    { value: "model-a", name: "模型 A" },
    { value: "model-b", name: "模型 B" },
  ]);
});

test("keeps the current model when the preferred value is unavailable", async () => {
  const fake = fakeConnector({ answerText: "hello", sessionConfigOptions: [modelOption()] });
  const notices: string[] = [];
  const handle = runAcp(
    runOptions({
      preferredModelId: "missing-model",
      onActivity: (activity: AgentActivityEvent) => { if (activity.type === "process.text") notices.push(activity.text); },
    }),
    definition,
    fake.connector,
  );
  const answer = await handle.result;

  assert.equal(answer, "hello");
  assert.ok(!fake.calls.some((call) => call.startsWith("session/set_config_option:")));
  assert.ok(notices.some((text) => text.includes("首选模型 missing-model 当前不可用")));
  assert.ok(notices.some((text) => text.includes("继续使用 模型 A")));
});

test("a failed model switch only warns and never fails the run", async () => {
  const fake = fakeConnector({
    answerText: "hello",
    sessionConfigOptions: [modelOption()],
    setConfigOptionError: new Error("model backend offline"),
  });
  const notices: string[] = [];
  const handle = runAcp(
    runOptions({
      preferredModelId: "model-b",
      onActivity: (activity: AgentActivityEvent) => { if (activity.type === "process.text") notices.push(activity.text); },
    }),
    definition,
    fake.connector,
  );
  const answer = await handle.result;

  assert.equal(answer, "hello");
  assert.ok(notices.some((text) => text.includes("模型切换失败") && text.includes("model backend offline")));
});

test("snapshots model choices without switching when no preference is set", async () => {
  const fake = fakeConnector({ answerText: "hello", sessionConfigOptions: [modelOption()] });
  const snapshots: AgentModelStateSnapshot[] = [];
  const handle = runAcp(
    runOptions({ onSessionConfig: (snapshot: AgentModelStateSnapshot) => snapshots.push(snapshot) }),
    definition,
    fake.connector,
  );
  await handle.result;

  assert.ok(!fake.calls.some((call) => call.startsWith("session/set_config_option:")));
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]!.agentId, "developer");
  assert.equal(snapshots[0]!.runtimeKind, "codebuddy");
  assert.equal(snapshots[0]!.configId, "model");
});

test("re-applies the preference on pooled-connection reuse via the last snapshot", async () => {
  // 池复用捷径：hasSession 命中时不发任何会话 RPC，也没有新快照；必须用
  // 上一次运行的快照补发一次幂等 set_config_option。
  const fake = fakeConnector({
    answerText: "hello",
    setConfigOptionConfigOptions: [modelOption({ currentValue: "model-b" })],
  });
  const last: AgentModelStateSnapshot = {
    agentId: "developer",
    runtimeKind: "codebuddy",
    configId: "model",
    choices: [
      { value: "model-a", name: "模型 A" },
      { value: "model-b", name: "模型 B" },
    ],
    currentValue: "model-a",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const snapshots: AgentModelStateSnapshot[] = [];
  const handle = runAcp(
    runOptions({
      resumeSessionId: "resumed-session",
      preferredModelId: "model-b",
      lastSessionConfig: last,
      onSessionConfig: (snapshot: AgentModelStateSnapshot) => snapshots.push(snapshot),
    }),
    definition,
    fake.connector,
  );
  await handle.result;

  assert.ok(
    fake.calls.includes("session/set_config_option:resumed-session:model:model-b"),
    `pooled reuse must still issue set_config_option, got: ${fake.calls.join(", ")}`,
  );
  assert.ok(!fake.calls.some((call) => call.startsWith("session/resume:")), "hasSession 命中时不得重发 resume");
  assert.equal(snapshots.at(-1)?.currentValue, "model-b");
});

test("skips model handling entirely without config options or a usable snapshot", async () => {
  const fake = fakeConnector({ answerText: "hello" });
  const handle = runAcp(
    runOptions({ resumeSessionId: "resumed-session", preferredModelId: "model-b" }),
    definition,
    fake.connector,
  );
  await handle.result;

  assert.ok(!fake.calls.some((call) => call.startsWith("session/set_config_option:")));
});

test("flattens grouped select options into model choices", async () => {
  const fake = fakeConnector({
    answerText: "hello",
    sessionConfigOptions: [
      modelOption({
        options: [
          {
            group: "premium",
            name: "高级",
            options: [{ value: "model-b", name: "模型 B" }],
          },
        ],
      }),
    ],
  });
  const snapshots: AgentModelStateSnapshot[] = [];
  const handle = runAcp(
    runOptions({ onSessionConfig: (snapshot: AgentModelStateSnapshot) => snapshots.push(snapshot) }),
    definition,
    fake.connector,
  );
  await handle.result;

  assert.deepEqual(snapshots[0]!.choices, [{ value: "model-b", name: "模型 B" }]);
});

test("refreshes the snapshot on config_option_update notifications", async (t) => {
  // CodeBuddy 会在运行中主动推送配置变化（Phase 0 实测），通知必须刷新快照。
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fake = fakeConnector({ hangPrompt: true });
  const snapshots: AgentModelStateSnapshot[] = [];
  const handle = runAcp(
    runOptions({ onSessionConfig: (snapshot: AgentModelStateSnapshot) => snapshots.push(snapshot) }),
    definition,
    fake.connector,
  );
  await handle.sessionId;
  // sessionId 落定时 turn 还在 applyPreferredModel 的 await 上，让出宏任务
  // 确保 acceptingUpdates 已置位再发通知。
  await new Promise<void>((resolve) => setImmediate(resolve));

  fake.emitSessionUpdate({
    sessionUpdate: "config_option_update",
    configOptions: [modelOption({ currentValue: "model-b" })],
  });
  assert.equal(snapshots.at(-1)?.currentValue, "model-b");

  handle.process.interrupt();
  t.mock.timers.tick(CANCEL_GRACE_MS);
  await assert.rejects(handle.result, AgentRunCancelledError);
});
