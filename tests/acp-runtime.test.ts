import assert from "node:assert/strict";
import test from "node:test";

import type {
  AvailableCommand,
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
import type { AgentActivityEvent, AgentCommand, AgentModelStateSnapshot } from "../src/shared/types.ts";

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
  promptError?: Error;
  // issue #142：会话建立响应携带的 config options 与 set_config_option 行为。
  sessionConfigOptions?: Array<SessionConfigOption>;
  setConfigOptionError?: Error;
  setConfigOptionPending?: boolean;
  setConfigOptionConfigOptions?: Array<SessionConfigOption>;
  /** PR #147：initialize 返回的 Agent 能力（如 promptCapabilities.image）。 */
  capabilities?: AgentCapabilities;
  /** issue #160：让 newSession 挂起，模拟 session/new 响应前的创建窗口。 */
  hangNewSession?: boolean;
};

function fakeConnector(controls: FakeConnectionControls = {}) {
  const calls: string[] = [];
  const prompts: unknown[] = [];
  let spawnCount = 0;
  let notifySessionUpdate: ((notification: SessionNotification) => void) | null = null;
  let releaseNewSession: (() => void) | null = null;
  const newSessionGate = controls.hangNewSession
    ? new Promise<void>((resolve) => {
        releaseNewSession = resolve;
      })
    : null;
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
                ...(controls.capabilities ? { promptCapabilities: controls.capabilities.promptCapabilities } : {}),
              },
            });
      },
      async newSession() {
        calls.push(`session/new:${connectionSpawn}`);
        if (newSessionGate) {
          await newSessionGate;
        }
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
      prompt(request: { sessionId: string; prompt?: unknown }) {
        calls.push(`session/prompt:${request.sessionId}`);
        prompts.push(request.prompt);
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
          : controls.promptError
            ? Promise.reject(controls.promptError)
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
    prompts,
    get spawnCount() {
      return spawnCount;
    },
    emitSessionUpdate(update: SessionNotification["update"]) {
      notifySessionUpdate?.({ sessionId: "fake-session", update });
    },
    releaseNewSession() {
      releaseNewSession?.();
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

/** 构造 available_commands_update 帧的条目列表（含故意的畸形条目）。 */
function commandList(commands: AvailableCommand[]): AvailableCommand[] {
  return commands;
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

// ---- issue #160：ACP 原生斜杠命令通告 ----

test("delivers slash commands announced while the run is live", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const deliveries: AgentCommand[][] = [];
  const fake = fakeConnector({ hangPrompt: true });
  const handle = runAcp(
    runOptions({ onSessionCommands: (commands: AgentCommand[]) => deliveries.push([...commands]) }),
    definition,
    fake.connector,
  );
  await handle.sessionId;
  // sessionId 落定时 turn 还在 prompt 的 await 上，让出宏任务确保通告通路就绪。
  await new Promise<void>((resolve) => setImmediate(resolve));

  fake.emitSessionUpdate({
    sessionUpdate: "available_commands_update",
    availableCommands: commandList([
      { name: "init", description: "初始化项目" },
      { name: "review", description: "审查当前变更", input: { hint: "可选关注点" } },
    ]),
  });

  assert.deepEqual(deliveries, [
    [
      { name: "init", description: "初始化项目" },
      { name: "review", description: "审查当前变更", inputHint: "可选关注点" },
    ],
  ], "命令帧必须转换为 AgentCommand 列表并回调一次");

  handle.process.interrupt();
  t.mock.timers.tick(CANCEL_GRACE_MS);
  await assert.rejects(handle.result, AgentRunCancelledError);
});

test("slash command entries without a name or description are dropped", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const deliveries: AgentCommand[][] = [];
  const fake = fakeConnector({ hangPrompt: true });
  const handle = runAcp(
    runOptions({ onSessionCommands: (commands: AgentCommand[]) => deliveries.push([...commands]) }),
    definition,
    fake.connector,
  );
  await handle.sessionId;
  await new Promise<void>((resolve) => setImmediate(resolve));

  fake.emitSessionUpdate({
    sessionUpdate: "available_commands_update",
    availableCommands: commandList([
      { name: "", description: "无名命令" },
      { name: "review", description: "   " },
      { name: "compact", description: "压缩上下文", input: { hint: "   " } },
      { name: "plan", description: "生成计划", input: { hint: "聚焦测试" } },
    ]),
  });

  assert.deepEqual(deliveries, [[
    { name: "compact", description: "压缩上下文" },
    { name: "plan", description: "生成计划", inputHint: "聚焦测试" },
  ]], "空名称/空描述的条目必须丢弃，空白提示语不得成为 inputHint");

  handle.process.interrupt();
  t.mock.timers.tick(CANCEL_GRACE_MS);
  await assert.rejects(handle.result, AgentRunCancelledError);
});

test("an empty command list clears the snapshot through the callback", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const deliveries: AgentCommand[][] = [];
  const fake = fakeConnector({ hangPrompt: true });
  const handle = runAcp(
    runOptions({ onSessionCommands: (commands: AgentCommand[]) => deliveries.push([...commands]) }),
    definition,
    fake.connector,
  );
  await handle.sessionId;
  await new Promise<void>((resolve) => setImmediate(resolve));

  fake.emitSessionUpdate({ sessionUpdate: "available_commands_update", availableCommands: commandList([]) });

  assert.deepEqual(deliveries, [[]], "空通告也必须回调，让上层清空缓存的命令快照");

  handle.process.interrupt();
  t.mock.timers.tick(CANCEL_GRACE_MS);
  await assert.rejects(handle.result, AgentRunCancelledError);
});

test("slash commands announced in the session creation window are buffered and flushed once", async () => {
  const deliveries: AgentCommand[][] = [];
  const fake = fakeConnector({ hangNewSession: true, answerText: "hello" });
  const handle = runAcp(
    runOptions({ onSessionCommands: (commands: AgentCommand[]) => deliveries.push([...commands]) }),
    definition,
    fake.connector,
  );

  // 创建窗口：activeSessionId 尚未落定，命令帧先按 sessionId 缓冲。
  fake.emitSessionUpdate({
    sessionUpdate: "available_commands_update",
    availableCommands: commandList([{ name: "init", description: "初始化项目" }]),
  });
  assert.equal(deliveries.length, 0, "会话 id 未落定前不得提前回调");

  fake.releaseNewSession();
  await handle.sessionId;
  await handle.result;

  assert.deepEqual(deliveries, [[{ name: "init", description: "初始化项目" }]], "会话建立后缓冲的命令帧必须恰好投递一次");
  assert.ok(fake.calls.includes("session/prompt:fake-session"), "缓冲不得干扰正常流程");
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

// ---------------------------------------------------------------------------
// PR #147 M2/M3：附件内容块类型矩阵（image / resource_link）与 URI 编码。
// ---------------------------------------------------------------------------

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildPromptContent } from "../src/core/acp-runtime.ts";
import type { MessageAttachment } from "../src/shared/types.ts";
import type { AgentCapabilities } from "@agentclientprotocol/sdk";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makeAttachment(overrides: Partial<MessageAttachment> & Pick<MessageAttachment, "id" | "kind" | "path">): MessageAttachment {
  return {
    mimeType: "application/octet-stream",
    filename: `${overrides.id}.bin`,
    url: `/api/attachments/ws/conv/${overrides.id}`,
    size: 1024,
    createdAt: new Date().toISOString(),
    ...overrides,
  } as MessageAttachment;
}

test("no attachments yield a single text block", () => {
  const blocks = buildPromptContent("hello", undefined, undefined);
  assert.deepEqual(blocks, [{ type: "text", text: "hello" }]);
  assert.deepEqual(buildPromptContent("hello", [], undefined), [{ type: "text", text: "hello" }]);
});

test("image capability on: images become native image blocks, files stay resource_link", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-acp-matrix-"));
  try {
    const imagePath = path.join(tempDir, "photo.png");
    fs.writeFileSync(imagePath, PNG_BYTES);
    const capabilities = { promptCapabilities: { image: true } } as AgentCapabilities;
    const attachments = [
      makeAttachment({ id: "img-1", kind: "image", mimeType: "image/png", filename: "photo.png", path: imagePath, size: PNG_BYTES.length }),
      makeAttachment({ id: "pdf-1", kind: "file", mimeType: "application/pdf", filename: "spec.pdf", path: path.join(tempDir, "spec.pdf"), size: 4096 }),
      makeAttachment({ id: "txt-1", kind: "file", mimeType: "text/plain", filename: "notes.md", path: path.join(tempDir, "notes.md"), size: 256 }),
    ];

    const blocks = buildPromptContent("review these", attachments, capabilities);

    assert.equal(blocks.length, 4, "text + one block per attachment, in input order");
    assert.deepEqual(blocks[0], { type: "text", text: "review these" });
    assert.equal(blocks[1]!.type, "image");
    assert.equal((blocks[1] as { mimeType?: string }).mimeType, "image/png", "image MIME must come from the server-side attachment metadata");
    assert.equal((blocks[1] as { data?: string }).data, PNG_BYTES.toString("base64"), "image bytes must be read from the permanent attachment path");
    assert.match((blocks[1] as { uri?: string }).uri ?? "", /^file:\/\//, "image uri must be a file URL");
    assert.equal(blocks[2]!.type, "resource_link");
    assert.equal(blocks[3]!.type, "resource_link");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("image capability off: images degrade to resource_link instead of a text path dump", () => {
  const attachments = [
    makeAttachment({ id: "img-1", kind: "image", mimeType: "image/png", filename: "photo.png", path: "/data/photo.png", size: 2048 }),
  ];

  const noCapability = buildPromptContent("look", attachments, undefined);
  const capabilityOff = buildPromptContent("look", attachments, {} as AgentCapabilities);

  for (const blocks of [noCapability, capabilityOff]) {
    assert.equal(blocks.length, 2);
    assert.equal(blocks[1]!.type, "resource_link", "images must degrade to resource_link without the image capability");
  }
  const link = capabilityOff[1] as { uri: string; name: string; mimeType: string; size: number };
  assert.equal(link.name, "photo.png", "resource_link name comes from attachment metadata");
  assert.equal(link.mimeType, "image/png", "resource_link mimeType comes from attachment metadata");
  assert.equal(link.size, 2048, "resource_link size comes from attachment metadata");
});

test("image-only prompts omit an empty text block", () => {
  const blocks = buildPromptContent("", [
    makeAttachment({ id: "img-only", kind: "image", mimeType: "image/png", filename: "photo.png", path: process.execPath, size: 2048 }),
  ], { promptCapabilities: { image: true } } as AgentCapabilities);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!.type, "image");
});

test("image input rejection becomes an actionable model error", async () => {
  const fake = fakeConnector({ promptError: new Error("invalid request: image input is not supported by this model") });
  const handle = runAcp(runOptions({
    attachments: [makeAttachment({ id: "img-1", kind: "image", mimeType: "image/png", filename: "photo.png", path: "/data/photo.png", size: 2048 })],
  }), definition, fake.connector);
  await assert.rejects(handle.result, /原始报错：invalid request: image input is not supported by this model[\s\S]*建议：当前模型不支持图片输入/);
});

test("ACP refusal becomes an actionable model error", async () => {
  const fake = fakeConnector({ promptResponse: { stopReason: "refusal" } });
  const handle = runAcp(runOptions(), definition, fake.connector);
  await assert.rejects(handle.result, /ACP refused the request\.[\s\S]*建议：请切换到其他可用模型/);
});

test("provider capacity responses become actionable errors", async () => {
  const fake = fakeConnector({ answerText: "Selected model is at capacity." });
  const handle = runAcp(runOptions(), definition, fake.connector);
  await assert.rejects(handle.result, /原始报错：Selected model is at capacity\.[\s\S]*建议：当前模型容量已满/);
});

test("resource_link fields come exclusively from the validated attachment metadata", () => {
  const attachment = makeAttachment({
    id: "pdf-9",
    kind: "file",
    mimeType: "application/pdf",
    filename: "季度报告.pdf",
    path: "/data/quarterly.pdf",
    size: 40960,
  });

  const blocks = buildPromptContent("read it", [attachment], {} as AgentCapabilities);
  const link = blocks[1] as { uri: string; name: string; mimeType: string; size: number };
  const expectedUri = process.platform === "win32"
    ? "file:///D:/data/quarterly.pdf"
    : "file:///data/quarterly.pdf";
  assert.equal(link.uri, expectedUri);
  assert.equal(link.name, "季度报告.pdf");
  assert.equal(link.mimeType, "application/pdf");
  assert.equal(link.size, 40960);
});

test("file URIs percent-encode spaces, non-ASCII characters and fragments", () => {
  const attachment = makeAttachment({
    id: "win-1",
    kind: "file",
    mimeType: "application/pdf",
    filename: "spec #1.pdf",
    path: process.platform === "win32"
      ? "C:\\Users\\张 三\\spec #1.pdf"
      : "/tmp/张 三/spec #1.pdf",
    size: 100,
  });

  const blocks = buildPromptContent("open", [attachment], {} as AgentCapabilities);
  const link = blocks[1] as { uri: string };
  // pathToFileURL 处理驱动器盘符、斜杠方向与百分号编码：空格 %20、
  // 中文按 UTF-8 百分号编码、`#` 编码为 %23（否则会被当作 fragment 截断）。
  const expected = process.platform === "win32"
    ? "file:///C:/Users/%E5%BC%A0%20%E4%B8%89/spec%20%231.pdf"
    : "file:///tmp/%E5%BC%A0%20%E4%B8%89/spec%20%231.pdf";
  assert.equal(link.uri, expected);
  assert.ok(!link.uri.includes(" "), "URI must not contain raw spaces");
  assert.ok(!link.uri.includes("#"), "URI must not contain a raw fragment marker");
});

test("runAcp forwards the attachment list into the session prompt", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-acp-prompt-"));
  try {
    const imagePath = path.join(tempDir, "chart.png");
    fs.writeFileSync(imagePath, PNG_BYTES);
    const attachments = [
      makeAttachment({ id: "img-1", kind: "image", mimeType: "image/png", filename: "chart.png", path: imagePath, size: PNG_BYTES.length }),
    ];
    const fake = fakeConnector({
      capabilities: { promptCapabilities: { image: true } } as AgentCapabilities,
      answerText: "ok",
    });
    const handle = runAcp(runOptions({ attachments }), definition, fake.connector);
    await handle.result;

    const blocks = fake.prompts[0] as Array<{ type: string; mimeType?: string }>;
    assert.ok(blocks, "prompt request must have been issued");
    assert.equal(blocks[0]!.type, "text");
    assert.equal(blocks[1]!.type, "image", "attachment must reach session/prompt as a native image block");
    assert.equal(blocks[1]!.mimeType, "image/png");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
